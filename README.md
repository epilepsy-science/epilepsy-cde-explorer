# CDE Review Dashboard

Interactive dashboard for browsing and reviewing Common Data Elements (CDEs),
Bundles, and Case Report Forms (CRFs) drawn from multiple standards sources
(NINDS, NLM CDE Repository, PTE clinical curation, plus a sample preclinical
set). The catalog is queried entirely in the browser with DuckDB-WASM — there
is no database server to run. A small backend handles only reviewer auth and
review submission.

This is a **monorepo** with three parts:

- **Frontend** (repo root) — Vue 3 · Element Plus · DuckDB-WASM · Vite ·
  TypeScript. Deployed via AWS Amplify (`amplify.yml`).
- **Backend** (`api/`) — a single Go Lambda behind API Gateway for magic-code
  email auth and review storage. See [`api/README.md`](./api/README.md).
- **Infrastructure** (`terraform/`) — Terraform for the API Lambda, API
  Gateway, DynamoDB, DNS, and SSM/secrets. See
  [`terraform/README.md`](./terraform/README.md).

**You only need the frontend to develop and browse the dashboard** — it points
at the already-deployed hosted API. The backend and Terraform matter only if
you're changing or deploying the API itself.

Prototype intended for later embedding into the epilepsy.science Nuxt 3 app.

## Prerequisites (frontend)

- **Node.js 20+**
- **Yarn** (classic, 1.x)
- A network connection for the first `yarn prepare-data` (it downloads CDISC
  controlled terminology from a public NCI endpoint).

(Backend/infra prerequisites — Go, AWS, SES — are separate; see *Backend and
infrastructure* below.)

## Quick start (frontend)

```bash
yarn install
yarn prepare-data   # build the Parquet data files (required — see below)
yarn dev            # http://localhost:5173
```

That's it for browsing — the dashboard loads its data client-side, so you
don't need to run or deploy the backend at all.

### Why `yarn prepare-data` is required

The Parquet files the browser fetches are **not committed** (they're
reproducible build artifacts). `yarn prepare-data` reads the source records in
`data/<source>/` and writes the Parquet files into `public/data/`. Run it once
after cloning, and again whenever the source data changes. Concretely it:

- converts each source's JSONL records + `relationships.csv` into per-source
  Parquet (`public/data/<source-key>/`),
- flattens the `{ id, data: {...} }` record shape into flat columns and cleans
  records with double-escaped quotes,
- derives the global `concept.parquet` + `cde_represents_concept.parquet` and a
  runtime `manifest.json`,
- downloads CDISC SDTM controlled terminology into `public/data/cdisc-ct/`
  (public download, no API key needed; the app runs fine if this step is
  skipped or offline).

## Optional: API features (login, review submission)

Browsing works without any backend. The auth-gated features (login, saving a
review) talk to the hosted API at `https://api.cde.epilepsy.science`. The Vite
dev server proxies `/v1/*` there so localhost avoids CORS — but for the proxy
to kick in, the API client must use relative URLs. Create a `.env.local`:

```bash
# .env.local
VITE_API_BASE_URL=
# Optional — only needed to exercise the reCAPTCHA-protected endpoints:
# VITE_RECAPTCHA_SITE_KEY=<site-key>
```

Because login/review go through the hosted API, **frontend development needs
no AWS resources (no SES, DynamoDB, or Terraform)**. Without `.env.local` the
client falls back to `http://localhost:8080`, so API calls fail unless you run
the Go backend yourself. Plain data browsing is unaffected either way.

## Backend and infrastructure

The `api/` (Go Lambda) and `terraform/` directories are only relevant when you
change or deploy the API itself. Full details live in
[`api/README.md`](./api/README.md) and [`terraform/README.md`](./terraform/README.md);
in short:

```bash
cd api && make build     # → dist/api/bootstrap (needs Go 1.24+)
cd terraform && terraform init && terraform apply
```

**This assumes the supporting AWS resources already exist** and the deploying
identity can reach them:

- **Amazon SES** — auth sends a magic-code email, so SES must be set up with a
  **verified sender** matching the Lambda's `EMAIL_FROM` (e.g.
  `noreply@pennsieve.net`). In a sandboxed SES account, recipient addresses
  must also be verified. Auth is unusable until this is in place.
- **DynamoDB** single table (reviewers, codes, reviews) — created by Terraform.
- **SSM Parameter Store** — the HS256 JWT signing key (SecureString) and the
  runtime dashboard-config parameter.

The Lambda's full environment-variable contract (`EMAIL_FROM`, `TABLE_NAME`,
`JWT_SECRET_SSM_NAME`, …) is documented in
[`api/README.md`](./api/README.md#required-env-vars-set-on-the-lambda-in-terraform).

## Common commands

| Command | What it does |
| --- | --- |
| `yarn dev` | Vite dev server at http://localhost:5173 |
| `yarn build` | Type-check (`vue-tsc`) + production build to `dist/` |
| `yarn preview` | Serve the production build locally |
| `yarn prepare-data` | Rebuild the Parquet data files in `public/data/` |
| `yarn enrich-concepts` | Refresh concept labels/definitions from terminology adapters |
| `yarn export-schemas` | Regenerate the JSON Schema contracts in `schemas/` |

## Data model

Source data lives in `data/<source>/` (e.g. `data/demo`,
`data/ninds-epilepsy`, `data/nlm-ninds-disease-epilepsy`, `data/pte-clinical-2`).
The full pipeline — source records → Parquet → DuckDB views, the five models,
cross-source reconciliation, and the concept layer — is documented in
[`docs/data-model.md`](./docs/data-model.md).

## Architecture

- `src/composables/useDuckDB.ts` — initializes DuckDB-WASM once, registers the
  Parquet files via HTTP, and creates the reconciled views:
  - `cde_full` — one row per `(canonical CDE × classification × bundle)`. Used
    by Tree, Treemap, BundleDetail, CrfDetail — anywhere multi-context
    membership produces richer output.
  - `cde_canonical` — exactly one row per canonical CDE; aggregates
    classification fields across contexts (max-OR for disease scope, highest
    tier for classification, pipe-joined bundles + paths). Used by the /cdes
    table, Home tiles, Overview counts, drawer lookups.
  - `bundle_full` — bundle + member CDE count.
- `src/views/CdesView.vue` — CDE browse table with filters and detail drawer.
- `src/views/BundlesView.vue` — bundles grouped by domain → subdomain.
- `src/views/BundleDetailView.vue` — bundle metadata + member CDEs (the pattern
  that will later host CRF review).

## Embedding into epilepsy.science

Styling tokens in `src/assets/scss/_variables.scss` mirror
`epilepsy-science-app-2/assets/scss/_variables.scss`. Components use
`<script setup lang="ts">` with a composable for state, so they port into Nuxt
with minimal rework.