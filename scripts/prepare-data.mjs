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

// Default precedence when scanning: demo first (more curated), NINDS second.
// The raw pennsieve-discover export has a data-quality issue (junk
// `nlm_identifier` values like "UMLS|UMLS|UMLS") that prevents the
// canonical-key reconciler from matching it cleanly, so it's opt-in only —
// pass it explicitly on the CLI when you want it included.
const DEFAULT_SOURCE_DIRS = ['data/demo', 'data/ninds-epilepsy'];

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
  const fallback = { key: basename(sourceDir), label: basename(sourceDir), studyType: null };
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
      order: i,
      files: files.map((n) => `${n}.parquet`),
    });
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    sources: manifestSources,
  };
  writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n→ manifest.json  (${manifestSources.length} sources)`);

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