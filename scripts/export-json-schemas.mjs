// Export the dashboard's internal parquet models as JSON Schema (draft
// 2020-12) documents. Intended audience: external producers (Pennsieve,
// upstream curation tools) that need a contract for what shape the
// dashboard expects on ingest.
//
// For each model in MODELS:
//   1. Pull `required` from any source's metadata/models/{m}/versions/1/
//      schema.json (the fetch scripts write these per-model).
//   2. DESCRIBE the union of every source's parquet for that model so the
//      property list reflects the on-disk schema, not a stale TS type.
//   3. Map DuckDB column types to JSON Schema types.
//   4. Strip pipeline-internal columns (`_source_key`, `_source_order`,
//      `_study_type`) since external producers don't supply those.
//   5. Emit schemas/{model}.schema.json.
//
// Run with `yarn export-schemas`. Re-run any time the parquet shape
// changes — the script is idempotent.

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import duckdb from 'duckdb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PARQUET_ROOT = resolve(ROOT, 'public/data');
const DATA_ROOT = resolve(ROOT, 'data');
const OUT = resolve(ROOT, 'schemas');

const SCHEMA_BASE_URL = 'https://cde.epilepsy.science/schemas';

const MODELS = [
  {
    name: 'cde',
    title: 'Common Data Element (CDE)',
    description:
      'A single Common Data Element — a standardized question with a defined ' +
      'data type and (for value-list types) a fixed set of permissible values. ' +
      'Per-disease classification (Core / Recommended / Supplemental) is recorded ' +
      'separately on cde_classification rows.',
  },
  {
    name: 'cde_classification',
    title: 'CDE Classification',
    description:
      'Per-disease tier assignment for a CDE plus the domain/subdomain/category ' +
      'taxonomy and any disease-specific instructions. Joined to cde via ' +
      'CLASSIFIES relationships.',
  },
  {
    name: 'bundle',
    title: 'Bundle',
    description:
      'A group of CDEs that travel together (e.g. "Body Temperature" combines ' +
      'value, unit, and method). Bundles are the unit of "Add to CRF" and the ' +
      'unit of review — every member CDE inherits the bundle\'s tier decision.',
  },
  {
    name: 'crf',
    title: 'Case Report Form (CRF)',
    description:
      'A data-collection form composed of section headers, individual CDEs, and ' +
      'bundles in a specific order. The dashboard renders this list as a fillable ' +
      'PDF / REDCap dictionary / JSON Schema for downstream data capture.',
  },
  {
    name: 'provenance',
    title: 'Source Provenance',
    description:
      'One record per source describing the dataset itself — label, study type, ' +
      'extraction date, and the workgroup that maintains it. Lets the dashboard ' +
      'surface which CDEs come from which catalog.',
  },
];

const INTERNAL_COLS = new Set(['_source_key', '_source_order', '_study_type']);

/** Map a DuckDB DESCRIBE-style type string to a JSON Schema type spec. */
function ddbTypeToJsonSchema(type) {
  const t = String(type).toUpperCase();

  // Lists like VARCHAR[] or STRUCT(...)[]: array of items
  if (t.endsWith('[]')) {
    const inner = t.slice(0, -2);
    return { type: 'array', items: ddbTypeToJsonSchema(inner) };
  }

  if (t.startsWith('STRUCT')) return { type: 'object' };
  if (t.startsWith('MAP')) return { type: 'object' };

  if (t === 'VARCHAR' || t === 'CHAR' || t === 'STRING' || t === 'TEXT') {
    return { type: 'string' };
  }
  if (t === 'BIGINT' || t === 'INTEGER' || t === 'SMALLINT' || t === 'TINYINT' || t === 'HUGEINT' || t === 'UBIGINT' || t === 'UINTEGER' || t === 'USMALLINT' || t === 'UTINYINT') {
    return { type: 'integer' };
  }
  if (t === 'DOUBLE' || t === 'FLOAT' || t === 'REAL' || t.startsWith('DECIMAL')) {
    return { type: 'number' };
  }
  if (t === 'BOOLEAN' || t === 'BOOL') {
    return { type: 'boolean' };
  }
  if (t === 'DATE') return { type: 'string', format: 'date' };
  if (t === 'TIME') return { type: 'string', format: 'time' };
  if (t.startsWith('TIMESTAMP')) return { type: 'string', format: 'date-time' };
  if (t === 'UUID') return { type: 'string', format: 'uuid' };
  if (t === 'JSON') return {}; // any
  if (t === 'BLOB') return { type: 'string', contentEncoding: 'base64' };

  // Fallback: untyped (matches anything). Better than failing the build.
  return {};
}

const db = new duckdb.Database(':memory:');
const conn = db.connect();
function run(sql) {
  return new Promise((resolve, reject) =>
    conn.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))),
  );
}

function findParquets(model) {
  const matches = [];
  if (!existsSync(PARQUET_ROOT)) return matches;
  for (const dir of readdirSync(PARQUET_ROOT)) {
    const p = resolve(PARQUET_ROOT, dir, `${model}.parquet`);
    if (existsSync(p)) matches.push(p);
  }
  return matches;
}

function readRequired(model) {
  // Walk every source's metadata/models/{m}/versions/1/schema.json. The
  // fetch scripts write the same `required` array on each, so we union
  // them just in case (defensively — should be identical).
  if (!existsSync(DATA_ROOT)) return [];
  const seen = new Set();
  for (const dir of readdirSync(DATA_ROOT)) {
    const f = resolve(
      DATA_ROOT,
      dir,
      'metadata/models',
      model,
      'versions/1/schema.json',
    );
    if (!existsSync(f)) continue;
    try {
      const body = JSON.parse(readFileSync(f, 'utf8'));
      for (const r of body.required ?? []) seen.add(r);
    } catch {
      /* skip malformed */
    }
  }
  return [...seen];
}

async function buildSchemaForModel({ name, title, description }) {
  const parquets = findParquets(name);
  if (!parquets.length) {
    console.warn(`  ⚠  no parquet files found for model "${name}"; skipping`);
    return null;
  }

  // Union BY NAME so columns present in only some sources still show up.
  const sql = parquets.map((p) => `SELECT * FROM '${p}'`).join('\nUNION ALL BY NAME\n');
  const cols = await run(`DESCRIBE ${sql}`);

  const properties = {};
  for (const col of cols) {
    if (INTERNAL_COLS.has(col.column_name)) continue;
    properties[col.column_name] = ddbTypeToJsonSchema(col.column_type);
  }

  const required = readRequired(name);
  // Filter required to columns that actually appear (defensive — e.g.
  // pre-fetch-script CDE renames could leave stale required entries).
  const requiredPresent = required.filter((r) => properties[r] !== undefined);

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${SCHEMA_BASE_URL}/${name}.schema.json`,
    title,
    description,
    type: 'object',
    additionalProperties: false,
    required: requiredPresent.length ? requiredPresent : undefined,
    properties,
    'x-source': 'cde-review-dashboard parquet introspection',
    'x-generated-at': new Date().toISOString(),
  };
}

async function main() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  for (const model of MODELS) {
    const schema = await buildSchemaForModel(model);
    if (!schema) continue;
    const out = resolve(OUT, `${model.name}.schema.json`);
    // Drop undefined keys (`required: undefined` would survive otherwise).
    const clean = JSON.parse(JSON.stringify(schema));
    writeFileSync(out, JSON.stringify(clean, null, 2) + '\n');
    const count = Object.keys(schema.properties).length;
    console.log(`  → ${model.name}.schema.json  (${count} properties${schema.required ? `, ${schema.required.length} required` : ''})`);
  }

  console.log(`\nWrote schemas to ${OUT}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
