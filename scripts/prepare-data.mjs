#!/usr/bin/env node
// Reads one or more Pennsieve-format exports (JSONL records + relationships.csv)
// and emits per-source Parquet files into public/data/<sourceKey>/ for the
// browser DuckDB-WASM runtime. Also writes public/data/manifest.json listing
// the loaded sources so the dashboard can union them at query time.
//
// Usage:
//   node scripts/prepare-data.mjs [sourceDir1 sourceDir2 …]
//
// With no args, loads every source dir at the repo root that contains a
// metadata/ subdirectory (so adding a new extraction is purely filesystem).
// Source order determines precedence when reconciling duplicate CDEs across
// sources: the first source listed wins for name/definition/etc.

import duckdb from 'duckdb';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'public/data');
const TMP = resolve(tmpdir(), 'cde-prep');

// Default load order. Source order matters for canonical-key reconciliation:
// when two sources contribute records that collapse to the same canonical
// key, the first-listed source wins for display fields. NT-PRECEDS demo is
// the most curated (bundles + classifications), so it leads. NINDS Epilepsy
// has the largest disease-specific catalog. NLM and PTE Clinical follow
// because they overlap with NINDS for some CDEs.
//
// The pennsieve-discover export has a data-quality issue (junk
// `nlm_identifier` values like "UMLS|UMLS|UMLS") that prevents the
// canonical-key reconciler from matching it cleanly, so it's opt-in only —
// pass it explicitly on the CLI when you want it included.
// Order matters: lower index = higher priority during canonical CDE
// reconciliation (per-column "first non-null" wins). NLM precedes NINDS so
// NLM-only fields (registration_status, aliases, etc.) survive on the
// canonical row even when NINDS also matches the same canonical_key.
const DEFAULT_SOURCE_DIRS = [
  'data/demo',
  'data/nlm-ninds-disease-epilepsy',
  'data/ninds-epilepsy',
  'data/pte-clinical-2',
  // CURE Epilepsy SUDEP Preclinical CDEs (7 module workbooks → 7 CRFs).
  // Listed last: established clinical sources win display fields on any
  // canonical-key overlap; the preclinical SUDEP set adds its own contexts.
  'data/cure-sudep',
];

const cliArgs = process.argv.slice(2);
const sourceDirs = (cliArgs.length ? cliArgs : DEFAULT_SOURCE_DIRS)
  .map((d) => resolve(ROOT, d))
  .filter((p) => {
    if (!existsSync(resolve(p, 'metadata'))) {
      if (cliArgs.includes(basename(p))) {
        console.warn(`  ⚠  ${p} has no metadata/ subdirectory, skipping`);
      }
      return false;
    }
    return true;
  });

if (!sourceDirs.length) {
  console.error('No source directories found with a metadata/ subdirectory.');
  process.exit(1);
}

console.log(`Sources (${sourceDirs.length}):`);
for (const d of sourceDirs) console.log(`  · ${basename(d)}`);

mkdirSync(OUT, { recursive: true });
// Wipe previous per-source subdirs so removed sources disappear.
for (const f of readdirSync(OUT)) {
  const p = resolve(OUT, f);
  try {
    if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
    else rmSync(p, { force: true });
  } catch {}
}
mkdirSync(TMP, { recursive: true });

// The source JSONL sometimes has a double-escaping bug: literal `\\"` where
// `\"` was meant. Re-parse each line leniently and re-emit valid NDJSON.
function cleanJsonl(srcPath, destPath) {
  const text = readFileSync(srcPath, 'utf8');
  const lines = text.split('\n');
  const out = [];
  let fixed = 0;
  let dropped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.stringify(JSON.parse(line)));
    } catch {
      const patched = line.replace(/\\\\"/g, '\\"');
      try {
        out.push(JSON.stringify(JSON.parse(patched)));
        fixed++;
      } catch {
        dropped++;
      }
    }
  }
  writeFileSync(destPath, out.join('\n'));
  return { total: out.length, fixed, dropped };
}

const db = new duckdb.Database(':memory:');
const conn = db.connect();

const run = (sql) =>
  new Promise((res, rej) => conn.run(sql, (err) => (err ? rej(err) : res())));
const all = (sql) =>
  new Promise((res, rej) => conn.all(sql, (err, rows) => (err ? rej(err) : res(rows))));

// read_json_auto infers JSON type for columns that are null in every record.
// That breaks string ops like LOWER(coalesce(col, '')) downstream. For models
// whose schema treats these columns as strings, coerce JSON → VARCHAR.
const STRING_TYPED_MODELS = new Set(['cde', 'cde_classification', 'provenance', 'crf']);

// Columns that are genuinely structured (not strings) — keep them as JSON text
// (VARCHAR holding JSON). Casting to JSON text normalizes across sources whose
// STRUCT schemas diverge (e.g. demo CRFs have `{type,label,instructions,ref}`
// items; NINDS CRFs have just `{type,ref}`), so UNION ALL BY NAME can merge.
const JSON_TEXT_COLUMNS = {
  crf: new Set(['items']),
};

function sourceSubquery(jsonFile) {
  return `(SELECT id, data.* FROM read_json_auto('${jsonFile}', format='newline_delimited', maximum_object_size=16777216))`;
}

async function buildSelectList(jsonFile, modelName) {
  const desc = await all(`DESCRIBE SELECT * FROM ${sourceSubquery(jsonFile)}`);
  const coerceJson = STRING_TYPED_MODELS.has(modelName);
  const jsonTextCols = JSON_TEXT_COLUMNS[modelName] ?? new Set();
  return desc
    .map((c) => {
      if (jsonTextCols.has(c.column_name)) {
        return `to_json("${c.column_name}") AS "${c.column_name}"`;
      }
      if (coerceJson && c.column_type === 'JSON') {
        return `CAST("${c.column_name}" AS VARCHAR) AS "${c.column_name}"`;
      }
      return `"${c.column_name}"`;
    })
    .join(', ');
}

const MODELS = [
  { name: 'cde', optional: false },
  { name: 'cde_classification', optional: false },
  { name: 'bundle', optional: true },
  { name: 'provenance', optional: false },
  { name: 'crf', optional: true },
];

/** Read the provenance record from a source dir to derive its sourceKey/label/study_type. */
function readProvenance(sourceDir) {
  const fallback = { key: basename(sourceDir), label: basename(sourceDir), studyType: null, kind: 'production' };
  const p = resolve(sourceDir, 'metadata/models/provenance/versions/1/records.jsonl');
  if (!existsSync(p)) return fallback;
  const first = readFileSync(p, 'utf8').split('\n').find((l) => l.trim());
  if (!first) return fallback;
  try {
    const rec = JSON.parse(first);
    return {
      key: rec.data?.source_key ?? fallback.key,
      label: rec.data?.label ?? fallback.label,
      studyType: rec.data?.study_type ?? null,
      kind: rec.data?.kind === 'sample' ? 'sample' : 'production',
    };
  } catch {
    return fallback;
  }
}

async function emitSource(sourceDir, prov, order) {
  const { key: sourceKey, studyType } = prov;
  const meta = resolve(sourceDir, 'metadata');
  const outDir = resolve(OUT, sourceKey);
  mkdirSync(outDir, { recursive: true });

  // `study_type` is declared once per source on the provenance record; we stamp
  // it onto every row in every model so filters are a straight WHERE _study_type
  // = … with no join. A null here is escaped as SQL NULL (not the string 'null').
  const studyTypeSql = studyType === null || studyType === undefined
    ? 'CAST(NULL AS VARCHAR)'
    : `'${String(studyType).replace(/'/g, "''")}'`;

  const modelsEmitted = [];
  for (const { name, optional } of MODELS) {
    const src = resolve(meta, `models/${name}/versions/1/records.jsonl`);
    if (!existsSync(src)) {
      if (optional) continue;
      throw new Error(`Missing required model source: ${src}`);
    }
    const cleaned = resolve(TMP, `${sourceKey}__${name}.jsonl`);
    const { total, fixed, dropped } = cleanJsonl(src, cleaned);
    const dest = resolve(outDir, `${name}.parquet`);
    console.log(
      `  → ${sourceKey}/${name}.parquet  (${total}${fixed ? `, ${fixed} fixed` : ''}${dropped ? `, ${dropped} dropped` : ''})`,
    );
    const selectList = await buildSelectList(cleaned, name);
    await run(`
      COPY (
        SELECT ${selectList},
               '${sourceKey}' AS _source_key,
               ${order}        AS _source_order,
               ${studyTypeSql} AS _study_type
        FROM ${sourceSubquery(cleaned)}
      ) TO '${dest}' (FORMAT 'parquet', COMPRESSION 'zstd');
    `);
    modelsEmitted.push(name);
  }

  // Relationships CSV
  const relSrc = resolve(meta, 'relationships.csv');
  if (existsSync(relSrc)) {
    const relDest = resolve(outDir, 'relationships.parquet');
    console.log(`  → ${sourceKey}/relationships.parquet`);
    await run(`
      COPY (
        SELECT
          source_record_id AS source_id,
          target_record_id AS target_id,
          relationship_type AS type,
          '${sourceKey}' AS _source_key,
          ${studyTypeSql} AS _study_type
        FROM read_csv_auto('${relSrc}', header=true)
      ) TO '${relDest}' (FORMAT 'parquet', COMPRESSION 'zstd');
    `);
    modelsEmitted.push('relationships');
  }

  return modelsEmitted;
}

/**
 * Derive a global concept registry from CDE rows that carry NLM Data Element
 * Concept identifiers (`dec_identifier` + `dec_terminology_source`).
 *
 * We split each pipe-joined column into individual concept references, then
 * build:
 *   - public/data/concept.parquet — one row per distinct (source, identifier)
 *     with placeholder enrichment columns (Phase 4 fills these from FHIR
 *     terminology services).
 *   - public/data/cde_represents_concept.parquet — relationship rows that
 *     link each CDE to every concept it carries an identifier for. The
 *     `role` column defaults to 'primary'; later phases let curators set
 *     'unit' / 'qualifier' / 'other' for supporting elements.
 *
 * NINDS CDEs and NT-PRECEDS demo records don't ship `dec_identifier`, so
 * they end up unmapped here. The Phase 3 curation tool will be the path to
 * cover those manually.
 *
 * Both parquets sit at the data root (sibling to manifest.json), not under
 * a per-source subdir, because concepts are inherently a derived global
 * registry — multiple sources contribute to the same concept records.
 */
async function emitConceptRegistry() {
  const cdeGlob = resolve(OUT, '**', 'cde.parquet').replace(/\\/g, '/');
  const conceptParquet = resolve(OUT, 'concept.parquet');
  const relParquet = resolve(OUT, 'cde_represents_concept.parquet');

  // Probe whether any source actually carries dec_identifier — pass through
  // a single TRY-shaped query to avoid blowing up on sources without the
  // column (NINDS-only loadouts, demo runs).
  let hasDec = false;
  let hasDecName = false;
  try {
    const cols = await all(
      `SELECT column_name FROM (DESCRIBE SELECT * FROM read_parquet('${cdeGlob}', union_by_name=true) LIMIT 0)`,
    );
    const set = new Set(cols.map((c) => c.column_name));
    hasDec = set.has('dec_identifier') && set.has('dec_terminology_source');
    hasDecName = set.has('dec_name');
  } catch {
    hasDec = false;
  }
  if (!hasDec) {
    console.log('  (skipping concept registry — no dec_identifier in any source)');
    return null;
  }

  // dec_name was added to fetch-nlm-cde.mjs after the initial extraction
  // shipped — older parquets don't have it. SQL coalesces against an empty
  // string when missing so the splitting/pairing logic is the same shape.
  const decNameSelect = hasDecName
    ? `string_split(COALESCE(dec_name, ''), '|') AS names`
    : `CAST(NULL AS VARCHAR[]) AS names`;

  // Pair pipe-joined identifier + source + name columns positionally so we
  // don't cross-product. range(1, len+1) materializes the indices; we pluck
  // each array at the same position so the alignment matches what
  // fetch-nlm-cde emitted. Concept stable ID is a slug of source+identifier
  // so the same concept across sources produces the same registry row.
  await run(`
    CREATE OR REPLACE VIEW _cde_concept_pairs AS
    WITH split AS (
      SELECT
        id AS cde_id,
        _source_key,
        string_split(dec_identifier, '|') AS ids,
        string_split(dec_terminology_source, '|') AS srcs,
        ${decNameSelect}
      FROM read_parquet('${cdeGlob}', union_by_name=true)
      WHERE dec_identifier IS NOT NULL AND TRIM(dec_identifier) != ''
    ),
    paired AS (
      SELECT
        cde_id,
        _source_key,
        TRIM(ids[i]) AS identifier,
        TRIM(srcs[i]) AS source,
        TRIM(COALESCE(names[i], '')) AS name
      FROM split, range(1, COALESCE(len(ids), 0) + 1) AS r(i)
    )
    SELECT
      cde_id,
      _source_key,
      identifier,
      source,
      NULLIF(name, '') AS preferred_label,
      LOWER(REGEXP_REPLACE(source || '_' || identifier, '[^a-zA-Z0-9]+', '_', 'g')) AS concept_id
    FROM paired
    WHERE identifier IS NOT NULL AND identifier != ''
      AND source IS NOT NULL AND source != ''
  `);

  // `cui` is the UMLS Concept Unique Identifier (e.g. "C0001779" for Age).
  // UMLS's Metathesaurus is the canonical backbone for concept identity in
  // NLM-land — it lets a single CUI collapse multiple (source, identifier)
  // mappings (LOINC, SNOMED CT, caDSR, …) to one semantic entity. We seed
  // it as NULL here; the Phase 4 UTS-cache fills it via the UMLS API and
  // lets downstream features group by CUI when present.
  // Layered concept registry:
  //   1. _base — derived from CDE rows (concept_id, source, identifier,
  //      and the in-record dec_name when fetch-nlm-cde captured it).
  //   2. enrichment.json (data/concept-enrichment.json, written by
  //      scripts/enrich-concepts.mjs) — overrides preferred_label/definition/
  //      cui/alt_labels with values pulled from external services. We LEFT
  //      JOIN so concepts without enrichment fall back to the in-record
  //      label (or null when neither exists).
  const enrichmentPath = resolve(ROOT, 'data/concept-enrichment.json');
  const hasEnrichment = existsSync(enrichmentPath);
  if (hasEnrichment) {
    // DuckDB can read JSON via read_json_auto, but the cache shape is a
    // nested map keyed by concept_id. Flatten it to a JSONL file in TMP
    // so DuckDB can ingest as a table.
    const cache = JSON.parse(readFileSync(enrichmentPath, 'utf8'));
    const rows = Object.entries(cache.concepts ?? {}).map(([id, v]) => ({
      id,
      preferred_label: v.preferred_label ?? null,
      definition: v.definition ?? null,
      cui: v.cui ?? null,
      alt_labels: v.alt_labels ?? null,
    }));
    const enrichmentJsonl = resolve(TMP, 'concept-enrichment.jsonl');
    writeFileSync(enrichmentJsonl, rows.map((r) => JSON.stringify(r)).join('\n'));
    await run(`
      CREATE OR REPLACE VIEW _concept_enrichment AS
      SELECT * FROM read_json_auto('${enrichmentJsonl}', format='newline_delimited')
    `);
    console.log(`  (loaded enrichment for ${rows.length} concepts)`);
  } else {
    await run(`
      CREATE OR REPLACE VIEW _concept_enrichment AS
      SELECT
        CAST(NULL AS VARCHAR) AS id,
        CAST(NULL AS VARCHAR) AS preferred_label,
        CAST(NULL AS VARCHAR) AS definition,
        CAST(NULL AS VARCHAR) AS cui,
        CAST(NULL AS VARCHAR) AS alt_labels
      WHERE false
    `);
  }

  // Multiple CDEs may carry the same concept identifier with slightly
  // different `preferred_label` values (caDSR sometimes serves variants
  // through different DataElement entries). max(preferred_label) per
  // concept_id is a deterministic pick — alphabetically last non-null.
  // The enrichment cache wins over the in-record label whenever both exist.
  await run(`
    COPY (
      WITH base AS (
        SELECT
          concept_id AS id,
          any_value(source) AS source,
          any_value(identifier) AS identifier,
          max(preferred_label) AS in_record_label
        FROM _cde_concept_pairs
        GROUP BY concept_id
      )
      SELECT
        b.id,
        b.source,
        b.identifier,
        e.cui                                           AS cui,
        COALESCE(e.preferred_label, b.in_record_label)  AS preferred_label,
        e.definition                                    AS definition,
        e.alt_labels                                    AS alt_labels
      FROM base b
      LEFT JOIN _concept_enrichment e ON e.id = b.id
    ) TO '${conceptParquet}' (FORMAT 'parquet', COMPRESSION 'zstd');
  `);
  await run(`
    COPY (
      SELECT
        cde_id,
        concept_id,
        'primary' AS role,
        _source_key
      FROM _cde_concept_pairs
    ) TO '${relParquet}' (FORMAT 'parquet', COMPRESSION 'zstd');
  `);

  const [{ n: conceptCount }] = await all(
    `SELECT count(*) AS n FROM read_parquet('${conceptParquet}')`,
  );
  const [{ n: relCount }] = await all(
    `SELECT count(*) AS n FROM read_parquet('${relParquet}')`,
  );
  console.log(`\n→ concept.parquet                  (${conceptCount} distinct concepts)`);
  console.log(`→ cde_represents_concept.parquet  (${relCount} relationships)`);
  return { conceptCount: Number(conceptCount), relCount: Number(relCount) };
}

async function main() {
  const manifestSources = [];
  for (let i = 0; i < sourceDirs.length; i++) {
    const dir = sourceDirs[i];
    const prov = readProvenance(dir);
    console.log(`\n[${i + 1}/${sourceDirs.length}] ${prov.label}  (${prov.key}${prov.studyType ? `, ${prov.studyType}` : ''})`);
    const files = await emitSource(dir, prov, i);
    manifestSources.push({
      key: prov.key,
      label: prov.label,
      study_type: prov.studyType,
      kind: prov.kind,
      order: i,
      files: files.map((n) => `${n}.parquet`),
    });
  }

  // Derive global concept registry from any source that carries dec_identifier.
  const conceptStats = await emitConceptRegistry();

  const generatedAt = new Date().toISOString();
  const manifest = {
    generated_at: generatedAt,
    // Cache-bust token: the parquet filenames are stable, so the dashboard
    // appends `?v=<version>` to every parquet URL it registers. manifest.json
    // itself must always revalidate (see amplify.yml) so this stays fresh.
    version: generatedAt.replace(/\D/g, ''),
    sources: manifestSources,
    // Derived globals — top-level files, not per-source. Optional; the
    // dashboard treats absence as "concept layer not built".
    derived: conceptStats
      ? {
          concept: 'concept.parquet',
          cde_represents_concept: 'cde_represents_concept.parquet',
        }
      : null,
  };
  writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n→ manifest.json  (${manifestSources.length} sources${conceptStats ? `, ${conceptStats.conceptCount} concepts` : ''})`);

  conn.close();
  db.close(() => {
    try { rmSync(TMP, { recursive: true, force: true }); } catch {}
    console.log('Done.');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});