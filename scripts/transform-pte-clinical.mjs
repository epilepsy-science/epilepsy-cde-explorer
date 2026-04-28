#!/usr/bin/env node
// Transforms the curated PTE Clinical CDE CSV bundle (under data/pte-clinical/)
// into Pennsieve-format JSONL records that prepare-data.mjs can ingest as a
// regular source. Unlike fetch-ninds-epilepsy.mjs and fetch-nlm-cde.mjs this
// script doesn't hit any upstream API — the CSVs are the authoritative,
// hand-curated input.
//
// Each input row is one (CDE × CRF) assignment. Multiple CDEs can appear on
// multiple CRFs; we deduplicate to one CDE record per cde_id and emit one
// classification + one CLASSIFIES relationship per (CDE, CRF) pair, mirroring
// the NINDS Epilepsy ETL.
//
// Encoding: the CSVs contain a few non-UTF-8 bytes (Excel exports leak
// Windows-1252 chars like degree signs and curly quotes). We read each file
// as latin1 to avoid DuckDB's strict-UTF-8 read failing during prepare-data.
//
// Usage:
//   node scripts/transform-pte-clinical.mjs
//
// Output goes to data/pte-clinical/metadata/{models,relationships.csv}.

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_DIR = resolve(ROOT, 'data/pte-clinical');
const OUT = SRC_DIR;
const META = resolve(OUT, 'metadata');
const TODAY = new Date().toISOString().slice(0, 10);

const SOURCE_KEY = 'pte-clinical';
const SOURCE_LABEL = 'PTE Clinical CDEs';
const STUDY_TYPE = 'Clinical';

// ── CSV parsing ──────────────────────────────────────────────────────────────
// Standard RFC-4180 parser: handles quoted fields, escaped quotes ("" inside
// "..."), embedded commas + newlines. Reads as latin1 so non-UTF-8 bytes
// don't break us; the resulting JS strings are pure unicode and downstream
// JSON.stringify produces clean UTF-8 output.

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      // Eat CR; the LF (or end of file) terminates the row.
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Trailing record without newline.
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function readCsvAsObjects(path) {
  const raw = readFileSync(path, 'latin1');
  const grid = parseCsv(raw);
  if (!grid.length) return [];
  const header = grid[0];
  const out = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (row.length === 1 && !row[0].trim()) continue; // blank line
    const obj = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]] = row[c] ?? null;
    }
    out.push(obj);
  }
  return out;
}

// ── Helpers (mirrors fetch-ninds-epilepsy.mjs's shape) ───────────────────────

function uid(s) {
  const h = createHash('sha1').update(`${SOURCE_KEY}:${s}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function nullIfEmpty(s) {
  if (s == null) return null;
  const t = String(s).trim();
  return t ? t : null;
}

/** Converts ';'-separated upstream lists to project's '|' convention. */
function pipe(s) {
  if (s == null) return null;
  const trimmed = String(s).trim();
  if (!trimmed) return null;
  return trimmed.split(';').map((x) => x.trim()).filter(Boolean).join('|');
}

/** Best-effort map from upstream data_type + input_restrictions to our enum. */
function mapDataType(dt, restr) {
  const r = (restr || '').toLowerCase();
  const d = (dt || '').toLowerCase();
  if (d.includes('value list') || r.includes('pre-defined value')) return 'Value List';
  if (d.includes('numeric') || d === 'number') return 'Number';
  if (d.includes('date') && d.includes('time')) return 'Datetime';
  if (d.includes('date')) return 'Date';
  if (d.includes('time')) return 'Time';
  if (d.includes('file')) return 'File/URI/URL';
  if (d === 'text' || d.includes('alphanumeric')) return 'Text';
  return 'Other';
}

/**
 * The CSVs ship `classification_pte` like "Disease Supplemental  " (note
 * trailing whitespace) and a generic `classification` like "Supplemental".
 * Normalize to our bare enum: Core / Recommended / Supplemental.
 */
function normalizeClassification(raw) {
  if (!raw) return null;
  const cleaned = String(raw).trim().replace(/^Disease\s+/i, '');
  const lower = cleaned.toLowerCase();
  if (lower === 'core') return 'Core';
  if (lower === 'recommended') return 'Recommended';
  if (lower === 'supplemental') return 'Supplemental';
  return cleaned || null;
}

/** Bundle external IDs into our `other_identifiers` pipe-joined column. */
function buildOtherIdentifiers(row) {
  const parts = [];
  for (const [label, val] of [
    ['LOINC', row.external_id_loinc],
    ['SNOMED', row.external_id_snomed],
    ['CDISC', row.external_id_cdisc],
    ['NLM', row.external_id_nlm],
    ['NINDS', row.cde_id],
  ]) {
    if (val && String(val).trim()) parts.push(`${label}:${String(val).trim()}`);
  }
  return parts.length ? parts.join('|') : null;
}

function slug(s) {
  return String(s).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
}

// ── Transform ────────────────────────────────────────────────────────────────

function build(rows) {
  const provenance = {
    id: uid('provenance'),
    data: {
      source_key: SOURCE_KEY,
      label: SOURCE_LABEL,
      study_type: STUDY_TYPE,
    },
  };

  // CDE records — one per unique cde_id. Multiple input rows can reference
  // the same CDE on different CRFs; we keep the first row's metadata
  // (definition, PVs, etc.) and rely on classification rows to capture
  // per-CRF nuances.
  const cdeIdToUuid = new Map();
  const cdeRecords = [];
  for (const r of rows) {
    if (cdeIdToUuid.has(r.cde_id)) continue;
    const uuid = uid(`cde:${r.cde_id}`);
    cdeIdToUuid.set(r.cde_id, uuid);

    cdeRecords.push({
      id: uuid,
      data: {
        cde_name: nullIfEmpty(r.cde_name),
        aliases: null,
        cde_data_type: mapDataType(r.data_type, r.input_restrictions),
        cde_definition: nullIfEmpty(r.cde_definition) || nullIfEmpty(r.cde_name),
        cde_source: SOURCE_LABEL,
        cde_type: nullIfEmpty(r.cde_type),
        // PTE-clinical CDEs originate from NINDS curation per the cde_source
        // column in the CSV. Falls back to the file-level steward.
        steward_org: nullIfEmpty(r.cde_source) || 'NINDS',
        registration_status: null,
        keywords: null,
        preferred_question_text:
          nullIfEmpty(r.short_description) || nullIfEmpty(r.question_text),
        pv_codes: pipe(r.pv_codes),
        pv_labels: pipe(r.pv_labels),
        pv_definitions: pipe(r.pv_definitions),
        pv_code_systems: null,
        pv_concept_identifiers: null,
        pv_terminology_sources: null,
        unit_of_measure: nullIfEmpty(r.measurement_type),
        // CDE-intrinsic numeric range (moved from cde_classification).
        min_value: nullIfEmpty(r.min_value),
        max_value: nullIfEmpty(r.max_value),
        // PTE-overlay column wins when populated; otherwise default to
        // COLLECTED (the most common origin for these rows).
        cde_origin:
          nullIfEmpty(r.cde_origin)?.toUpperCase() ||
          (r.standalone ? 'STANDALONE' : 'COLLECTED'),
        population: nullIfEmpty(r.population),
        cdisc_domain: null,
        cdisc_variable_name: nullIfEmpty(r.external_id_cdisc),
        cdisc_variable_label: null,
        references: nullIfEmpty(r.disease_specific_reference),
        nlm_identifier: nullIfEmpty(r.cde_id),
        // External_id_cadsr is the closest match to caDSR DEC identifier.
        // When populated this flows directly into the concept registry via
        // prepare-data.mjs's emitConceptRegistry step. dec_name stays null;
        // upstream curators haven't supplied a concept-level preferred name.
        dec_identifier: nullIfEmpty(r.external_id_cadsr),
        dec_terminology_source: r.external_id_cadsr ? 'caDSR' : null,
        dec_name: null,
        other_identifiers: buildOtherIdentifiers(r),
      },
    });
  }

  // Classification records — one per (CDE × CRF) pairing, preserving the
  // structure of the input CSVs. PTE-specific overlays win over the base
  // NINDS values when populated.
  const clsRecords = [];
  const classifiesRels = [];
  const sourcedClsRels = [];
  for (const r of rows) {
    const cdeUuid = cdeIdToUuid.get(r.cde_id);
    if (!cdeUuid) continue;
    const clsUuid = uid(`cls:${r.cde_id}:${r.crf_id}`);
    const ptePte = normalizeClassification(r.classification_pte);
    const generic = normalizeClassification(r.classification);
    clsRecords.push({
      id: clsUuid,
      data: {
        variable_name: nullIfEmpty(r.variable_name) || `${r.cde_id}_${r.crf_id}`,
        version_name: nullIfEmpty(r.crf_name)
          ? `${SOURCE_LABEL} · ${r.crf_name}`
          : SOURCE_LABEL,
        version_date: nullIfEmpty(r.version_date) || TODAY,
        notes:
          nullIfEmpty(r.pte_class_notes) || nullIfEmpty(r.specific_instructions_core),
        additional_instructions:
          nullIfEmpty(r.pte_specific_instructions) ||
          nullIfEmpty(r.disease_specific_instructions),
        // Disease scope: PTE-only — TBI is implied by the CRF subject matter
        // but the explicit tag in the CSVs is "Clinical PTE", so we honor that
        // and let curators flip TBI on per-row if/when needed.
        disease_epilepsy: 'N',
        classification_epilepsy: null,
        disease_agnostic: 'N',
        classification_agnostic: null,
        disease_neurotrauma: 'N',
        classification_neurotrauma: null,
        disease_tbi: 'N',
        classification_tbi: null,
        disease_pte: 'Y',
        classification_pte: ptePte || generic || null,
        disease_sci: 'N',
        classification_sci: null,
        // PTE overlays take priority where set; fall back to NINDS-base
        // domain/subdomain. Category = CRF name, matching the existing pattern.
        domain: nullIfEmpty(r.pte_domain) || nullIfEmpty(r.domain),
        subdomain: nullIfEmpty(r.pte_subdomain) || nullIfEmpty(r.subdomain),
        category: nullIfEmpty(r.pte_crf_name) || nullIfEmpty(r.crf_name),
      },
    });
    classifiesRels.push([clsUuid, cdeUuid]);
    sourcedClsRels.push([clsUuid, provenance.id]);
  }

  const sourcedRels = [];
  for (const cdeUuid of cdeIdToUuid.values()) {
    sourcedRels.push([cdeUuid, provenance.id]);
  }

  // CRF records — one per unique crf_id, with `items` listing the CDEs that
  // appear on that CRF in the input.
  const byCrf = new Map();
  for (const r of rows) {
    if (!byCrf.has(r.crf_id)) {
      byCrf.set(r.crf_id, {
        crf_id: r.crf_id,
        crf_name: r.crf_name,
        pte_crf_name: r.pte_crf_name,
        crf_instructions: r.crf_instructions,
        crf_form_guidance: r.crf_form_guidance,
        rows: [],
      });
    }
    byCrf.get(r.crf_id).rows.push(r);
  }
  const crfRecords = [];
  const seenCrfNames = new Set();
  for (const c of byCrf.values()) {
    let base = slug(c.crf_name) || slug(c.crf_id);
    let name = base;
    let n = 2;
    while (seenCrfNames.has(name)) name = `${base}_${n++}`;
    seenCrfNames.add(name);
    const items = c.rows.map((row) => ({
      type: 'cde',
      ref: row.cde_name,
    }));
    crfRecords.push({
      id: uid(`crf:${c.crf_id}`),
      data: {
        crf_name: name,
        title: nullIfEmpty(c.pte_crf_name) || nullIfEmpty(c.crf_name) || c.crf_id,
        description: nullIfEmpty(c.crf_form_guidance),
        instructions: nullIfEmpty(c.crf_instructions),
        external_url: null,
        version: '1.0',
        disease_scope: 'PTE',
        estimated_duration_minutes: null,
        collection_frequency: null,
        items,
      },
    });
  }

  return {
    provenance,
    cdeRecords,
    clsRecords,
    crfRecords,
    rels: { classifiesRels, sourcedRels, sourcedClsRels },
  };
}

// ── Emit ─────────────────────────────────────────────────────────────────────

function writeJsonl(modelDir, schema, records) {
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(resolve(modelDir, 'schema.json'), JSON.stringify(schema));
  const lines = records.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(resolve(modelDir, 'records.jsonl'), lines + (lines ? '\n' : ''));
}

function emit(out) {
  mkdirSync(META, { recursive: true });

  const schemaCde = {
    type: 'object',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    required: ['cde_name', 'cde_data_type', 'cde_definition', 'cde_source'],
    properties: {},
  };
  const schemaCls = {
    type: 'object',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    required: ['variable_name'],
    properties: {},
  };
  const schemaCrf = {
    type: 'object',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    required: ['crf_name', 'title', 'version', 'items'],
    properties: {},
  };
  const schemaProv = {
    type: 'object',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    required: ['source_key', 'label', 'workgroup', 'extraction_date'],
    properties: {},
  };

  writeJsonl(resolve(META, 'models/cde/versions/1'), schemaCde, out.cdeRecords);
  writeJsonl(
    resolve(META, 'models/cde_classification/versions/1'),
    schemaCls,
    out.clsRecords,
  );
  writeJsonl(resolve(META, 'models/crf/versions/1'), schemaCrf, out.crfRecords);
  writeJsonl(resolve(META, 'models/provenance/versions/1'), schemaProv, [out.provenance]);

  const relLines = ['source_record_id,target_record_id,relationship_type'];
  for (const [s, t] of out.rels.classifiesRels) relLines.push(`${s},${t},CLASSIFIES`);
  for (const [s, t] of out.rels.sourcedRels) relLines.push(`${s},${t},SOURCED_FROM`);
  for (const [s, t] of out.rels.sourcedClsRels) relLines.push(`${s},${t},SOURCED_FROM`);
  writeFileSync(resolve(META, 'relationships.csv'), relLines.join('\n') + '\n');

  // Source manifest — match what other sources ship so prepare-data.mjs can
  // discover this directory.
  writeFileSync(
    resolve(OUT, 'manifest.json'),
    JSON.stringify(
      {
        source_key: SOURCE_KEY,
        label: SOURCE_LABEL,
        study_type: STUDY_TYPE,
        generated_at: new Date().toISOString(),
        cde_count: out.cdeRecords.length,
        crf_count: out.crfRecords.length,
        classification_count: out.clsRecords.length,
      },
      null,
      2,
    ) + '\n',
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(SRC_DIR)) {
    console.error(`Missing source dir: ${SRC_DIR}`);
    process.exit(1);
  }
  const csvFiles = readdirSync(SRC_DIR).filter((f) => f.endsWith('.csv'));
  if (!csvFiles.length) {
    console.error(`No CSVs found in ${SRC_DIR}`);
    process.exit(1);
  }
  console.log(`Reading ${csvFiles.length} CSV file(s):`);
  const rows = [];
  for (const f of csvFiles) {
    const fr = readCsvAsObjects(resolve(SRC_DIR, f));
    console.log(`  ${f}: ${fr.length} rows`);
    rows.push(...fr);
  }
  console.log(`Total rows: ${rows.length}`);

  const out = build(rows);
  emit(out);

  console.log(
    `\nWrote ${OUT}:\n` +
      `  cde:                ${out.cdeRecords.length}\n` +
      `  cde_classification: ${out.clsRecords.length}\n` +
      `  crf:                ${out.crfRecords.length}\n` +
      `  provenance:         1\n`,
  );
  console.log(`Next:  node scripts/prepare-data.mjs data/demo data/ninds-epilepsy data/nlm-ninds-disease-epilepsy data/pte-clinical`);
}

main();
