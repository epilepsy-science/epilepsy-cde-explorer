# Standards alignment

How the dashboard's data model maps to the published CDE / clinical-data
standards it builds on. Use this as a tiebreaker when deciding *where* to
attach a new piece of metadata: on the canonical CDE, on the classification
(reference) row, on the bundle, or on the form.

## The standards we track against

| Standard | Scope | Where it shows up |
| --- | --- | --- |
| **ISO/IEC 11179** | Metadata-registry metamodel for *Data Elements*. Defines Data Element, Data Element Concept, Conceptual Domain, Value Domain. Deliberately silent on forms, bundles, groupings. | Shape of our `cde` model (DEC + value domain + identifiers). |
| **caDSR** (NCI Cancer Data Standards Registry) | The canonical 11179 implementation. Adds Forms and standardized question text, but the DE layer is straight 11179. NLM CDE Repository federates caDSR + other stewards. | Source of `dec_identifier`, `cdisc_*` columns. |
| **NIH/NLM CDE Repository** | Federated catalog of CDEs from many stewards (NINDS, NHLBI, caDSR, …). Has Forms, no separate "bundle" tier — Forms are the only grouping. | Our largest single source. Drives `cde.parquet` shape. |
| **CDISC ODM v2** | Clinical-data exchange format. Defines the form/group/item hierarchy and — crucially — where contextual overlays attach. | Reference for `cde_classification` ↔ `bundle` ↔ `crf` structure. |

ISO 11179 + CDISC ODM is the dominant pair: 11179 governs the canonical
element definition, ODM governs how that element is referenced inside a
form. Our model honors that split.

## CDISC ODM v2 hierarchy

```
ItemDef  ──ItemRef──▶  ItemGroupDef  ──ItemGroupRef──▶  ItemGroupDef[Type="Form"]
(canonical)             (bundle)                         (form / CRF)
```

The critical design point: **per-context attributes live on the `ItemRef`
— the *reference* — not the `ItemDef`**. ODM puts `OrderNumber`,
`Mandatory`, `MethodOID`, `WorkflowRef` on the reference because the same
`ItemDef` may participate in multiple groups with different requirements.

In v2, `FormDef` no longer exists as a distinct element — a Form is just an
`ItemGroupDef` with `Type="Form"`. Bundles and forms share a tier; the
distinction is metadata, not structure.

## Mapping ODM ⇆ this project

| Our model | ODM v2 equivalent | Notes |
| --- | --- | --- |
| `cde` | `ItemDef` | The canonical 11179 Data Element. One row per `canonical_key`. |
| `cde_classification` | `ItemRef` (the reference edge, with overlay attributes) | One row per `(CDE × scoping context)`. Disease scope, tier, domain, additional_instructions, **bundle membership** all live here. |
| `bundle` | `ItemGroupDef` (reusable inner group) | A cluster of CDEs that always travel together (e.g. *Age value* + *Age unit*). |
| `crf` | `ItemGroupDef` with `Type="Form"` | The data-collection form itself. |

`cde_classification` *is* an `ItemRef` in disguise — that's the right way
to read it. Anything that varies "per scoping context" belongs there, not
on the canonical `cde`.

## Where to attach new metadata — decision tree

When adding a new column, ask:

1. **Does this property change if the CDE is reused in a different
   form / disease / study?** If no → put it on `cde`. (E.g. data type,
   value domain, NLM identifier, CDISC SDTM mapping.)
2. **Yes, it varies per context.** → put it on `cde_classification`.
   (E.g. disease scope, tier, domain/subdomain/category, additional
   instructions, **bundle membership**.)
3. **It describes a grouping, not an individual element.** → put it on
   `bundle` or `crf` (whichever applies).

Putting context-varying metadata on `cde` is a common mistake — it forces
either lossy collapse or duplicated CDE rows, both of which break canonical
reconciliation across sources. ODM avoided this trap; we should too.

## The bundle ↔ classification edge (PART_OF)

Bundle membership is a per-context property: the same canonical CDE
(e.g. `C00312` "Body system category") can appear in *Physical Exam*
without a bundle and in *Medical History* under the *Medical History Body
System* bundle. Therefore:

```
relationships.csv
classification_id, bundle_id, PART_OF
```

**Source = classification, target = bundle.** Not `CDE → Bundle`. This
mirrors ODM's principle that the reference (ItemRef) — not the canonical
element — carries the contextual overlay.

The runtime view `bundle_of_cls` in `useDuckDB.ts` joins on this exact
edge to attach `bundle_name` / `bundle_domain` to each `cde_full` row.

## Where we diverge from NLM

NLM CDE Repository has no "bundle" tier — only Forms. We added one because
NT-PRECEDS curators wanted a way to flag CDEs that *must* travel together
(numeric value + unit-of-measure being the canonical example) independent
of which form happens to use them.

This is consistent with ODM (bundles are just inner `ItemGroupDef`s) but
more opinionated than NLM. When importing from NLM-only sources we leave
the bundle layer empty; when curated sources (NT-PRECEDS, PTE Clinical)
ship a bundle column we surface it.

## Why we collapse classifications across CRFs in `cde_full`

The `cde_full` view picks one classification per canonical CDE
(first-source wins) and exposes its disease/tier/taxonomy columns. A CDE
that's classified differently on five forms gets only the first
classification's tier surfaced.

This is a deliberate simplification for the dashboard's grouped views
(Tree, Treemap, /cdes table). The full `cde_classification` table is
still queryable when a view needs all reference rows — e.g. the CRF
detail page, the review session, and any future per-form export.

This collapse is *not* aligned with ODM (which preserves every reference
distinctly). It's a UI tradeoff. Revisit if curators ever need to see
per-CRF tier conflicts at the canonical-row level.

## References

- [NIH Common Data Elements (CDE) Repository](https://cde.nlm.nih.gov/guides) — entry point for the federated catalog.
- [ISO/IEC 11179 — Wikipedia](https://en.wikipedia.org/wiki/ISO/IEC_11179) — readable summary of the metamodel parts.
- [CDISC ODM v2 — ItemGroupDef](https://wiki.cdisc.org/spaces/ODM2/pages/196838487/ItemGroupDef) — where the Item / ItemGroup / Form hierarchy is specified.
- [CDISC ODM Standard](https://www.cdisc.org/standards/data-exchange/odm) — top-level docs for the operational data model.
- [Common Data Elements for Cancer Research (PMC2980785)](https://pmc.ncbi.nlm.nih.gov/articles/PMC2980785/) — caDSR's CDE structure as the 11179 reference implementation.