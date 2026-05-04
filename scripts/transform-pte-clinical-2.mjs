#!/usr/bin/env node
// Transforms the v0.01 PTE Clinical CDE export (under data/pte-clinical-2/)
// into Pennsieve-format JSONL records that prepare-data.mjs can ingest.
//
// The CSV ships steward_org, aliases, dec_identifier, bundle_name and all
// five disease scopes as first-class columns, so this transform is mostly
// straight passthrough plus a few enum normalizations. source_key is
// "pte-clinical" so the dashboard's filter values and cached UI state are
// stable across the v0.01 catalog refresh.
//
// Inputs (under data/pte-clinical-2/):
//   v0.01_pte_clinical.csv   one row per (CDE × PTE-CRF) assignment
//   v0.01_pte_bundles.csv    bundle metadata (display_name, description, pte_crf)
//
// Outputs (under data/pte-clinical-2/metadata/):
//   models/{cde,cde_classification,crf,bundle,provenance}/versions/1/{schema.json,records.jsonl}
//   relationships.csv
//   ../manifest.json
//
// Filters applied:
//   - drop rows with empty cde_id
//   - drop rows with cde_id starting "DRAFT:" (35 placeholder rows w/o name/definition)
//   - drop rows with duplicate_cde_flag = "DUPLICATE" (8 redundant cross-listings)
//
// Usage:
//   node scripts/transform-pte-clinical-2.mjs

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_DIR = resolve(ROOT, 'data/pte-clinical-2');
const META = resolve(SRC_DIR, 'metadata');
const TODAY = new Date().toISOString().slice(0, 10);

const SOURCE_KEY = 'pte-clinical';
const SOURCE_LABEL = 'PTE Clinical CDEs';
const STUDY_TYPE = 'Clinical';

const CSV_CDES = resolve(SRC_DIR, 'v0.01_pte_clinical.csv');
const CSV_BUNDLES = resolve(SRC_DIR, 'v0.01_pte_bundles.csv');

// ── CSV parsing (RFC-4180, UTF-8 with optional BOM) ──────────────────────────

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
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
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function readCsvAsObjects(path) {
  const grid = parseCsv(readFileSync(path, 'utf8'));
  if (!grid.length) return [];
  const header = grid[0];
  const out = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (row.length === 1 && !row[0].trim()) continue;
    const obj = {};
    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      if (!key) continue; // trailing empty header columns from Excel exports
      obj[key] = row[c] ?? null;
    }
    out.push(obj);
  }
  return out;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function uid(s) {
  const h = createHash('sha1').update(`${SOURCE_KEY}:${s}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function nullIfEmpty(s) {
  if (s == null) return null;
  const t = String(s).trim();
  return t ? t : null;
}

/** Map upstream cde_data_type to our enum. New CSV is mostly already aligned. */
function mapDataType(raw) {
  const v = nullIfEmpty(raw);
  if (!v) return 'Other';
  const lower = v.toLowerCase();
  if (lower === 'value list') return 'Value List';
  if (lower === 'number' || lower === 'numeric') return 'Number';
  if (lower === 'datetime' || lower === 'date time') return 'Datetime';
  if (lower === 'date') return 'Date';
  if (lower === 'time') return 'Time';
  if (lower === 'text' || lower === 'alphanumeric') return 'Text';
  if (lower === 'file' || lower.includes('uri') || lower.includes('url')) return 'File/URI/URL';
  return 'Other';
}

/**
 * Strip the "Disease " prefix that PTE/NINDS apply to disease-scoped tiers
 * ("Disease Supplemental", "Disease Supplemental Highly Recommended"), and
 * collapse internal whitespace. Existing pte-clinical records use the bare
 * forms ("Supplemental", "Supplemental Highly Recommended").
 */
function normalizeClassification(raw) {
  const v = nullIfEmpty(raw);
  if (!v) return null;
  return v.replace(/^Disease\s+/i, '').replace(/\s+/g, ' ').trim() || null;
}

/** "Supplemental-Highly Recommended" → "Supplemental Highly Recommended". */
function normalizeTbiClass(raw) {
  const v = nullIfEmpty(raw);
  if (!v) return null;
  return v.replace(/-/g, ' ').replace(/\s+/g, ' ').trim() || null;
}

function yn(raw) {
  const v = nullIfEmpty(raw);
  if (!v) return 'N';
  return v.toUpperCase().startsWith('Y') ? 'Y' : 'N';
}

function slug(s) {
  return String(s).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
}

// ── Filtering ────────────────────────────────────────────────────────────────

function isUsableRow(r) {
  const cid = (r.cde_id || '').trim();
  if (!cid) return false;
  if (cid.startsWith('DRAFT:')) return false; // placeholder rows w/o name or definition
  if ((r.duplicate_cde_flag || '').trim().toUpperCase() === 'DUPLICATE') return false;
  return true;
}

// ── Build records ────────────────────────────────────────────────────────────

function build(cdeRows, bundleRows) {
  const provenance = {
    id: uid('provenance'),
    data: {
      source_key: SOURCE_KEY,
      label: SOURCE_LABEL,
      study_type: STUDY_TYPE,
      // v0.01 curated catalog — surface the "Sample" badge until the
      // upstream curators promote a finalized release.
      kind: 'sample',
    },
  };

  const rows = cdeRows.filter(isUsableRow);

  // ── CDE: one record per unique cde_id ───────────────────────────────────
  const cdeIdToUuid = new Map();
  const cdeRecords = [];
  for (const r of rows) {
    const cid = r.cde_id.trim();
    if (cdeIdToUuid.has(cid)) continue;
    const uuid = uid(`cde:${cid}`);
    cdeIdToUuid.set(cid, uuid);

    cdeRecords.push({
      id: uuid,
      data: {
        cde_name: nullIfEmpty(r.cde_name),
        aliases: nullIfEmpty(r.aliases),
        cde_data_type: mapDataType(r.cde_data_type),
        cde_definition: nullIfEmpty(r.cde_definition) || nullIfEmpty(r.cde_name),
        cde_source: SOURCE_LABEL,
        cde_type: nullIfEmpty(r.detail_element_type),
        // steward_org is now first-class; default to NINDS when absent since
        // NINDS owns 327/362 of the rows (the rest are "Clinical PTE").
        steward_org: nullIfEmpty(r.steward_org) || nullIfEmpty(r.cde_source) || 'NINDS',
        registration_status: nullIfEmpty(r.registration_status),
        keywords: nullIfEmpty(r.keywords),
        preferred_question_text: nullIfEmpty(r.preferred_question_text),
        pv_codes: nullIfEmpty(r.pv_codes),
        pv_labels: nullIfEmpty(r.pv_labels),
        pv_definitions: nullIfEmpty(r.pv_definitions),
        pv_code_systems: nullIfEmpty(r.pv_code_systems),
        pv_concept_identifiers: nullIfEmpty(r.pv_concept_identifiers),
        pv_terminology_sources: nullIfEmpty(r.pv_terminology_sources),
        unit_of_measure: nullIfEmpty(r.unit_of_measure),
        size: nullIfEmpty(r.size),
        min_value: nullIfEmpty(r.min_value),
        max_value: nullIfEmpty(r.max_value),
        // Lowercase "collected"/"calculation" in the CSV; uppercase to match
        // the existing enum used by the dashboard.
        cde_origin: nullIfEmpty(r.cde_origin)?.toUpperCase() || 'COLLECTED',
        population: nullIfEmpty(r.population),
        cdisc_domain: nullIfEmpty(r.cdisc_domain),
        cdisc_variable_name: nullIfEmpty(r.cdisc_variable_name),
        cdisc_variable_label: nullIfEmpty(r.cdisc_variable_label),
        references: nullIfEmpty(r.ninds_disease_specific_reference),
        nlm_identifier: nullIfEmpty(r.nlm_identifier) || cid,
        dec_identifier: nullIfEmpty(r.dec_identifier),
        dec_terminology_source: nullIfEmpty(r.dec_terminology_source),
        dec_name: nullIfEmpty(r.dec_name),
        other_identifiers: nullIfEmpty(r.other_identifiers),
        nlm_view_url: nullIfEmpty(r.nlm_view_url),
      },
    });
  }

  // ── CRF: one record per unique pte_crf_name ─────────────────────────────
  const byCrf = new Map();
  for (const r of rows) {
    const name = nullIfEmpty(r.pte_crf_name);
    if (!name) continue;
    if (!byCrf.has(name)) byCrf.set(name, []);
    byCrf.get(name).push(r);
  }
  const crfRecords = [];
  const crfNameToUuid = new Map();
  for (const [name, crfRows] of byCrf) {
    const uuid = uid(`crf:${name}`);
    crfNameToUuid.set(name, uuid);
    // Item order = first-occurrence order in the source CSV.
    const seenCdes = new Set();
    const items = [];
    for (const r of crfRows) {
      const cdeName = nullIfEmpty(r.cde_name);
      if (!cdeName || seenCdes.has(cdeName)) continue;
      seenCdes.add(cdeName);
      items.push({ type: 'cde', ref: cdeName });
    }
    crfRecords.push({
      id: uuid,
      data: {
        crf_name: slug(name),
        title: name,
        description: null,
        instructions: null,
        external_url: null,
        version: '1.0',
        disease_scope: 'PTE',
        estimated_duration_minutes: null,
        collection_frequency: null,
        items,
      },
    });
  }

  // ── Bundle: one record per unique bundle_name (dedupe trim+case) ────────
  // The bundles CSV provides display_name/description; CDE rows give us
  // domain/subdomain/category/working_group via the first matching CDE row.
  const bundleByKey = new Map();
  for (const b of bundleRows) {
    const name = nullIfEmpty(b.bundle_name);
    if (!name) continue;
    if (!bundleByKey.has(name)) bundleByKey.set(name, b);
  }
  const cdeRowsByBundle = new Map();
  for (const r of rows) {
    const bn = nullIfEmpty(r.bundle_name);
    if (!bn) continue;
    if (!cdeRowsByBundle.has(bn)) cdeRowsByBundle.set(bn, []);
    cdeRowsByBundle.get(bn).push(r);
  }
  const bundleRecords = [];
  const bundleNameToUuid = new Map();
  for (const [name, bundleMeta] of bundleByKey) {
    const cdeRowsForBundle = cdeRowsByBundle.get(name) || [];
    const first = cdeRowsForBundle[0] || {};
    const uuid = uid(`bundle:${name}`);
    bundleNameToUuid.set(name, uuid);
    bundleRecords.push({
      id: uuid,
      data: {
        bundle_name: name,
        display_name: nullIfEmpty(bundleMeta.display_name) || name,
        description: nullIfEmpty(bundleMeta.description),
        domain: nullIfEmpty(first.domain),
        subdomain: nullIfEmpty(first.subdomain),
        category:
          nullIfEmpty(first.category) ||
          nullIfEmpty(bundleMeta.pte_crf_name) ||
          nullIfEmpty(first.pte_crf_name),
        working_group: nullIfEmpty(first.pte_workinggroup),
      },
    });
  }

  // ── Classification: one record per (CDE × pte_crf_name) ─────────────────
  const clsRecords = [];
  const classifiesRels = [];
  const sourcedClsRels = [];
  const partOfRels = [];
  const seenCls = new Set();
  for (const r of rows) {
    const cid = r.cde_id.trim();
    const cdeUuid = cdeIdToUuid.get(cid);
    if (!cdeUuid) continue;
    const crfName = nullIfEmpty(r.pte_crf_name) || '_uncategorized';
    const clsKey = `${cid}::${crfName}`;
    if (seenCls.has(clsKey)) continue;
    seenCls.add(clsKey);
    const clsUuid = uid(`cls:${clsKey}`);

    clsRecords.push({
      id: clsUuid,
      data: {
        variable_name: nullIfEmpty(r.variable_name) || cid,
        version_name: `${SOURCE_LABEL} · ${crfName}`,
        // Excel mangles fractional dates ("21:51.5"); pass through as raw
        // strings — curators interpret these in the upstream system.
        version_date: nullIfEmpty(r.ninds_version_date) || TODAY,
        notes: nullIfEmpty(r.notes),
        additional_instructions:
          nullIfEmpty(r.additional_instructions) ||
          nullIfEmpty(r.ninds_raw_disease_specific_instructions),
        disease_epilepsy: yn(r.disease_epilepsy),
        classification_epilepsy: normalizeClassification(r.classification_epilepsy),
        disease_agnostic: yn(r.disease_agnostic),
        classification_agnostic: normalizeClassification(r.classification_agnostic),
        disease_neurotrauma: yn(r.disease_neurotrauma),
        classification_neurotrauma: normalizeClassification(r.classification_neurotrauma),
        disease_tbi: yn(r.disease_tbi),
        classification_tbi: normalizeTbiClass(r.classification_tbi),
        disease_pte: yn(r.disease_pte),
        classification_pte: normalizeClassification(r.classification_pte),
        disease_sci: yn(r.disease_sci),
        classification_sci: normalizeClassification(r.classification_sci),
        domain: nullIfEmpty(r.domain),
        subdomain: nullIfEmpty(r.subdomain),
        // category column is the high-level grouping; fall back to pte_crf_name.
        category: nullIfEmpty(r.category) || nullIfEmpty(r.pte_crf_name),
        bundle_name: nullIfEmpty(r.bundle_name),
        ninds_crf_id: nullIfEmpty(r.ninds_crf_id),
        ninds_crf_name: nullIfEmpty(r.ninds_crf_name),
        working_group: nullIfEmpty(r.pte_workinggroup),
      },
    });
    classifiesRels.push([clsUuid, cdeUuid]);
    sourcedClsRels.push([clsUuid, provenance.id]);

    // PART_OF: classification → bundle (the runtime's bundle_of_cls view
    // joins on this edge to attach bundle_name to each CDE row).
    const bundleName = nullIfEmpty(r.bundle_name);
    if (bundleName) {
      const bundleUuid = bundleNameToUuid.get(bundleName);
      if (bundleUuid) partOfRels.push([clsUuid, bundleUuid]);
    }
  }

  // SOURCED_FROM rels for each CDE and bundle to the provenance record.
  const sourcedRels = [];
  for (const cdeUuid of cdeIdToUuid.values()) {
    sourcedRels.push([cdeUuid, provenance.id]);
  }
  const sourcedBundleRels = [];
  for (const bundleUuid of bundleNameToUuid.values()) {
    sourcedBundleRels.push([bundleUuid, provenance.id]);
  }

  return {
    provenance,
    cdeRecords,
    clsRecords,
    crfRecords,
    bundleRecords,
    rels: { classifiesRels, partOfRels, sourcedRels, sourcedClsRels, sourcedBundleRels },
    skipped: cdeRows.length - rows.length,
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

  const openSchema = (required) => ({
    type: 'object',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    required,
    properties: {},
  });

  writeJsonl(
    resolve(META, 'models/cde/versions/1'),
    openSchema(['cde_name', 'cde_data_type', 'cde_definition', 'cde_source']),
    out.cdeRecords,
  );
  writeJsonl(
    resolve(META, 'models/cde_classification/versions/1'),
    openSchema(['variable_name']),
    out.clsRecords,
  );
  writeJsonl(
    resolve(META, 'models/crf/versions/1'),
    openSchema(['crf_name', 'title', 'version', 'items']),
    out.crfRecords,
  );
  writeJsonl(
    resolve(META, 'models/bundle/versions/1'),
    openSchema(['bundle_name']),
    out.bundleRecords,
  );
  writeJsonl(
    resolve(META, 'models/provenance/versions/1'),
    openSchema(['source_key', 'label']),
    [out.provenance],
  );

  const relLines = ['source_record_id,target_record_id,relationship_type'];
  for (const [s, t] of out.rels.classifiesRels) relLines.push(`${s},${t},CLASSIFIES`);
  for (const [s, t] of out.rels.partOfRels) relLines.push(`${s},${t},PART_OF`);
  for (const [s, t] of out.rels.sourcedRels) relLines.push(`${s},${t},SOURCED_FROM`);
  for (const [s, t] of out.rels.sourcedClsRels) relLines.push(`${s},${t},SOURCED_FROM`);
  for (const [s, t] of out.rels.sourcedBundleRels) relLines.push(`${s},${t},SOURCED_FROM`);
  writeFileSync(resolve(META, 'relationships.csv'), relLines.join('\n') + '\n');

  writeFileSync(
    resolve(SRC_DIR, 'manifest.json'),
    JSON.stringify(
      {
        source_key: SOURCE_KEY,
        label: SOURCE_LABEL,
        study_type: STUDY_TYPE,
        generated_at: new Date().toISOString(),
        cde_count: out.cdeRecords.length,
        crf_count: out.crfRecords.length,
        classification_count: out.clsRecords.length,
        bundle_count: out.bundleRecords.length,
      },
      null,
      2,
    ) + '\n',
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  for (const p of [CSV_CDES, CSV_BUNDLES]) {
    if (!existsSync(p)) {
      console.error(`Missing input: ${p}`);
      process.exit(1);
    }
  }
  const cdeRows = readCsvAsObjects(CSV_CDES);
  const bundleRows = readCsvAsObjects(CSV_BUNDLES);
  console.log(`Read ${cdeRows.length} CDE rows and ${bundleRows.length} bundle rows.`);

  const out = build(cdeRows, bundleRows);
  emit(out);

  console.log(
    `\nWrote ${META}:\n` +
      `  cde:                ${out.cdeRecords.length}\n` +
      `  cde_classification: ${out.clsRecords.length}\n` +
      `  crf:                ${out.crfRecords.length}\n` +
      `  bundle:             ${out.bundleRecords.length}\n` +
      `  provenance:         1\n` +
      `  filtered out:       ${out.skipped} rows (DRAFT placeholders + duplicate flags)\n`,
  );
  console.log(`Next:  node scripts/prepare-data.mjs`);
}

main();