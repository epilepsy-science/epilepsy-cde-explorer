# NT-PRECEDS CDE Review Dashboard

Interactive dashboard for browsing and reviewing Common Data Elements (CDEs) and
Bundles from the NT-PRECEDS preclinical neurotrauma program, in preparation for
submission to the National Library of Medicine.

**Stack:** Vue 3 · Element Plus · DuckDB-WASM · Vite · TypeScript.

Prototype intended for later embedding into the epilepsy.science Nuxt 3 app.

## Getting started

```bash
yarn install
yarn prepare-data   # converts JSONL + CSV source → Parquet in public/data/
yarn dev            # http://localhost:5173
```

Source data lives in `data/<source-key>/` (e.g. `data/demo`, `data/ninds-epilepsy`, `data/nlm-ninds-disease-epilepsy`).
The prep step cleans ~100 records with double-escaped quotes, flattens the
`{id, data:{...}}` shape into flat columns, and writes zstd-compressed Parquet.

## Architecture

- `src/composables/useDuckDB.ts` — initializes DuckDB-WASM once, registers the
  Parquet files via HTTP, and creates the denormalized views:
  - `cde_full` — one row per `(canonical CDE × classification × bundle)`.
    Used by Tree, Treemap, BundleDetail, CrfDetail — anywhere multi-context
    membership produces richer output.
  - `cde_canonical` — exactly one row per canonical CDE; aggregates classification
    fields across contexts (max-OR for disease scope, highest tier for
    classification, pipe-joined bundles + paths). Used by /cdes table, Home tiles,
    Overview counts, drawer lookups.
  - `bundle_full` — bundle + member CDE count
- `src/views/CdesView.vue` — CDE browse table with filters, detail drawer
- `src/views/BundlesView.vue` — bundles grouped by domain → subdomain
- `src/views/BundleDetailView.vue` — bundle metadata + member CDEs (pattern that
  will later host CRF review)

## Embedding into epilepsy.science

Styling tokens in `src/assets/scss/_variables.scss` mirror
`epilepsy-science-app-2/assets/scss/_variables.scss`. Components use
`<script setup lang="ts">` with a composable for state, so they port into Nuxt
with minimal rework.
