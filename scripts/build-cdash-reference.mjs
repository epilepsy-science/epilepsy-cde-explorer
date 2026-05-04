#!/usr/bin/env node
// Extract CDASHIG v2.0 metadata tables from docs/cdasig-v2.md and emit a
// flat reference dataset the dashboard can use to score CDE↔CDASH alignment.
//
// CDISC Library API would be the canonical source, but our default
// subscription tier returns "members-only content" for every MDR endpoint.
// CDASHIG v2.0 has been final since 2017 and isn't going to move; parsing the
// spec doc is a one-shot extraction that holds up. Move to the Library API
// once an institutional CDISC membership is attached to the API key.
//
// IMPORTANT: docs/cdasig-v2.md and the data/cdash/ outputs are git-ignored.
// The CDASHIG spec is ©CDISC and cannot be redistributed. To run this script,
// first obtain CDASHIG v2.0 from cdisc.org (member access required) and
// place it at docs/cdasig-v2.md.
//
// Output (gitignored):
//   data/cdash/cdashig-v2.0.jsonl     — one row per CDASH variable
//   data/cdash/cdashig-v2.0.parquet   — same, parquet for the runtime
//   data/cdash/manifest.json          — version + row count
//
// Each row carries the 18 columns from the CDASHIG Metadata Table:
//   observation_class, domain, data_collection_scenario, implementation_options,
//   order_number, cdashig_variable, cdashig_variable_label, definition,
//   question_text, prompt, data_type, cdashig_core, completion_instructions,
//   sdtmig_target, mapping_instructions, ct_codelist_name, subset_ct, notes
//
// Usage:
//   node scripts/build-cdash-reference.mjs

import duckdb from 'duckdb';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'docs/cdasig-v2.md');
const OUT_DIR = resolve(ROOT, 'data/cdash');
const OUT_JSONL = resolve(OUT_DIR, 'cdashig-v2.0.jsonl');
const OUT_PARQUET = resolve(OUT_DIR, 'cdashig-v2.0.parquet');
const OUT_MANIFEST = resolve(OUT_DIR, 'manifest.json');

const HEADER = [
  'Observation Class',
  'Domain',
  'Data Collection Scenario',
  'Implementation Options',
  'Order Number',
  'CDASHIG Variable',
  'CDASHIG Variable Label',
  'DRAFT CDASHIG Definition',
  'Question Text',
  'Prompt',
  'Data Type',
  'CDASHIG Core',
  'Case Report Form Completion Instructions',
  'SDTMIG Target',
  'Mapping Instructions',
  'Controlled Terminology Codelist Name',
  'Subset Controlled Terminology/CDASH Codelist Name',
  'Implementation Notes',
];

const KEYS = [
  'observation_class',
  'domain',
  'data_collection_scenario',
  'implementation_options',
  'order_number',
  'cdashig_variable',
  'cdashig_variable_label',
  'definition',
  'question_text',
  'prompt',
  'data_type',
  'cdashig_core',
  'completion_instructions',
  'sdtmig_target',
  'mapping_instructions',
  'ct_codelist_name',
  'subset_ct',
  'notes',
];

const HEADER_LINE = HEADER.join('\t');

function nullIfNa(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === 'N/A') return null;
  return s;
}

function isLikelyDataRow(parts) {
  // CDASHIG data rows always start with a known observation class, an
  // explicit two-letter domain code, and an order number. The narrative
  // prose between tables doesn't have tabs at all.
  if (parts.length !== HEADER.length) return false;
  const obsClass = parts[0]?.trim();
  const domain = parts[1]?.trim();
  const order = parts[4]?.trim();
  if (!obsClass || !domain || !order) return false;
  if (!/^[A-Z]{2,4}(-[A-Z]+)?$/.test(domain) && !/^[A-Z]{2}$/.test(domain)) return false;
  if (!/^\d+(\.\d+)?$/.test(order)) return false;
  return true;
}

function parse() {
  const text = readFileSync(SRC, 'utf8');
  const lines = text.split('\n');
  const rows = [];
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith(HEADER_LINE)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.includes('\t')) {
      // narrative paragraph between sections — close out the table
      inTable = false;
      continue;
    }
    const parts = line.split('\t');
    if (!isLikelyDataRow(parts)) {
      inTable = false;
      continue;
    }
    const row = {};
    for (let i = 0; i < KEYS.length; i++) {
      row[KEYS[i]] = nullIfNa(parts[i]);
    }
    rows.push(row);
  }
  return rows;
}

async function emit(rows) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_JSONL, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const db = new duckdb.Database(':memory:');
  const conn = db.connect();
  const run = (sql) =>
    new Promise((res, rej) => conn.run(sql, (e) => (e ? rej(e) : res())));
  const escaped = OUT_JSONL.replace(/\\/g, '/');
  const target = OUT_PARQUET.replace(/\\/g, '/');
  await run(`
    COPY (
      SELECT * FROM read_json_auto('${escaped}', format='newline_delimited',
                                    maximum_object_size=16777216)
    ) TO '${target}' (FORMAT 'parquet', COMPRESSION 'zstd');
  `);

  const domains = [...new Set(rows.map((r) => r.domain))].sort();
  const cores = rows.reduce((acc, r) => {
    acc[r.cdashig_core ?? 'null'] = (acc[r.cdashig_core ?? 'null'] ?? 0) + 1;
    return acc;
  }, {});

  writeFileSync(
    OUT_MANIFEST,
    JSON.stringify(
      {
        source: 'CDISC CDASHIG v2.0 (2017-09-20 Final)',
        extracted_at: new Date().toISOString(),
        row_count: rows.length,
        unique_variables: new Set(rows.map((r) => r.cdashig_variable)).size,
        domains,
        cdashig_core_distribution: cores,
      },
      null,
      2,
    ) + '\n',
  );
}

function main() {
  if (!existsSync(SRC)) {
    console.error(`Missing input: ${SRC}`);
    process.exit(1);
  }
  const rows = parse();
  if (!rows.length) {
    console.error('No CDASHIG metadata rows extracted — check the markdown structure.');
    process.exit(1);
  }
  emit(rows).then(() => {
    const domains = [...new Set(rows.map((r) => r.domain))].sort();
    const uniqueVars = new Set(rows.map((r) => r.cdashig_variable)).size;
    console.log(
      `Extracted ${rows.length} CDASHIG variable rows ` +
        `(${uniqueVars} unique variables across ${domains.length} domains).`,
    );
    console.log(`  → ${OUT_JSONL}`);
    console.log(`  → ${OUT_PARQUET}`);
    console.log(`  → ${OUT_MANIFEST}`);
  });
}

main();