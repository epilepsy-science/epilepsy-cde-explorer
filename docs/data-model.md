# Data model

This document describes the on-disk data shipped with the dashboard, how each
contributing source represents itself, and how the runtime stitches them
together into a single queryable model.

The dashboard's data layer has three tiers:

1. **Source records** — each upstream provider (NINDS, NLM CDE Repository,
   NT-PRECEDS demo set, PTE Clinical curation) is normalized into a
   Pennsieve-format export under `data/<source>/`. The export is the
   authoritative source of truth for that provider; all dashboard behavior
   that depends on a record traces back here.
2. **Parquet snapshots** — `scripts/prepare-data.mjs` reads each source's
   JSONL records and emits per-source Parquet files into
   `public/data/<source>/`, plus globally-derived files at the data root.
   These are what the browser fetches.
3. **DuckDB views** — `src/composables/useDuckDB.ts` registers the parquets
   in DuckDB-WASM and builds reconciled views (`cde`, `cde_full`, `concept`,
   `cde_represents_concept`, …) the rest of the app queries.

Sources never share IDs or coordinate identifiers; the integration logic
reconciles them on a *canonical key* derived from semantically meaningful
upstream identifiers (NLM tinyId, caDSR DEC, normalized CDE name).

## Source directory layout

Every source directory follows the same shape:

```
data/<source>/
  manifest.json
  metadata/
    relationships.csv
    models/
      cde/versions/1/{records.jsonl, schema.json}
      cde_classification/versions/1/{records.jsonl, schema.json}
      bundle/versions/1/{records.jsonl, schema.json}        (optional)
      crf/versions/1/{records.jsonl, schema.json}           (optional)
      provenance/versions/1/{records.jsonl, schema.json}
```

`records.jsonl` is newline-delimited JSON. Each line has the shape

```json
{ "id": "<UUID>", "data": { ...domain fields... } }
```

`id` is a deterministic UUIDv5-shaped string derived from a stable upstream
key (e.g. `cde:C02011`) so re-running the extractor produces the same record
IDs. Source-record IDs are never used for cross-source joins — see
*Reconciliation* below — but are used internally within a source for
relationships.

The source's own `manifest.json` is informational; the dashboard's runtime
manifest is `public/data/manifest.json`, written by `prepare-data.mjs`.

## The five models

### `cde` — Common Data Elements

One row per CDE as the source defines it. Sources don't agree on identity:
NLM uses a 8-char tinyId, NINDS uses a CDE Catalog ID like `C02011`, demo
data uses a slugified name. The `cde` model carries source-attributed
identifiers as separate columns and lets the reconciler decide which row is
canonical.

| Field | Notes |
| --- | --- |
| `cde_name` | Human-readable name (the source's "preferred" designation). Sources sometimes disagree; first-source wins on canonical reconciliation. |
| `aliases` | Pipe-joined alternate designations (NLM ships several per CDE; NINDS / demo / PTE-clinical don't). |
| `cde_data_type` | One of `Number`, `Text`, `Value List`, `Date`, `Datetime`, `Time`, `File/URI/URL`, `Geolocation`, `Other`. Each source has its own type system; extractors map to this enum. |
| `cde_definition` | Free text. |
| `cde_source` | Display label of the originating source (e.g. `NLM NINDS Disease Epilepsy`). |
| `cde_type` | Optional source-specific subtype. |
| `steward_org` | Owning organization (NLM `stewardOrg.name`, e.g. `caDSR`, `NINDS`, `NHLBI`). NLM federates many stewards; this preserves the distinction even when `cde_source` collapses them. |
| `registration_status` | NLM lifecycle marker — `Standard` / `Qualified` / `Recorded` / `Candidate` / `Retired`. Null when the source doesn't expose one. |
| `keywords` | Optional, pipe-joined. |
| `preferred_question_text` | The question as it would appear on a form. |
| `pv_codes`, `pv_labels`, `pv_definitions`, `pv_code_systems`, `pv_concept_identifiers`, `pv_terminology_sources` | Permissible-value columns. Each is pipe-joined (`|`) so all PV columns share a positional alignment. |
| `unit_of_measure` | NLM `valueDomain.uom`. |
| **`min_value`, `max_value`** | Numeric value-domain bounds. CDE-intrinsic — they don't vary per disease classification. *Moved from `cde_classification` in 2026-04.* |
| **`cde_origin`** | `COLLECTED` / `CALCULATED` / `STANDALONE` etc. CDE-intrinsic. *Moved from `cde_classification` in 2026-04.* |
| **`population`** | `Adult`, `Pediatric`, or `Adult;Pediatric`. CDE-intrinsic. *Moved from `cde_classification` in 2026-04.* For NLM rows, derived from `classification[]` paths named `Population`. |
| **`cdisc_domain`, `cdisc_variable_name`, `cdisc_variable_label`** | CDISC SDTM mapping. CDE-intrinsic. *Moved from `cde_classification` in 2026-04.* |
| `references` | Free text or URL list. |
| `nlm_identifier` | The source's stable per-CDE identifier (NINDS uses its catalog `cdeId`, NLM uses tinyId, PTE Clinical uses NINDS catalog ID). One of the canonical-key inputs. |
| `dec_identifier` | Pipe-joined caDSR Data Element Concept IDs (or other terminology IDs) when the source provides them. Drives the global concept registry. |
| `dec_terminology_source` | Pipe-joined source labels parallel to `dec_identifier` (e.g. `caDSR\|caDSR`). |
| `dec_name` | Pipe-joined preferred concept names captured at extraction time when available. |
| `other_identifiers` | Pipe-joined `LABEL:VALUE` cross-walks (e.g. `LOINC:30525-0\|SNOMED:271649006\|CDISC:AGE`). |

Schema constraint: `cde_name`, `cde_data_type`, `cde_definition`, and
`cde_source` are required.

### `cde_classification` — disease + tier

One row per (CDE × disease × scoping context). NINDS emits one classification
row per (cdeId × crfId), so a CDE that appears on three CRFs gets three
rows. NT-PRECEDS demo emits one row per (cdeId × bundle × disease).

The disease columns are a fixed set of yes/no flags + per-disease tier
columns. **CDE-intrinsic fields (numeric range, CDISC mapping, cde_origin,
population) live on `cde`, not here** — those don't vary per-disease.

| Field | Notes |
| --- | --- |
| `variable_name` | Required. Stable identifier; downstream views trust this is unique within a source. |
| `version_name`, `version_date` | Source-attributed version metadata. |
| `notes`, `additional_instructions` | Free text. |
| `disease_<scope>` | One of `Y` / `N`. Scopes today: `agnostic`, `neurotrauma`, `tbi`, `pte`, `sci`, `epilepsy`. |
| `classification_<scope>` | `Core` / `Recommended` / `Supplemental` / `Not Applicable` / `null`. Per-disease tier. |
| `domain`, `subdomain`, `category` | Hierarchical taxonomy. The dashboard joins these into a single `cde_path` for tree rendering. |

Each classification row is linked to its `cde` via a `CLASSIFIES` row in
`relationships.csv`.

### `bundle` — captured-together groupings

Optional. NT-PRECEDS demo data is the only source today that ships bundles —
NINDS and NLM organize CDEs by CRF instead. Bundles represent CDEs that
*must* always travel together (e.g. *Age value* + *Age unit*).

| Field | Notes |
| --- | --- |
| `bundle_name` | Required. |
| `display_name`, `description` | Optional. |
| `domain`, `subdomain`, `category` | Hierarchical taxonomy. |
| `working_group` | Authoring group (NT-PRECEDS only). |

Bundle ↔ CDE membership is expressed as `PART_OF` relationships with the CDE
as `source_record_id` and the bundle as `target_record_id`.

### `crf` — Case Report Forms

Optional. A CRF is a structured form with sections, instructions, and
ordered items. Each item points at a CDE, a bundle, or is a literal section
break.

| Field | Notes |
| --- | --- |
| `crf_name` | Stable slugified name. Required. |
| `title` | Display title. |
| `description`, `instructions` | Free text / markdown. |
| `version` | `"1.0"`-style. |
| `disease_scope` | Display label (e.g. `Epilepsy`, `PTE`). |
| `estimated_duration_minutes`, `collection_frequency` | Optional metadata. |
| `external_url` | Link out to the canonical PDF/DOCX form. |
| `items` | Ordered list of `{ type: 'section' \| 'cde' \| 'bundle', ref, label?, instructions? }`. `ref` is a CDE name, bundle name, or null for sections. |

`items` is intentionally typed as a struct array in JSONL; `prepare-data.mjs`
converts it to a JSON-typed VARCHAR in Parquet so source-specific shape
differences don't break the cross-source `UNION ALL BY NAME` view.

### `provenance` — source identity

Exactly one row per source. Names the source, declares its study type
(`Clinical` / `Preclinical` / null), and tags every other record in the
source via a `SOURCED_FROM` relationship.

| Field | Notes |
| --- | --- |
| `source_key` | URL-safe key, e.g. `nt-preceds-demo-v1`, `ninds-epilepsy`, `nlm-ninds-disease-epilepsy`, `pte-clinical`. Used in URLs and DuckDB file IDs. |
| `label` | Display label, e.g. `NINDS Epilepsy CDEs`. |
| `study_type` | `Clinical`, `Preclinical`, or null (= both). Stamped onto every row in every model of this source by `prepare-data.mjs`. |

### `relationships.csv`

A flat 3-column CSV: `source_record_id,target_record_id,relationship_type`.
Used to wire records together within a source.

| Type | Meaning |
| --- | --- |
| `CLASSIFIES` | Classification row → CDE. Each cls row points at the CDE it qualifies. |
| `PART_OF` | CDE → Bundle. The CDE belongs to the bundle. |
| `SOURCED_FROM` | Any record → Provenance. Tags a record with its source. |

## Conventions

### Pipe-joined columns

Wherever a column is "list-shaped" — permissible value labels, alternate
identifiers, terminology sources — the value is a single string with `|` as
the separator. This keeps Parquet schemas flat and avoids per-source struct
divergence in DuckDB. Parallel pipe-joined columns (e.g. `pv_labels`
+ `pv_codes`) maintain positional alignment: the *N*th `|`-segment in one
column corresponds to the *N*th in the other.

### Empty arrays / strings

Empty pipe-joined columns are emitted as `null`, not `""`. The view layer
uses `NULLIF(TRIM(col), '')` defensively.

### Stable IDs

Per-source record IDs are deterministic UUID-shaped strings derived from a
content key (e.g. `sha1("ninds-epilepsy:cde:C02011")` → reformatted as a
UUID). Re-running an extractor produces identical IDs, so `relationships.csv`
references stay valid.

### Study type stamping

`prepare-data.mjs` writes the source's `study_type` onto every row in every
model as `_study_type`. Downstream filters never join to provenance — they
filter directly on `_study_type`.

### Source order

`DEFAULT_SOURCE_DIRS` in `prepare-data.mjs` defines load order. Order matters
for canonical reconciliation: when two sources contribute records that
collapse to the same canonical key, the first-listed source wins for
display fields (name, definition, etc.). Origins are still aggregated, so
the dashboard shows the merged set; the *picked* row provides the bytes.

## Cross-source reconciliation

The reconciliation logic lives in `src/composables/useDuckDB.ts` and runs
inside DuckDB-WASM at app startup. Per-source parquets are registered with
namespaced file IDs; the rest is SQL.

### Canonical key

For each CDE row across all sources, compute:

```text
canonical_key = COALESCE(
  NULLIF(TRIM(nlm_identifier), ''),
  NULLIF(TRIM(dec_identifier), ''),
  LOWER(TRIM(REGEXP_REPLACE(cde_name, '\\s+', ' ', 'g')))
)
```

A CDE that ships from NINDS and NLM with the same `nlm_identifier` collapses
to one canonical key. A CDE that NLM publishes with the same caDSR DEC as a
demo CDE collapses on `dec_identifier`. Otherwise the normalized name is
the fallback (whitespace-collapsed, lowercased) — this catches sources that
don't share a structured identifier but use the same string.

### `cde_keyed`, `cde_id_map`, `cde`

* `cde_keyed`: every per-source CDE row, decorated with its `canonical_key`.
* `cde_id_map`: `(original_id, canonical_id, canonical_key, _source_key)` —
  used by every downstream view that needs to remap a per-source CDE id to
  the picked row.
* `cde`: one row per `canonical_key`, picking the first-source row that
  shares that key. Aggregated columns:
  * `origins` — `' · '`-joined display labels from all contributing sources.
  * `origin_keys` — comma-joined source keys, used as a substring-matchable
    list for the Origin filter on `/cdes`.
  * `origin_count` — distinct source contribution count.
  * `study_types`, `study_type_count` — same shape, for study-type spread.

### `cde_full`

The canonical CDE rows joined to their picked classification (preferring
the first-source classification that classifies the canonical id), bundle
membership (via `PART_OF` relationships), and provenance (via
`SOURCED_FROM`). This is what every dashboard query reads from. It exposes:

* The CDE's identity columns (`cde_id`, `canonical_key`, `cde_name`, …).
* All classification fields, including disease flags + per-disease tier.
* Bundle attribution (`bundle_id`, `bundle_name`, `bundle_domain`, …).
* The hierarchical taxonomy (`cde_domain`, `cde_subdomain`, `cde_category`),
  COALESCEd from the classification row first, then the bundle.
* `cde_path` — `' / '`-delimited string of the populated taxonomy levels;
  the canonical hierarchical path the tree view consumes. Sources with
  shallower taxonomies emit shorter paths.
* `origins`, `origin_keys`, `study_types`, `_source_key` — used for filters.

`cde_full` is used by every grouped view: the `/cdes` table, the Explore
overview heatmap, the Tree tab, the Treemap tab, the review session
candidate query, and the concept registry derivation.

### Relationships across sources

The `relationships` view rewrites `CLASSIFIES` edges so they target the
canonical CDE id instead of the per-source id, using `cde_id_map`. Other
edge types (`PART_OF`, `SOURCED_FROM`) keep their original targets — they
already point at non-canonical entities (bundles, provenance) and don't
need remapping.

## The derived concept layer

Concepts are the semantic anchors a CDE represents (e.g. *Body weight*,
*Systolic blood pressure*). They're derived globally at data-prep time
from CDE rows that carry `dec_identifier` + `dec_terminology_source`,
written to the data root rather than per-source.

### `public/data/concept.parquet`

| Field | Notes |
| --- | --- |
| `id` | Stable slug: `lower(source + '_' + identifier)` with non-alphanumerics → `_`. e.g. `(caDSR, 1285)` → `cadsr_1285`. |
| `source` | Terminology label (`caDSR`, `LOINC`, `SNOMED CT`, `NCI Thesaurus`, …). |
| `identifier` | Source-specific concept ID. |
| `cui` | UMLS Concept Unique Identifier. Filled by Phase 4b enrichment via UTS; null until then. |
| `preferred_label` | Human-readable concept name. Filled by `scripts/enrich-concepts.mjs` for sources we have an adapter for. |
| `definition` | Concept definition. Filled by enrichment. |
| `alt_labels` | `\|`-joined alternative names. Filled by enrichment. |

### `public/data/cde_represents_concept.parquet`

A relationship parquet linking each CDE to every concept it carries an
identifier for.

| Field | Notes |
| --- | --- |
| `cde_id` | The CDE record id. The dashboard remaps via `cde_id_map` to the canonical id at view-creation time. |
| `concept_id` | Matches `concept.id`. |
| `role` | `primary` / `unit` / `qualifier` / `other`. Defaults to `primary`; later phases let curators refine for supporting elements. |
| `_source_key` | Which source contributed the relationship (a CDE present in multiple sources may emit duplicate edges; the registry stores them all). |

### Enrichment cache

`scripts/enrich-concepts.mjs` reads `concept.parquet`, calls source-specific
adapters, and writes `data/concept-enrichment.json` (committed). The cache
maps `concept_id` → `{ preferred_label, definition, cui, alt_labels,
fetched_at, last_error }`. `prepare-data.mjs` LEFT JOINs the cache when
emitting `concept.parquet`, so enrichment values override in-record labels.

Today there is one adapter:

* **caDSR** — NLM's `POST /server/de/search` returns the caDSR-attributed
  CDE; we lift its `designation` as the concept's `preferred_label`.

UMLS UTS adapter is sketched for LOINC / SNOMED CT / NCI Thesaurus once
sources contributing those identifiers land in the registry.

## Runtime config (SSM-driven)

Independent of the data files, two operator knobs flip without redeploying:

* **`review_scope`** — `{ all_open: true }` (default; everything open) or
  `{ all_open: false, cdes: [...], bundles: [...] }` (allowlist mode for
  the review session candidate pool).
* **`enabled_sources`** — empty array means all sources visible. A non-empty
  list filters `manifest.sources` at boot, so disabled sources never load
  into DuckDB and effectively vanish from the dashboard.

Both live in a single SSM JSON parameter
(`/<env>/<service>/dashboard-config`), exposed via
`GET /v1/dashboard-config` (Lambda, public, ~60s server-side cache).
`src/api/dashboardConfig.ts` fetches once at app boot with a ~4s timeout
and falls back to permissive defaults on failure.

## Adding a new source

1. **Build an extractor** under `scripts/`. It reads upstream data and
   writes `data/<source>/metadata/...` matching the layout above. Look at
   `fetch-ninds-epilepsy.mjs` (live API extraction),
   `fetch-nlm-cde.mjs` (live API), `transform-pte-clinical-2.mjs` (CSV input),
   or `generate-demo-data.mjs` (synthetic) for templates.
2. **Emit one provenance record** with a unique `source_key`. Pick a value
   for `study_type` if the whole source is single-context.
3. **Map upstream classifications** onto our `Core` / `Recommended` /
   `Supplemental` / `Not Applicable` enum, and onto the disease
   `Y` / `N` columns (`disease_pte`, `disease_tbi`, `disease_epilepsy`, etc.).
4. **Pipe-join list-shaped values** (`pv_labels`, `dec_identifier`,
   `other_identifiers`).
5. **Wire `relationships.csv`** with `CLASSIFIES`, `PART_OF`, and
   `SOURCED_FROM` rows.
6. **Run `node scripts/prepare-data.mjs … data/<new-source>`** once to
   verify the parquet emit; counts will print per model.
7. **Add the source to `DEFAULT_SOURCE_DIRS`** in `prepare-data.mjs` if
   it should load by default. Order matters — earlier sources win on
   canonical reconciliation.
8. **Run `yarn enrich-concepts`** if the new source contributes any
   `dec_identifier` rows.

The dashboard requires no code changes for a new source — provided the
extractor emits the expected fields, the existing reconciler handles the
rest.
