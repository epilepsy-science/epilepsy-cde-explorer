# Plan: consume the published CDE catalog (v2 schema)

Status: proposed · Owner: TBD · Branch base: `feat/read-published-catalog`

## TL;DR

Switching off the dashboard's "own" data source is **already ~80% done**: on
`feat/read-published-catalog` the runtime no longer reads locally-built Parquet —
`src/composables/useDuckDB.ts` reads a *published cde-service catalog* over HTTP
(`latest.json` → `manifest.json` → per-model `records.jsonl` + `relationships.csv`),
keyed by `VITE_CDE_CATALOG_URL`.

The remaining work is **not** removing local Parquet — it's:

1. **Aligning the query layer to the cde-service v2 schema**, because the catalog
   the dashboard already points at (dev, `d1es2ibvcs23vq.cloudfront.net`) flipped
   from v1 → **v2** on 2026-08-05, and the dashboard's views still assume v1.
2. **Choosing which catalog to point at** (dev vs the official prod
   `cde-catalog.pennsieve.io`), which is coupled to the pending **prod v2
   migration** (prod is still v1: `20260723T113417Z`).
3. Retiring the now-orphaned local build pipeline.

## Current vs target schema

The dashboard currently reads models `cde`, `cde_classification`, `bundle`,
`provenance` and asserts `cde`/`cde_classification`/`provenance`
(`useDuckDB.ts:93-94`). It does **not** read `form`. Under v2 that is wrong:

| Concept | v1 (what the code assumes) | v2 (what the catalog now has) |
|---|---|---|
| CRF / instrument / survey (the ~1,750 "bundles" in the UI) | `bundle` model | **`form`** model (dashboard doesn't read it yet) |
| Indivisible validated instrument (PHQ-9, AUDIT) | — | **`bundle`** model (47 records; the code reads *these* as if CRFs) |
| Classification | long-form `context`+`tier`, pivoted to 6 hardcoded diseases (`useDuckDB.ts:194,209-220`) | flat `cde_classification` / `form_classification` / `bundle_classification` with `context, sub_context, population, domain, tier` (open-ended context set) |
| Per-CRF member tier | derived from the disease pivot | **`form_member_tier`** table (`{form_key, context, sub_context, population, cde_key, tier}`, 25,180 rows) — pre-resolved at publish |
| Concept | empty stub (`useDuckDB.ts:251-263`) | real `concept` model + `cde → concept` REPRESENTS |
| CRF | empty stub, user-authored only | still not in the catalog — keep client/localStorage CRFs |

## Key decisions

- **D1 — target catalog. DONE.** Prod Amplify points at `https://cde-catalog.pennsieve.io`
  via terraform (`terraform/main.tf` `VITE_CDE_CATALOG_URL`); local dev overrides in
  `.env.local` (dev catalog). Once scoping (D4) lands, prod points at the scoped
  **collection** URL, not the full catalog root.
- **D2 — v2 timing.** Prod is still v1. The v2 query-layer alignment must **land with
  the prod catalog becoming v2** (pending cde-service prod migration). Hold on this
  branch; local dev runs against the dev v2 catalog meanwhile.
- **D3 — jsonl → parquet. DECIDED: yes, do it.** The catalog publishes `records.parquet`
  per model (+ `records-list.parquet` for `cde`, pre-flattened pipe-joined
  `pv_*`/`other_identifiers`). Switch the DuckDB reads from `records.jsonl` +
  `data->>'…'` extraction to parquet with column/row pushdown — the main fix for the
  slow load. See Step P.
- **D4 — scoping. DECIDED: server-side published collection (option 2b).** Only
  ~6,573 of 26,343 CDEs are neuro/epilepsy; the rest (Sickle Cell, Parkinson's,
  Stroke, ALS, …) is noise, and it lives *inside* NINDS, so source selection can't
  scope it — the axis is classification **context**. cde-service publishes a scoped
  collection; the dashboard reads that. See Step C.

## Step C — Scoped published collection (cde-service) — the relevance fix

Goal: cde-service publishes a small, neuro/epilepsy-scoped view of the catalog that
the dashboard (and any other scoped consumer) reads instead of the full 26k.

Data that shapes this (dev catalog `20260805T025409Z`):
- 82 distinct classification contexts; ~6,573 CDEs in neuro/epilepsy contexts,
  ~8.5k including `General (For all diseases)`.
- Allow-list must include spelling variants — both `Sport Related Concussion` and
  `Sport-Related Concussion` are present (free-text context drift).

Design (in cde-service, at publish time):
- Define named **collections** in config (SSM or a repo file), each an allow-list of
  classification `context` values (+ optionally `General (For all diseases)`),
  e.g. `neuro-epilepsy = [Traumatic Brain Injury, Preclinical TBI, Sport Related
  Concussion, Sport-Related Concussion, Spinal Cord Injury, Epilepsy, General (For
  all diseases)]`.
- On publish, in addition to the full release, emit a filtered subset under
  `cde/collections/<name>/versions/<v>/…` with its own `latest.json` + `manifest.json`
  + per-model `records.{jsonl,parquet}` + `relationships.csv` + `form_member_tier`,
  containing only: CDEs whose classification context ∈ allow-list; those CDEs'
  in-scope classifications; the forms/bundles they belong to (+ classifications);
  concepts they REPRESENT; relationships among retained records; all provenance.
- Same layout/contract as the root catalog, so the dashboard's load layer is
  unchanged except the base URL.
- Consider a controlled context vocabulary later to end the spelling drift.

Dashboard side: point `VITE_CDE_CATALOG_URL` at
`https://cde-catalog.pennsieve.io/cde/collections/neuro-epilepsy` (path prefix), or
add a `VITE_CDE_COLLECTION` knob the load layer appends.

## Known v2 field gaps (for the query-layer alignment)

Renamed/removed fields the current views still read under old names (return NULL
against v2 until re-mapped — pre-existing, not caused by the parquet swap):
- **provenance**: v2 uses `provenance_name` (not `label`) and has no `study_type`
  / `kind`. Affects the Sources column + origin/study-type facets.
- (Watch for others as the classification/concept views are generalized.)

## Step P — Parquet reads (perf) — the speed fix — DONE

Goal: cut the slow load (26k CDEs + 76k classifications + 235k relationships parsed
from JSONL).
- Switch `jsonSrc()` / the model reads in `useDuckDB.ts` from `read_json` on
  `records.jsonl` to `read_parquet` on `records.parquet` (and `records-list.parquet`
  for `cde`, which already carries the flat pipe-joined `pv_*` / `other_identifiers`
  columns — dropping the `data->>'…'` + array-join reshaping).
- Keep the relationships read (`relationships.csv`) or move to a parquet edges file
  if published.
- Let DuckDB-WASM range-read parquet over HTTP (column + predicate pushdown) instead
  of downloading + JSON-parsing whole files.
- Independent of scoping; compounding win when combined with the smaller collection.

## Steps (dashboard query-layer alignment)

### 1. Catalog URL wiring (D1)
- Confirm `VITE_CDE_CATALOG_URL` is the single knob (`useDuckDB.ts:65-67`). ✓ already.
- Add it to the Amplify environment (prod → `cde-catalog.pennsieve.io`) and to
  `.env.local` for dev. Remove the hardcoded default or make it dev-only.

### 2. Add the `form` model to the load + view layer (`useDuckDB.ts`)
- Register `catalog__form` and `catalog__form_classification` alongside the
  existing models (`useDuckDB.ts:80-95`); add `form` to the required-models assert.
- Introduce a `form` view (CRF/instrument) with the columns the UI needs
  (`form_key`, `form_name`, `steward_org`, `instructions`, `member_cde_keys`, …).
- Re-map the UI's "CRF/bundle-of-questions" surfaces from the old `bundle` view to
  `form` (CdesView, CrfDetailView, BundleDetailView, ReviewSession — see the
  consumers listed in the data-layer map). Keep a **separate** `bundle` view for the
  47 true v2 bundles.

### 3. Generalize the classification pivot (`useDuckDB.ts:192-222`)
- Replace the hardcoded 6-disease pivot (`ctxCol`, `disease_*`, `classification_*`)
  with the flat v2 columns `context, sub_context, population, domain, tier`.
- Drive the disease/context facets from the data (distinct `context` values) rather
  than the hardcoded `DiseaseKey` list (`types.ts:383-389`); update the tier
  vocabulary (`types.ts:237-249`, `useDuckDB.ts:429-434`) to the NINDS/NLM tiers
  present in v2 (Core / Supplemental / Supplemental – Highly Recommended / Proposed /
  Exploratory / Tier 1 …).

### 4. Wire `form_member_tier`
- Register and expose `form_member_tier` so the UI can show a CDE's tier *within a
  given form/scope* (replaces the per-disease tier the old pivot inferred).

### 5. Wire the real `concept` model
- Drop the empty `concept` / `cde_represents_concept` stubs (`useDuckDB.ts:251-263`);
  read the catalog `concept` model + the `cde → concept` REPRESENTS edges.
- Decide the fate of `enrich-concepts.mjs`: v2 `concept_name` may fall back to the
  caDSR id when no `dec_name` is supplied — keep enrichment as a display-name
  overlay, or accept catalog values.

### 6. Update types (`src/types.ts`)
- Add `FormRow`; split it from `BundleRow` (v2 bundle). Update `CdeRow` /
  `CdeCanonicalRow` to the flat classification + `form_member_tier` shape. Wire the
  real `ConceptRow`.

### 7. Retire the orphaned local pipeline
- Remove `yarn prepare-data` from `amplify.yml:7` (preBuild) once the catalog is the
  sole source; drop/relocate `scripts/prepare-data.mjs`, `enrich-concepts.mjs`, and
  the `public/data/*.parquet` outputs. Prune the `/data/*.parquet` cache headers in
  `amplify.yml:24-50`.
- `schemas/` + `scripts/export-json-schemas.mjs` describe the old flat Parquet and
  are now divergent — regenerate from the catalog schema or remove.

### 8. CDISC CT decision
- The v2 catalog carries no CDISC CT codelists. The static `/data/cdisc-ct/*.parquet`
  views are registered but **unqueried and absent** (`useDuckDB.ts:544-588`). Either
  drop the dead views + `fetch-cdisc-ct.mjs`, or, if CDISC lookup is still wanted,
  keep it as a clearly separate static side-load.

### 9. Verify against v2
- Browse counts sanity-check vs the manifest (cde 26,343 · form 1,750 · bundle 47 ·
  cde_classification 76,436 · form_classification 3,860 · concept 252).
- Confirm CRFs render (from `form`), bundles are the 47, classification facets come
  from live `context`, per-form tiers resolve from `form_member_tier`, concepts and
  REPRESENTS links populate.

### 10. Docs + cleanup
- Update `README.md` (no more `yarn prepare-data`; the catalog is the source) and
  `docs/data-model.md` to the v2 shape.

## Out of scope
- The `api/` Go Lambda (reviewer auth + review storage) — unaffected; no CDE data.
- Publishing/curating the catalog itself — that's the cde-service side.

## Cross-refs
- Data-layer map (this session's exploration) — the definitive current-state
  reference for file:line anchors.
- cde-service catalog contract: `cde/latest.json` → `cde/versions/<v>/manifest.json`
  → `metadata/models/<name>/versions/<n>/records.{jsonl,parquet}` +
  `metadata/relationships.csv` + `metadata/form_member_tier.{jsonl,parquet}`.
- Coupled to the cde-service **prod v2 migration** (pending) and the consumer-update
  tracking ticket (ClickUp 868kmdtvz).
