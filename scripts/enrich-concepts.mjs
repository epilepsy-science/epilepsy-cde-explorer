#!/usr/bin/env node
// Enriches the concept registry built by prepare-data.mjs with human-
// readable labels (and, where available, definitions and UMLS CUIs)
// pulled from external terminology services. Result is written to
// data/concept-enrichment.json — a committed cache so deploys don't need
// API access and so labels are versioned alongside the dashboard.
//
// Today's adapters:
//   - caDSR: looks up the caDSR Data Element Concept ID via the NLM CDE
//     Repository (`POST /server/de/search`). NLM doesn't ship the
//     dataElementConcept block populated, but its own `designation` is a
//     curated label sourced from caDSR. For an authoritative concept-level
//     label + definition, route through caDSR directly when that becomes
//     publicly accessible again.
//
// Future adapters:
//   - LOINC / SNOMED CT / NCI Thesaurus → UMLS UTS API (apikey via
//     UMLS_API_KEY env var). Hit /search/current?inputType=sourceUi to
//     resolve a source identifier to a CUI, then /content/.../CUI/{cui} for
//     preferred name + definition.
//
// Usage:
//   yarn enrich-concepts                 # only fetch missing/stale rows
//   yarn enrich-concepts --refresh       # force-refresh all rows
//   FRESHNESS_DAYS=7 yarn enrich-concepts
//
// Idempotent + offline-friendly: rows already cached and within freshness
// are skipped. On API failure for a row, we keep the stale value (if any)
// and flag it with `last_error` so the dashboard can surface a warning.

import duckdb from 'duckdb';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CONCEPT_PARQUET = resolve(ROOT, 'public/data/concept.parquet');
const CACHE_PATH = resolve(ROOT, 'data/concept-enrichment.json');

const argv = process.argv.slice(2);
const FORCE_REFRESH = argv.includes('--refresh');
const FRESHNESS_DAYS = Number(process.env.FRESHNESS_DAYS ?? 30);
const FRESHNESS_MS = FRESHNESS_DAYS * 24 * 60 * 60 * 1000;

if (!existsSync(CONCEPT_PARQUET)) {
  console.error(
    `Missing ${CONCEPT_PARQUET}. Run \`node scripts/prepare-data.mjs\` first ` +
      `to derive the concept registry.`,
  );
  process.exit(1);
}

// ── Cache ────────────────────────────────────────────────────────────────────
function loadCache() {
  if (!existsSync(CACHE_PATH)) return { version: 1, concepts: {} };
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    if (raw.version !== 1 || typeof raw.concepts !== 'object') {
      console.warn(`  ⚠  ${CACHE_PATH} has unexpected shape; starting fresh`);
      return { version: 1, concepts: {} };
    }
    return raw;
  } catch (e) {
    console.warn(`  ⚠  ${CACHE_PATH} is unparseable (${e.message}); starting fresh`);
    return { version: 1, concepts: {} };
  }
}

function saveCache(cache) {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
}

function isFresh(entry) {
  if (!entry?.fetched_at) return false;
  const age = Date.now() - new Date(entry.fetched_at).getTime();
  return age < FRESHNESS_MS;
}

// ── Concept list (read from parquet via in-memory DuckDB) ────────────────────
async function readConcepts() {
  return new Promise((res, rej) => {
    const db = new duckdb.Database(':memory:');
    const conn = db.connect();
    conn.all(
      `SELECT id, source, identifier FROM read_parquet('${CONCEPT_PARQUET}')
       ORDER BY source, identifier`,
      (err, rows) => {
        conn.close();
        db.close(() => (err ? rej(err) : res(rows)));
      },
    );
  });
}

// ── Adapters ─────────────────────────────────────────────────────────────────
//
// Each adapter takes a concept's (source, identifier) and returns
// { preferred_label?, definition?, cui?, alt_labels?, source_url? }, or
// throws on hard error. Throws are caught at the call site so one bad row
// doesn't abort the whole run.

async function enrichCadsr({ identifier }) {
  // NLM search by caDSR public ID returns the matching CDE; its
  // `designation` is a curated label that originates from caDSR.
  const url = 'https://cde.nlm.nih.gov/server/de/search';
  const body = JSON.stringify({ searchTerm: identifier, resultPerPage: 3 });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`NLM search HTTP ${res.status}`);
  const json = await res.json();
  const cdes = json.cdes ?? [];
  if (!cdes.length) throw new Error('no NLM match');
  // Prefer the first hit. NLM may return multiple CDEs that all reference
  // the same caDSR DEC; their `designation` should be ~identical.
  const c = cdes[0];
  const designation = c.designations?.[0]?.designation ?? null;
  // Some NLM records carry a per-element definition that's a reasonable
  // substitute for the concept-level definition until caDSR access lands.
  const defs = c.definitions ?? [];
  const definition = defs[0]?.definition ?? null;
  return {
    preferred_label: designation,
    definition,
    source_url: `https://cde.nlm.nih.gov/deView?tinyId=${c.tinyId}`,
  };
}

const ADAPTERS = {
  caDSR: enrichCadsr,
};

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const concepts = await readConcepts();
  console.log(`Concept registry: ${concepts.length} concepts`);

  const cache = loadCache();
  let fetched = 0;
  let skipped = 0;
  let errored = 0;

  for (const c of concepts) {
    const adapter = ADAPTERS[c.source];
    if (!adapter) {
      // Source we don't yet have an enrichment path for. Leave alone.
      continue;
    }
    const existing = cache.concepts[c.id];
    if (!FORCE_REFRESH && isFresh(existing)) {
      skipped++;
      continue;
    }
    try {
      const data = await adapter(c);
      cache.concepts[c.id] = {
        ...existing,
        ...data,
        last_error: undefined,
        fetched_at: new Date().toISOString(),
      };
      delete cache.concepts[c.id].last_error;
      fetched++;
      process.stdout.write(`  ${c.id} → ${data.preferred_label ?? '(no label)'}\n`);
    } catch (err) {
      errored++;
      // Keep stale value if we have one — only stamp the error.
      cache.concepts[c.id] = {
        ...existing,
        last_error: err.message,
        last_error_at: new Date().toISOString(),
      };
      process.stdout.write(`  ${c.id} ✗ ${err.message}\n`);
    }
  }

  saveCache(cache);
  console.log(`\nFetched: ${fetched}, skipped (fresh): ${skipped}, errored: ${errored}`);
  console.log(`Cache: ${CACHE_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
