import { ref, readonly } from 'vue';
import * as duckdb from '@duckdb/duckdb-wasm';
import { fetchDashboardConfig } from '@/api/dashboardConfig';

type Status = 'idle' | 'loading' | 'ready' | 'error';

interface DuckDBHandle {
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
}

interface SourceManifestEntry {
  key: string;
  label: string;
  study_type?: 'Clinical' | 'Preclinical' | null;
  /** 'sample' = illustrative training dataset; reviewers see a "Sample"
   *  badge so they know feedback won't roll up to a published curation.
   *  Defaults to 'production' for sources that predate the field. */
  kind?: 'sample' | 'production';
  order: number;
  files: string[];
}
interface ManifestDerived {
  concept?: string;
  cde_represents_concept?: string;
}
interface Manifest {
  generated_at: string;
  /** Cache-bust token appended as `?v=` to every parquet URL. */
  version?: string;
  sources: SourceManifestEntry[];
  derived?: ManifestDerived | null;
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

    const base = `${window.location.origin}${import.meta.env.BASE_URL || '/'}data`;

    // ── Load source manifest ────────────────────────────────────────────────
    // `no-cache` forces revalidation so we always pick up the latest data
    // version (and any new sources); the parquet files below are cache-busted
    // via the `?v=` token this manifest carries.
    const manifestRes = await fetch(`${base}/manifest.json`, { cache: 'no-cache' });
    if (!manifestRes.ok) {
      throw new Error(`Missing ${base}/manifest.json — run \`yarn prepare-data\``);
    }
    const manifest = (await manifestRes.json()) as Manifest;
    const allSources = manifest.sources.slice().sort((a, b) => a.order - b.order);
    if (!allSources.length) throw new Error('manifest.json has no sources');

    // Appended to every parquet URL so a redeploy busts the immutable cache.
    const ver = manifest.version ? `?v=${manifest.version}` : '';

    // Operator-controlled source allowlist comes from /v1/dashboard-config
    // (SSM-backed, 60s server-side cache). Empty array (or fetch failure)
    // means "all sources" — permissive default keeps the dashboard usable
    // when the API is briefly unavailable.
    const config = await fetchDashboardConfig();
    const sources = config.enabled_sources.length
      ? allSources.filter((s) => config.enabled_sources.includes(s.key))
      : allSources;
    if (!sources.length) {
      throw new Error(
        'enabled_sources in dashboard-config matches none of the available sources',
      );
    }

    // ── Register each source's parquets with namespaced file IDs ────────────
    // DuckDB references registered files by name; we register as
    // `<sourceKey>__<model>.parquet` so the URLs resolve to per-source subdirs.
    const perModelPresence: Record<string, string[]> = {};
    for (const s of sources) {
      for (const f of s.files) {
        const fileId = `${s.key}__${f}`;
        const url = `${base}/${s.key}/${f}${ver}`;
        if (!(await fetchWithBinaryCheck(url))) continue;
        await db.registerFileURL(fileId, url, duckdb.DuckDBDataProtocol.HTTP, false);
        const model = f.replace(/\.parquet$/, '');
        if (!perModelPresence[model]) perModelPresence[model] = [];
        perModelPresence[model].push(fileId);
      }
    }

    // ── Register derived global parquets ────────────────────────────────────
    // The concept registry is a single global file (not per-source) because
    // multiple sources contribute to the same concept records. Manifest
    // omits the section when no source contributed concepts.
    const derivedFileIds: { concept?: string; cde_represents_concept?: string } = {};
    if (manifest.derived) {
      for (const [model, fileName] of Object.entries(manifest.derived)) {
        if (!fileName) continue;
        const fileId = `__derived__${fileName}`;
        const url = `${base}/${fileName}${ver}`;
        if (!(await fetchWithBinaryCheck(url))) continue;
        await db.registerFileURL(fileId, url, duckdb.DuckDBDataProtocol.HTTP, false);
        derivedFileIds[model as keyof typeof derivedFileIds] = fileId;
      }
    }

    // Build `UNION ALL BY NAME` view for a model across the sources that have it.
    // Columns that exist in only some sources become NULL for the rest.
    const unionSql = (fileIds: string[]) =>
      fileIds.map((id) => `SELECT * FROM '${id}'`).join('\nUNION ALL BY NAME\n');

    // ── Required models ─────────────────────────────────────────────────────
    if (!perModelPresence.cde?.length) throw new Error('No cde.parquet files loaded');
    if (!perModelPresence.cde_classification?.length)
      throw new Error('No cde_classification.parquet files loaded');
    if (!perModelPresence.provenance?.length)
      throw new Error('No provenance.parquet files loaded');
    if (!perModelPresence.relationships?.length)
      throw new Error('No relationships.parquet files loaded');

    // Raw per-source unions (every row carries _source_key and _source_order).
    await conn.query(`CREATE OR REPLACE VIEW cde_raw AS ${unionSql(perModelPresence.cde)}`);
    await conn.query(
      `CREATE OR REPLACE VIEW cde_classification AS ${unionSql(perModelPresence.cde_classification)}`,
    );
    await conn.query(
      `CREATE OR REPLACE VIEW provenance AS ${unionSql(perModelPresence.provenance)}`,
    );
    await conn.query(
      `CREATE OR REPLACE VIEW relationships_raw AS ${unionSql(perModelPresence.relationships)}`,
    );

    // ── Optional: CRF ───────────────────────────────────────────────────────
    if (perModelPresence.crf?.length) {
      await conn.query(`CREATE OR REPLACE VIEW crf AS ${unionSql(perModelPresence.crf)}`);
    }

    // ── Optional: Bundle ────────────────────────────────────────────────────
    if (perModelPresence.bundle?.length) {
      await conn.query(`CREATE OR REPLACE VIEW bundle AS ${unionSql(perModelPresence.bundle)}`);
    } else {
      // Empty stub so downstream SQL keeps working without branching.
      await conn.query(`
        CREATE OR REPLACE VIEW bundle AS
        SELECT
          CAST(NULL AS VARCHAR) AS id,
          CAST(NULL AS VARCHAR) AS bundle_name,
          CAST(NULL AS VARCHAR) AS description,
          CAST(NULL AS VARCHAR) AS display_name,
          CAST(NULL AS VARCHAR) AS domain,
          CAST(NULL AS VARCHAR) AS subdomain,
          CAST(NULL AS VARCHAR) AS category,
          CAST(NULL AS VARCHAR) AS working_group,
          CAST(NULL AS VARCHAR) AS _source_key,
          CAST(NULL AS INTEGER) AS _source_order
        LIMIT 0
      `);
    }

    // ── Source-label lookup (in-memory, from manifest) ──────────────────────
    const sourceLabelsUnion = sources
      .map((s) => {
        const studyType =
          s.study_type === 'Clinical' || s.study_type === 'Preclinical'
            ? `'${s.study_type}'`
            : 'CAST(NULL AS VARCHAR)';
        const kind = s.kind === 'sample' ? "'sample'" : "'production'";
        return `SELECT '${s.key.replace(/'/g, "''")}' AS source_key, '${s.label.replace(/'/g, "''")}' AS label, ${s.order} AS ord, ${studyType} AS study_type, ${kind} AS kind`;
      })
      .join('\nUNION ALL\n');
    await conn.query(
      `CREATE OR REPLACE VIEW source_labels AS ${sourceLabelsUnion}`,
    );

    // ── Canonical CDE reconciliation ────────────────────────────────────────
    // Match CDEs across sources primarily by nlm_identifier, then dec_identifier,
    // then normalized cde_name. A CDE that appears in multiple sources becomes
    // one canonical row; its origins are aggregated as a pipe-joined label list.
    await conn.query(`
      CREATE OR REPLACE VIEW cde_keyed AS
      SELECT *,
        COALESCE(
          NULLIF(TRIM(nlm_identifier), ''),
          NULLIF(TRIM(dec_identifier), ''),
          'name:' || LOWER(TRIM(REGEXP_REPLACE(cde_name, '[^a-zA-Z0-9]+', ' ', 'g')))
        ) AS canonical_key
      FROM cde_raw
    `);

    // For each (per-source) cde_id, compute the canonical id (first-source wins).
    await conn.query(`
      CREATE OR REPLACE VIEW cde_id_map AS
      SELECT
        id AS original_id,
        FIRST_VALUE(id) OVER (
          PARTITION BY canonical_key ORDER BY _source_order
        ) AS canonical_id,
        canonical_key,
        _source_key
      FROM cde_keyed
    `);

    // Canonical CDE rows: one per canonical_key, built by taking the first
    // NON-NULL value per column across all source rows, ordered by
    // _source_order. arg_min(col, _source_order) ignores rows where col IS
    // NULL, so a sparse field that's only populated on a lower-priority
    // source (e.g. NLM's `registration_status` when NINDS is "first") still
    // makes it onto the canonical row. When two sources both set the same
    // field, the higher-priority one (lower _source_order) wins.
    await conn.query(`
      CREATE OR REPLACE VIEW cde AS
      WITH origins AS (
        -- string_agg without ORDER BY is non-deterministic (origins can flip
        -- between "A · B" and "B · A" between queries). Aggregate via array
        -- → sort → join so the displayed list is stable.
        SELECT k.canonical_key,
               array_to_string(
                 array_sort(array_agg(DISTINCT COALESCE(sl.label, k._source_key))),
                 ' · '
               ) AS origins,
               array_to_string(
                 array_sort(array_agg(DISTINCT k._source_key)),
                 ','
               ) AS origin_keys,
               count(DISTINCT k._source_key) AS origin_count,
               array_to_string(
                 array_sort(array_agg(DISTINCT k._study_type)),
                 ','
               ) AS study_types,
               count(DISTINCT k._study_type) AS study_type_count
        FROM cde_keyed k
        LEFT JOIN source_labels sl ON sl.source_key = k._source_key
        GROUP BY k.canonical_key
      ),
      canonical AS (
        SELECT canonical_key,
               arg_min(COLUMNS(* EXCLUDE (canonical_key, _source_order)), _source_order)
        FROM cde_keyed
        GROUP BY canonical_key
      )
      SELECT c.*,
             o.origins,
             o.origin_keys,
             o.origin_count,
             o.study_types,
             o.study_type_count
      FROM canonical c
      LEFT JOIN origins o USING (canonical_key)
    `);

    // Remap CLASSIFIES relationships to point at the canonical CDE id.
    // Other relationship types (PART_OF, SOURCED_FROM) are kept as-is.
    // All id columns can arrive as UUID or VARCHAR depending on source. Cast
    // target_id to VARCHAR so downstream joins against c.id / b.id / p.id (also
    // cast below) compare cleanly.
    await conn.query(`
      CREATE OR REPLACE VIEW relationships AS
      SELECT
        CAST(r.source_id AS VARCHAR) AS source_id,
        CASE WHEN r.type = 'CLASSIFIES'
             THEN COALESCE(CAST(m.canonical_id AS VARCHAR), CAST(r.target_id AS VARCHAR))
             ELSE CAST(r.target_id AS VARCHAR)
        END AS target_id,
        r.type,
        r._source_key
      FROM relationships_raw r
      LEFT JOIN cde_id_map m ON CAST(m.original_id AS VARCHAR) = CAST(r.target_id AS VARCHAR)
    `);

    // ── Concept registry (derived global) ───────────────────────────────────
    // First-class concept entity + cde→concept relationship, derived at
    // data-prep time from NLM dec_identifier columns. Empty stub views so
    // downstream SQL can JOIN unconditionally even when no source carried
    // dec_identifier (fully NINDS- or demo-only loadouts).
    if (derivedFileIds.concept) {
      await conn.query(
        `CREATE OR REPLACE VIEW concept AS SELECT * FROM '${derivedFileIds.concept}'`,
      );
    } else {
      await conn.query(`
        CREATE OR REPLACE VIEW concept AS
        SELECT
          CAST(NULL AS VARCHAR) AS id,
          CAST(NULL AS VARCHAR) AS source,
          CAST(NULL AS VARCHAR) AS identifier,
          CAST(NULL AS VARCHAR) AS preferred_label,
          CAST(NULL AS VARCHAR) AS definition,
          CAST(NULL AS VARCHAR) AS alt_labels
        WHERE false
      `);
    }
    if (derivedFileIds.cde_represents_concept) {
      // Remap cde_id through the canonical-id map so concept lookups land on
      // the picked-source CDE row, matching the cde view's identity.
      await conn.query(`
        CREATE OR REPLACE VIEW cde_represents_concept AS
        SELECT
          COALESCE(CAST(m.canonical_id AS VARCHAR), CAST(r.cde_id AS VARCHAR)) AS cde_id,
          r.concept_id,
          r.role,
          r._source_key
        FROM '${derivedFileIds.cde_represents_concept}' r
        LEFT JOIN cde_id_map m ON CAST(m.original_id AS VARCHAR) = CAST(r.cde_id AS VARCHAR)
      `);
    } else {
      await conn.query(`
        CREATE OR REPLACE VIEW cde_represents_concept AS
        SELECT
          CAST(NULL AS VARCHAR) AS cde_id,
          CAST(NULL AS VARCHAR) AS concept_id,
          CAST(NULL AS VARCHAR) AS role,
          CAST(NULL AS VARCHAR) AS _source_key
        WHERE false
      `);
    }

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
    const ctBase = `${base}/cdisc-ct`;
    let ctRegistered = false;
    for (const name of ['codelist.parquet', 'codelist_item.parquet']) {
      const url = `${ctBase}/${name}${ver}`;
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