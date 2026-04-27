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
  order: number;
  files: string[];
}
interface Manifest {
  generated_at: string;
  sources: SourceManifestEntry[];
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
    const manifestRes = await fetch(`${base}/manifest.json`);
    if (!manifestRes.ok) {
      throw new Error(`Missing ${base}/manifest.json — run \`yarn prepare-data\``);
    }
    const manifest = (await manifestRes.json()) as Manifest;
    const allSources = manifest.sources.slice().sort((a, b) => a.order - b.order);
    if (!allSources.length) throw new Error('manifest.json has no sources');

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
        const url = `${base}/${s.key}/${f}`;
        if (!(await fetchWithBinaryCheck(url))) continue;
        await db.registerFileURL(fileId, url, duckdb.DuckDBDataProtocol.HTTP, false);
        const model = f.replace(/\.parquet$/, '');
        if (!perModelPresence[model]) perModelPresence[model] = [];
        perModelPresence[model].push(fileId);
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
          CAST(NULL AS VARCHAR) AS disease_scope,
          CAST(NULL AS VARCHAR) AS source,
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
        return `SELECT '${s.key.replace(/'/g, "''")}' AS source_key, '${s.label.replace(/'/g, "''")}' AS label, ${s.order} AS ord, ${studyType} AS study_type`;
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

    // Canonical CDE rows: one per canonical_key, picking the first-source row,
    // with origins aggregated across all contributing sources.
    await conn.query(`
      CREATE OR REPLACE VIEW cde AS
      WITH picked AS (
        SELECT * FROM (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY canonical_key ORDER BY _source_order
          ) AS rn
          FROM cde_keyed
        ) WHERE rn = 1
      ),
      origins AS (
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
      )
      SELECT p.* EXCLUDE (rn),
             o.origins,
             o.origin_keys,
             o.origin_count,
             o.study_types,
             o.study_type_count
      FROM picked p
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

    // ── Detect optional classification columns (same pattern as before) ─────
    const clsColsRes = await conn.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'cde_classification'`,
    );
    const clsCols = new Set(
      clsColsRes.toArray().map((r) => String((r.toJSON() as { column_name: string }).column_name)),
    );
    const hasClsDomain = clsCols.has('domain');
    const hasClsSubdomain = clsCols.has('subdomain');
    const hasClsCategory = clsCols.has('category');
    const hasClsEpilepsy = clsCols.has('disease_epilepsy');

    const domainExpr = hasClsDomain ? 'COALESCE(cl.domain, b.domain)' : 'b.domain';
    const subdomainExpr = hasClsSubdomain
      ? 'COALESCE(cl.subdomain, b.subdomain)'
      : 'b.subdomain';
    const categoryExpr = hasClsCategory
      ? 'COALESCE(cl.category, b.category)'
      : 'b.category';
    const diseaseEpilepsyExpr = hasClsEpilepsy
      ? 'cl.disease_epilepsy'
      : `CAST(NULL AS VARCHAR)`;
    const classificationEpilepsyExpr = hasClsEpilepsy
      ? 'cl.classification_epilepsy'
      : `CAST(NULL AS VARCHAR)`;

    // Denormalized CDE view — same shape as before, but `relationships` now
    // points at canonical CDE ids, and `cde` is the deduplicated canonical view.
    await conn.query(`
      CREATE OR REPLACE VIEW cde_full AS
      WITH cls_of_cde AS (
        SELECT DISTINCT ON (r.target_id) r.target_id AS cde_id, r.source_id AS cls_id
        FROM relationships r
        WHERE r.type = 'CLASSIFIES'
      ),
      bundle_of_cls AS (
        SELECT DISTINCT ON (r.source_id) r.source_id AS cls_id, r.target_id AS bundle_id
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
        c.canonical_key,
        c.cde_name,
        c.cde_data_type,
        c.cde_definition,
        c.cde_source,
        c.cde_type,
        c.keywords,
        c.preferred_question_text,
        c.pv_labels,
        c.pv_codes,
        c.pv_definitions,
        c.pv_code_systems,
        c.pv_concept_identifiers,
        c.pv_terminology_sources,
        c.pv_uri,
        c.unit_of_measure,
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
        cl.cdisc_domain,
        cl.cdisc_variable_name,
        cl.cdisc_variable_label,
        cl.cde_origin,
        cl.version_name,
        cl.version_date,
        cl.min_value,
        cl.max_value,
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
        ${categoryExpr}  AS cde_category,
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