import { ref, readonly } from 'vue';
import * as duckdb from '@duckdb/duckdb-wasm';

type Status = 'idle' | 'loading' | 'ready' | 'error';

interface DuckDBHandle {
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
}

// The published cde-service catalog release manifest
// (cde/versions/<catalog_version>/manifest.json).
interface CatalogManifest {
  catalog_version: string;
  generated_at: string;
  models: { name: string; version: number; records: number }[];
  relationship_count: number;
}

let handlePromise: Promise<DuckDBHandle> | null = null;
const status = ref<Status>('idle');
const error = ref<string | null>(null);

async function fetchWithBinaryCheck(url: string): Promise<boolean> {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok) return false;
    // Vite dev server returns 200 + index.html for missing paths under /data/.
    const ct = head.headers.get('content-type') || '';
    return !ct.includes('text/html');
  } catch {
    return false;
  }
}

async function init(): Promise<DuckDBHandle> {
  status.value = 'loading';
  try {
    const bundles = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(bundles);
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker!}");`], {
        type: 'text/javascript',
      }),
    );
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);

    const conn = await db.connect();

    // ── Read the published CDE catalog release (single reconciled dataset) ────
    // Source of truth is the cde-service catalog on CloudFront. The catalog is
    // ALREADY the one reconciled store (one row per CDE), so there is no
    // per-source union / client-side reconciliation here. Records are nested
    // ({id, data}) and classification is long-form; we reshape to the flat/wide
    // view contract the rest of the app expects. Layout:
    //   cde/latest.json                 -> { catalog_version }
    //   cde/versions/<v>/manifest.json  -> { models: [{name, version, records}] }
    //   .../metadata/models/<m>/versions/<n>/records.jsonl  ({id, data:{...}})
    //   .../metadata/relationships.csv  (source_record_id,target_record_id,relationship_type)
    const catalogBase = (
      (import.meta.env.VITE_CDE_CATALOG_URL as string | undefined) ||
      'https://d1es2ibvcs23vq.cloudfront.net'
    ).replace(/\/$/, '');

    const latestRes = await fetch(`${catalogBase}/cde/latest.json`, { cache: 'no-cache' });
    if (!latestRes.ok) throw new Error(`Missing ${catalogBase}/cde/latest.json`);
    const catalogVersion = ((await latestRes.json()) as { catalog_version: string }).catalog_version;

    const verBase = `${catalogBase}/cde/versions/${catalogVersion}`;
    const manifestRes = await fetch(`${verBase}/manifest.json`);
    if (!manifestRes.ok) throw new Error(`Missing ${verBase}/manifest.json`);
    const manifest = (await manifestRes.json()) as CatalogManifest;

    // Register each model's records.jsonl + the relationships.csv as DuckDB HTTP
    // files (referenced by name in read_json / read_csv below).
    const modelFile: Record<string, string> = {};
    for (const m of manifest.models) {
      const fileId = `catalog__${m.name}`;
      const url = `${verBase}/metadata/models/${m.name}/versions/${m.version}/records.jsonl`;
      await db.registerFileURL(fileId, url, duckdb.DuckDBDataProtocol.HTTP, false);
      modelFile[m.name] = fileId;
    }
    await db.registerFileURL(
      'catalog__relationships',
      `${verBase}/metadata/relationships.csv`,
      duckdb.DuckDBDataProtocol.HTTP,
      false,
    );
    for (const req of ['cde', 'cde_classification', 'provenance']) {
      if (!modelFile[req]) throw new Error(`catalog manifest missing required model: ${req}`);
    }

    // Each records.jsonl line is {id, data:{...}}. Read `data` as JSON so fields
    // absent from every record (e.g. keywords) resolve to NULL via `->>` instead
    // of a struct-binder error.
    const jsonSrc = (fileId: string) =>
      `read_json('${fileId}', format='newline_delimited', columns={'id': 'VARCHAR', 'data': 'JSON'})`;
    // Pipe-join a scalar sub-field across a nested JSON array of objects.
    const arrJoin = (path: string) =>
      `NULLIF(array_to_string(CAST(json_extract(data, '${path}') AS VARCHAR[]), '|'), '')`;
    const pvJoin = (sub: string) => arrJoin(`$.permissible_values[*].${sub}`);
    // Pipe-join a top-level JSON string array (aliases, keywords).
    const strArr = (key: string) =>
      `NULLIF(array_to_string(CAST(data->'${key}' AS VARCHAR[]), '|'), '')`;

    // ── provenance + source labels (from the catalog's own provenance rows) ──
    await conn.query(`
      CREATE OR REPLACE VIEW provenance AS
      SELECT id,
             data->>'label'      AS label,
             data->>'source_key' AS source_key,
             data->>'study_type' AS study_type,
             data->>'kind'       AS kind
      FROM ${jsonSrc(modelFile.provenance)}
    `);
    await conn.query(`
      CREATE OR REPLACE VIEW source_labels AS
      SELECT source_key, label, study_type, kind, 0 AS ord FROM provenance
    `);

    // ── relationships (rename to the source_id/target_id/type contract) ──────
    await conn.query(`
      CREATE OR REPLACE VIEW relationships AS
      SELECT CAST(source_record_id AS VARCHAR) AS source_id,
             CAST(target_record_id AS VARCHAR) AS target_id,
             relationship_type                 AS type,
             CAST(NULL AS VARCHAR)              AS _source_key
      FROM read_csv_auto('catalog__relationships', header=true)
    `);

    // ── cde (flat, one row per CDE; PVs flattened; origins from SOURCED_FROM) ─
    await conn.query(`
      CREATE OR REPLACE VIEW cde AS
      WITH rows AS (SELECT id, data FROM ${jsonSrc(modelFile.cde)}),
      origins AS (
        SELECT r.source_id AS cde_id,
               array_to_string(array_sort(array_agg(DISTINCT p.label)), ' · ')    AS origins,
               array_to_string(array_sort(array_agg(DISTINCT p.source_key)), ',') AS origin_keys,
               count(DISTINCT p.source_key)                                       AS origin_count,
               array_to_string(array_sort(array_agg(DISTINCT p.study_type)), ',') AS study_types,
               count(DISTINCT p.study_type)                                       AS study_type_count
        FROM relationships r
        JOIN provenance p ON CAST(p.id AS VARCHAR) = r.target_id
        WHERE r.type = 'SOURCED_FROM'
        GROUP BY r.source_id
      )
      SELECT
        rows.id,
        data->>'canonical_key'            AS canonical_key,
        data->>'cde_name'                 AS cde_name,
        ${strArr('aliases')}              AS aliases,
        data->>'cde_data_type'            AS cde_data_type,
        data->>'cde_definition'           AS cde_definition,
        data->>'cde_source'               AS cde_source,
        data->>'cde_type'                 AS cde_type,
        data->>'steward_org'              AS steward_org,
        data->>'registration_status'      AS registration_status,
        ${strArr('keywords')}             AS keywords,
        data->>'preferred_question_text'  AS preferred_question_text,
        ${pvJoin('label')}                AS pv_labels,
        ${pvJoin('code')}                 AS pv_codes,
        ${pvJoin('definition')}           AS pv_definitions,
        ${pvJoin('code_system')}          AS pv_code_systems,
        ${pvJoin('concept_curie')}        AS pv_concept_identifiers,
        ${pvJoin('terminology_source')}   AS pv_terminology_sources,
        data->>'unit_of_measure'          AS unit_of_measure,
        TRY_CAST(data->>'min_value' AS DOUBLE) AS min_value,
        TRY_CAST(data->>'max_value' AS DOUBLE) AS max_value,
        data->>'cde_origin'               AS cde_origin,
        data->>'population'               AS population,
        data->>'cdisc_domain'             AS cdisc_domain,
        data->>'cdisc_variable_name'      AS cdisc_variable_name,
        data->>'cdisc_variable_label'     AS cdisc_variable_label,
        data->>'references'               AS "references",
        data->>'nlm_identifier'           AS nlm_identifier,
        data->>'dec_identifier'           AS dec_identifier,
        data->>'dec_terminology_source'   AS dec_terminology_source,
        ${arrJoin('$.other_identifiers[*].value')} AS other_identifiers,
        COALESCE(o.origins, data->>'cde_source') AS origins,
        o.origin_keys,
        COALESCE(o.origin_count, 0)       AS origin_count,
        o.study_types,
        COALESCE(o.study_type_count, 0)   AS study_type_count
      FROM rows
      LEFT JOIN origins o ON o.cde_id = CAST(rows.id AS VARCHAR)
    `);

    // ── cde_classification: pivot long-form (one row per CDE×context) to the
    //    wide disease_*/classification_* contract the views expect ────────────
    const ctxCol = (label: string, val: string) =>
      `CASE WHEN data->>'context' = '${label}' THEN ${val} END`;
    await conn.query(`
      CREATE OR REPLACE VIEW cde_classification AS
      SELECT
        id,
        data->>'variable_name'           AS variable_name,
        data->>'version_name'            AS version_name,
        data->>'version_date'            AS version_date,
        data->>'notes'                   AS notes,
        data->>'additional_instructions' AS additional_instructions,
        data->>'domain'                  AS domain,
        data->>'subdomain'               AS subdomain,
        data->>'category'                AS category,
        data->>'working_group'           AS working_group,
        ${ctxCol('Agnostic', `'Y'`)}     AS disease_agnostic,
        ${ctxCol('Neurotrauma', `'Y'`)}  AS disease_neurotrauma,
        ${ctxCol('TBI', `'Y'`)}          AS disease_tbi,
        ${ctxCol('PTE', `'Y'`)}          AS disease_pte,
        ${ctxCol('SCI', `'Y'`)}          AS disease_sci,
        ${ctxCol('Epilepsy', `'Y'`)}     AS disease_epilepsy,
        ${ctxCol('Agnostic', `data->>'tier'`)}    AS classification_agnostic,
        ${ctxCol('Neurotrauma', `data->>'tier'`)} AS classification_neurotrauma,
        ${ctxCol('TBI', `data->>'tier'`)}         AS classification_tbi,
        ${ctxCol('PTE', `data->>'tier'`)}         AS classification_pte,
        ${ctxCol('SCI', `data->>'tier'`)}         AS classification_sci,
        ${ctxCol('Epilepsy', `data->>'tier'`)}    AS classification_epilepsy
      FROM ${jsonSrc(modelFile.cde_classification)}
    `);

    // ── bundle (optional) ────────────────────────────────────────────────────
    if (modelFile.bundle) {
      await conn.query(`
        CREATE OR REPLACE VIEW bundle AS
        SELECT id,
               data->>'bundle_name'   AS bundle_name,
               data->>'description'   AS description,
               data->>'display_name'  AS display_name,
               data->>'domain'        AS domain,
               data->>'subdomain'     AS subdomain,
               data->>'category'      AS category,
               data->>'working_group' AS working_group
        FROM ${jsonSrc(modelFile.bundle)}
      `);
    } else {
      await conn.query(`
        CREATE OR REPLACE VIEW bundle AS SELECT
          CAST(NULL AS VARCHAR) AS id, CAST(NULL AS VARCHAR) AS bundle_name,
          CAST(NULL AS VARCHAR) AS description, CAST(NULL AS VARCHAR) AS display_name,
          CAST(NULL AS VARCHAR) AS domain, CAST(NULL AS VARCHAR) AS subdomain,
          CAST(NULL AS VARCHAR) AS category, CAST(NULL AS VARCHAR) AS working_group
        WHERE false
      `);
    }

    // ── concept: the catalog carries no concept rows yet (current sources have
    //    no dec_identifier); empty stubs matching the app's expected columns ──
    await conn.query(`
      CREATE OR REPLACE VIEW concept AS SELECT
        CAST(NULL AS VARCHAR) AS id, CAST(NULL AS VARCHAR) AS source,
        CAST(NULL AS VARCHAR) AS identifier, CAST(NULL AS VARCHAR) AS preferred_label,
        CAST(NULL AS VARCHAR) AS definition, CAST(NULL AS VARCHAR) AS alt_labels
      WHERE false
    `);
    await conn.query(`
      CREATE OR REPLACE VIEW cde_represents_concept AS SELECT
        CAST(NULL AS VARCHAR) AS cde_id, CAST(NULL AS VARCHAR) AS concept_id,
        CAST(NULL AS VARCHAR) AS role, CAST(NULL AS VARCHAR) AS _source_key
      WHERE false
    `);

    // ── crf: not a catalog model; empty stub so CRF views don't error ────────
    await conn.query(`
      CREATE OR REPLACE VIEW crf AS SELECT
        CAST(NULL AS VARCHAR) AS id, CAST(NULL AS VARCHAR) AS crf_name,
        CAST(NULL AS VARCHAR) AS title, CAST(NULL AS VARCHAR) AS disease_scope,
        CAST(NULL AS VARCHAR) AS items, CAST(NULL AS VARCHAR) AS source,
        CAST(NULL AS VARCHAR) AS version, CAST(NULL AS VARCHAR) AS description
      WHERE false
    `);

    // ── Detect optional classification columns (same pattern as before) ─────
    const clsColsRes = await conn.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'cde_classification'`,
    );
    const clsCols = new Set(
      clsColsRes.toArray().map((r) => String((r.toJSON() as { column_name: string }).column_name)),
    );
    const hasClsDomain = clsCols.has('domain');
    const hasClsSubdomain = clsCols.has('subdomain');
    const hasClsEpilepsy = clsCols.has('disease_epilepsy');

    const domainExpr = hasClsDomain ? 'COALESCE(cl.domain, b.domain)' : 'b.domain';
    const subdomainExpr = hasClsSubdomain
      ? 'COALESCE(cl.subdomain, b.subdomain)'
      : 'b.subdomain';
    const diseaseEpilepsyExpr = hasClsEpilepsy
      ? 'cl.disease_epilepsy'
      : `CAST(NULL AS VARCHAR)`;
    const classificationEpilepsyExpr = hasClsEpilepsy
      ? 'cl.classification_epilepsy'
      : `CAST(NULL AS VARCHAR)`;

    // Denormalized CDE view: ONE ROW PER (canonical CDE × classification ×
    // bundle). A CDE that's classified on N CRFs in M different bundles
    // surfaces as multiple rows here — Tree, Treemap, BundleDetail and
    // CrfDetail all benefit from this. Consumers that want one row per CDE
    // (the /cdes table, Home tiles, Overview counts, name lookups) should
    // query `cde_canonical` instead.
    //
    // Was previously DISTINCT ON the classification + bundle, which silently
    // hid cross-context membership; the model permits multi-context, so the
    // view now exposes it. See docs/standards-alignment.md.
    await conn.query(`
      CREATE OR REPLACE VIEW cde_full AS
      WITH cls_of_cde AS (
        SELECT r.target_id AS cde_id, r.source_id AS cls_id
        FROM relationships r
        WHERE r.type = 'CLASSIFIES'
      ),
      bundle_of_cls AS (
        SELECT r.source_id AS cls_id, r.target_id AS bundle_id
        FROM relationships r
        WHERE r.type = 'PART_OF'
      ),
      sources AS (
        SELECT r.source_id AS cde_id,
               string_agg(p.label, '; ') AS source_labels,
               count(*) AS source_count
        FROM relationships r
        JOIN provenance p ON CAST(p.id AS VARCHAR) = r.target_id
        WHERE r.type = 'SOURCED_FROM'
        GROUP BY r.source_id
      )
      SELECT
        CAST(c.id AS VARCHAR)         AS cde_id,
        k.cls_id                      AS cls_id,
        c.canonical_key,
        c.cde_name,
        c.aliases,
        c.cde_data_type,
        c.cde_definition,
        c.cde_source,
        c.cde_type,
        c.steward_org,
        c.registration_status,
        c.keywords,
        c.preferred_question_text,
        c.pv_labels,
        c.pv_codes,
        c.pv_definitions,
        c.pv_code_systems,
        c.pv_concept_identifiers,
        c.pv_terminology_sources,
        c.unit_of_measure,
        -- CDE-intrinsic fields (moved from cde_classification): they don't
        -- vary per-disease so they belong on the CDE itself.
        c.min_value,
        c.max_value,
        c.cde_origin,
        c.population,
        c.cdisc_domain,
        c.cdisc_variable_name,
        c.cdisc_variable_label,
        c.references AS refs,
        c.nlm_identifier,
        c.dec_identifier,
        c.dec_terminology_source,
        c.other_identifiers,
        c.origins,
        c.origin_keys,
        c.origin_count,
        c.study_types,
        c.study_type_count,
        cl.variable_name,
        cl.version_name,
        cl.version_date,
        cl.notes                      AS classification_notes,
        cl.additional_instructions,
        cl.disease_agnostic,
        cl.disease_neurotrauma,
        cl.disease_tbi,
        cl.disease_pte,
        cl.disease_sci,
        ${diseaseEpilepsyExpr}        AS disease_epilepsy,
        cl.classification_agnostic,
        cl.classification_neurotrauma,
        cl.classification_tbi,
        cl.classification_pte,
        cl.classification_sci,
        ${classificationEpilepsyExpr} AS classification_epilepsy,
        ${domainExpr}    AS cde_domain,
        ${subdomainExpr} AS cde_subdomain,
        -- Canonical hierarchical path: domain / subdomain only. The
        -- "category" column on cde_classification is per-context (almost
        -- always equal to the CRF/form name) and isn't a real CDE-intrinsic
        -- taxonomy level. Bundle's category is a different concept
        -- (bundle-level grouping) and stays on bundle_category.
        NULLIF(
          array_to_string(
            list_filter(
              [${domainExpr}, ${subdomainExpr}],
              x -> x IS NOT NULL AND TRIM(x) != ''
            ),
            ' / '
          ),
          ''
        )                AS cde_path,
        CAST(b.id AS VARCHAR)         AS bundle_id,
        b.bundle_name,
        b.domain                      AS bundle_domain,
        b.subdomain                   AS bundle_subdomain,
        b.category                    AS bundle_category,
        b.working_group               AS bundle_working_group,
        s.source_labels,
        s.source_count
      FROM cde c
      LEFT JOIN cls_of_cde k      ON k.cde_id = CAST(c.id AS VARCHAR)
      LEFT JOIN cde_classification cl ON CAST(cl.id AS VARCHAR) = k.cls_id
      LEFT JOIN bundle_of_cls bc  ON bc.cls_id = k.cls_id
      LEFT JOIN bundle b          ON CAST(b.id AS VARCHAR) = bc.bundle_id
      LEFT JOIN sources s         ON s.cde_id = CAST(c.id AS VARCHAR)
    `);

    // One-row-per-canonical-CDE rollup of cde_full. Classification +
    // bundle fields are aggregated across every context the CDE appears
    // in:
    //   - disease_X = 'Y' if ANY classification has 'Y' for that disease
    //   - classification_X = HIGHEST tier across classifications
    //     (Core > Recommended > Supplemental > Not Applicable)
    //   - bundle_names / bundle_ids / cde_paths = pipe-joined distinct
    //     values across contexts
    //   - bundle_count = how many distinct bundles the CDE appears in
    // Used by the CDE list, Home tiles, Overview counts, and any other
    // surface that wants "one row per CDE" semantics.
    const tierRank = `CASE coalesce(_tier, '')
      WHEN 'Core' THEN 4
      WHEN 'Recommended' THEN 3
      WHEN 'Supplemental' THEN 2
      WHEN 'Not Applicable' THEN 1
      ELSE 0 END`;
    // Build the highest-tier expression for one disease column. We pick
    // the row with the largest tier rank via arg_max, then return its
    // tier string (or NULL if no row had a non-empty tier).
    const highestTier = (col: string) =>
      `NULLIF(arg_max(coalesce(${col}, ''), ${tierRank.replace('_tier', col)}), '')`;
    await conn.query(`
      CREATE OR REPLACE VIEW cde_canonical AS
      SELECT
        cde_id,
        any_value(canonical_key)         AS canonical_key,
        any_value(cde_name)              AS cde_name,
        any_value(aliases)               AS aliases,
        any_value(cde_data_type)         AS cde_data_type,
        any_value(cde_definition)        AS cde_definition,
        any_value(cde_source)            AS cde_source,
        any_value(cde_type)              AS cde_type,
        any_value(steward_org)           AS steward_org,
        any_value(registration_status)   AS registration_status,
        any_value(keywords)              AS keywords,
        any_value(preferred_question_text) AS preferred_question_text,
        any_value(pv_labels)             AS pv_labels,
        any_value(pv_codes)              AS pv_codes,
        any_value(pv_definitions)        AS pv_definitions,
        any_value(pv_code_systems)       AS pv_code_systems,
        any_value(pv_concept_identifiers) AS pv_concept_identifiers,
        any_value(pv_terminology_sources) AS pv_terminology_sources,
        any_value(unit_of_measure)       AS unit_of_measure,
        any_value(min_value)             AS min_value,
        any_value(max_value)             AS max_value,
        any_value(cde_origin)            AS cde_origin,
        any_value(population)            AS population,
        any_value(cdisc_domain)          AS cdisc_domain,
        any_value(cdisc_variable_name)   AS cdisc_variable_name,
        any_value(cdisc_variable_label)  AS cdisc_variable_label,
        any_value(refs)                  AS refs,
        any_value(nlm_identifier)        AS nlm_identifier,
        any_value(dec_identifier)        AS dec_identifier,
        any_value(dec_terminology_source) AS dec_terminology_source,
        any_value(other_identifiers)     AS other_identifiers,
        any_value(origins)               AS origins,
        any_value(origin_keys)           AS origin_keys,
        any_value(origin_count)          AS origin_count,
        any_value(study_types)           AS study_types,
        any_value(study_type_count)      AS study_type_count,
        any_value(source_labels)         AS source_labels,
        any_value(source_count)          AS source_count,
        -- Per-classification field surfaced on the canonical row so per-CDE
        -- consumers (CRF preview, JSON Schema export) can render a stable
        -- variable name. When a CDE varies its variable_name across
        -- contexts, the pipe-joined value preserves the divergence.
        nullif(string_agg(DISTINCT variable_name, '|'), '') AS variable_name,
        -- Disease scope: 'Y' if ANY context flags this disease.
        max(disease_agnostic)            AS disease_agnostic,
        max(disease_neurotrauma)         AS disease_neurotrauma,
        max(disease_tbi)                 AS disease_tbi,
        max(disease_pte)                 AS disease_pte,
        max(disease_sci)                 AS disease_sci,
        max(disease_epilepsy)            AS disease_epilepsy,
        -- Per-disease tier: highest across contexts.
        ${highestTier('classification_agnostic')}     AS classification_agnostic,
        ${highestTier('classification_neurotrauma')}  AS classification_neurotrauma,
        ${highestTier('classification_tbi')}          AS classification_tbi,
        ${highestTier('classification_pte')}          AS classification_pte,
        ${highestTier('classification_sci')}          AS classification_sci,
        ${highestTier('classification_epilepsy')}     AS classification_epilepsy,
        -- Taxonomy: pipe-joined distinct paths across contexts. Single-
        -- context CDEs render as one path; multi-context CDEs surface
        -- their full set so the table can show all alignments.
        nullif(string_agg(DISTINCT cde_domain, '|'), '')      AS cde_domain,
        nullif(string_agg(DISTINCT cde_subdomain, '|'), '')   AS cde_subdomain,
        nullif(string_agg(DISTINCT cde_path, '|'), '')        AS cde_paths,
        -- Bundle attribution: pipe-joined distinct bundles + count.
        nullif(string_agg(DISTINCT bundle_id, '|'), '')       AS bundle_ids,
        nullif(string_agg(DISTINCT bundle_name, '|'), '')     AS bundle_names,
        nullif(string_agg(DISTINCT bundle_domain, '|'), '')   AS bundle_domains,
        nullif(string_agg(DISTINCT bundle_subdomain, '|'), '') AS bundle_subdomains,
        nullif(string_agg(DISTINCT bundle_category, '|'), '') AS bundle_categories,
        nullif(string_agg(DISTINCT bundle_working_group, '|'), '') AS bundle_working_groups,
        count(DISTINCT bundle_id) FILTER (WHERE bundle_id IS NOT NULL) AS bundle_count,
        count(DISTINCT cls_id)    FILTER (WHERE cls_id IS NOT NULL)    AS context_count
      FROM cde_full
      GROUP BY cde_id
    `);

    // Bundle roll-up
    await conn.query(`
      CREATE OR REPLACE VIEW bundle_full AS
      WITH bundle_cde_counts AS (
        SELECT rp.target_id AS bundle_id,
               COUNT(DISTINCT rc.target_id) AS cde_count
        FROM relationships rp
        LEFT JOIN relationships rc
          ON rc.source_id = rp.source_id AND rc.type = 'CLASSIFIES'
        WHERE rp.type = 'PART_OF'
        GROUP BY rp.target_id
      )
      SELECT b.*, COALESCE(bcc.cde_count, 0) AS cde_count
      FROM bundle b
      LEFT JOIN bundle_cde_counts bcc ON bcc.bundle_id = CAST(b.id AS VARCHAR)
    `);

    // ── CDISC Controlled Terminology (NCI EVS, redistributable per
    //    cancer.gov/about-nci/.../cdisc) ─────────────────────────────────────
    // Registered alongside the CDE catalog so the detail drawer can join CDE
    // value lists against published CDASH/SDTM codelists. Tolerant of missing
    // files: if `yarn prepare-data` hasn't run yet the views fall back to
    // empty stubs so the rest of the app stays functional.
    // App-bundled static reference data under /data (independent of the CDE
    // catalog release above); tolerant of absence.
    const dataBase = `${window.location.origin}${import.meta.env.BASE_URL || '/'}data`;
    const ctBase = `${dataBase}/cdisc-ct`;
    let ctRegistered = false;
    for (const name of ['codelist.parquet', 'codelist_item.parquet']) {
      const url = `${ctBase}/${name}`;
      if (!(await fetchWithBinaryCheck(url))) {
        ctRegistered = false;
        break;
      }
      await db.registerFileURL(`__cdisc_ct__${name}`, url, duckdb.DuckDBDataProtocol.HTTP, false);
      ctRegistered = true;
    }
    if (ctRegistered) {
      await conn.query(
        `CREATE OR REPLACE VIEW cdisc_codelist AS SELECT * FROM '__cdisc_ct__codelist.parquet'`,
      );
      await conn.query(
        `CREATE OR REPLACE VIEW cdisc_codelist_item AS SELECT * FROM '__cdisc_ct__codelist_item.parquet'`,
      );
    } else {
      await conn.query(`
        CREATE OR REPLACE VIEW cdisc_codelist AS
        SELECT
          CAST(NULL AS VARCHAR) AS codelist_oid,
          CAST(NULL AS VARCHAR) AS codelist_short_name,
          CAST(NULL AS VARCHAR) AS codelist_nci_code,
          CAST(NULL AS VARCHAR) AS codelist_name,
          CAST(NULL AS VARCHAR) AS data_type,
          CAST(NULL AS BOOLEAN) AS extensible,
          CAST(NULL AS VARCHAR) AS description
        WHERE false
      `);
      await conn.query(`
        CREATE OR REPLACE VIEW cdisc_codelist_item AS
        SELECT
          CAST(NULL AS VARCHAR) AS codelist_oid,
          CAST(NULL AS VARCHAR) AS codelist_short_name,
          CAST(NULL AS VARCHAR) AS coded_value,
          CAST(NULL AS VARCHAR) AS nci_code,
          CAST(NULL AS VARCHAR) AS preferred_term,
          CAST(NULL AS VARCHAR) AS definition,
          CAST(NULL AS VARCHAR) AS synonyms
        WHERE false
      `);
    }

    status.value = 'ready';
    return { db, conn };
  } catch (e) {
    status.value = 'error';
    error.value = e instanceof Error ? e.message : String(e);
    throw e;
  }
}

export function useDuckDB() {
  if (!handlePromise) handlePromise = init();

  async function query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    const { conn } = await handlePromise!;
    if (params && params.length) {
      const stmt = await conn.prepare(sql);
      const res = await stmt.query(...params);
      await stmt.close();
      return res.toArray().map((r) => r.toJSON()) as T[];
    }
    const res = await conn.query(sql);
    return res.toArray().map((r) => r.toJSON()) as T[];
  }

  return {
    status: readonly(status),
    error: readonly(error),
    query,
    ready: () => handlePromise!,
  };
}