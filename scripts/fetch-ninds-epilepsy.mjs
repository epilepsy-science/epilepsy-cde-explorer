#!/usr/bin/env node
// Fetches the NINDS Epilepsy CDE catalog from the unofficial JSON service that
// powers https://cde-fe.ninds.nih.gov (the NINDS CDE Catalog React SPA) and
// emits Pennsieve-format JSONL + relationships.csv into data/ninds-epilepsy/.
//
// Run afterwards:
//   node scripts/prepare-data.mjs data/ninds-epilepsy
//
// Endpoints reverse-engineered from the bundled SPA:
//   GET  https://ninds.cde-editor.com/cdeService/getInput/disease/
//   POST https://ninds.cde-editor.com/cdeService/getSearchResult/CdeCatalog
//        body: {disease, subDisease, domain, subDomain, crf, copyright,
//               classification, population, cde, keyword}
//   POST https://ninds.cde-editor.com/cdeService/getSearchResult/CdeDetails/CDE/
//        body: {crfId: "<comma-joined cdeIds>", diseaseId: "EPILEPSY"}
//   POST https://ninds.cde-editor.com/cdeService/getSearchResult/CrfListing
//        body: {disease, subDisease, domain, subDomain, copyright, keyword}
// All calls require header `platform: ninds`.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'data/ninds-epilepsy');
const META = resolve(OUT, 'metadata');

const API = 'https://ninds.cde-editor.com/cdeService';
const HEADERS = { 'content-type': 'application/json', platform: 'ninds' };
const DISEASE_ID = 'EPILEPSY';
const SOURCE_LABEL = 'NINDS Epilepsy';
const SOURCE_KEY = 'ninds-epilepsy';
const TODAY = new Date().toISOString().slice(0, 10);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Deterministic UUID-v5-ish from a string — matches generate-demo-data.mjs. */
function uid(s) {
  const h = createHash('sha1').update(`ninds-epilepsy:${s}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function postJSON(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return res.json();
}

function writeJsonl(modelDir, schema, records) {
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(resolve(modelDir, 'schema.json'), JSON.stringify(schema));
  const lines = records.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(resolve(modelDir, 'records.jsonl'), lines + (lines ? '\n' : ''));
}

/** NINDS dataType + inputRestrictions → project cde_data_type enum. */
function mapDataType(dt, restr) {
  const r = (restr || '').toLowerCase();
  const d = (dt || '').toLowerCase();
  // "Alphanumeric" contains "numeric" — check it first.
  if (d.includes('alphanumeric')) {
    return r.includes('pre-defined value') ? 'Value List' : 'Text';
  }
  if (d.includes('numeric')) return 'Number';
  if (d.includes('date') && d.includes('time')) return 'Datetime';
  if (d.includes('date')) return 'Date';
  if (d.includes('time')) return 'Time';
  if (d.includes('file')) return 'File/URI/URL';
  if (d.includes('geolocation')) return 'Geolocation';
  return 'Other';
}

/** Join a set of (label,value) external IDs into the pipe-delimited other_identifiers string. */
function buildOtherIdentifiers(details) {
  const parts = [];
  for (const [label, val] of [
    ['LOINC', details.externalID_LOINC],
    ['SNOMED', details.externalID_SNOMED],
    ['CDISC', details.externalID_CDISC],
    ['NINDS', details.cdeId],
  ]) {
    if (val) parts.push(`${label}:${val}`);
  }
  return parts.length ? parts.join('|') : null;
}

/** NINDS uses `;` to separate permissible value labels/definitions. Project uses `|`. */
function pipe(s) {
  if (s == null) return null;
  const trimmed = String(s).trim();
  if (!trimmed) return null;
  return trimmed.split(';').map((x) => x.trim()).join('|');
}

function nullIfEmpty(s) {
  if (s == null) return null;
  const t = String(s).trim();
  return t ? t : null;
}

function slug(s) {
  return String(s)
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchEverything() {
  console.log(`Fetching NINDS Epilepsy CDE catalog (${DISEASE_ID})…`);

  const catalog = await postJSON('/getSearchResult/CdeCatalog', {
    disease: DISEASE_ID,
    subDisease: '',
    domain: '',
    subDomain: '',
    crf: '',
    copyright: '',
    classification: '',
    population: '',
    cde: '',
    keyword: '',
  });
  console.log(`  Catalog: ${catalog.length} (cde × crf) rows`);

  const crfListing = await postJSON('/getSearchResult/CrfListing', {
    disease: DISEASE_ID,
    subDisease: '',
    domain: '',
    subDomain: '',
    copyright: '',
    keyword: '',
  });
  const crfs = [];
  for (const dom of crfListing) {
    for (const sub of dom.subDomainGroups || []) {
      for (const crf of sub.crfs || []) crfs.push(crf);
    }
  }
  console.log(`  CRFs: ${crfs.length} (${crfs.filter((c) => c.associatedCDE).length} with CDEs)`);

  // Fetch CDE details in batches of 40 unique cdeIds at a time (comma-joined in path body).
  const uniqueCdeIds = [...new Set(catalog.map((r) => r.cdeId))];
  console.log(`  Fetching details for ${uniqueCdeIds.length} unique CDEs…`);
  const details = new Map();
  const BATCH = 40;
  for (let i = 0; i < uniqueCdeIds.length; i += BATCH) {
    const slice = uniqueCdeIds.slice(i, i + BATCH);
    const page = await postJSON('/getSearchResult/CdeDetails/CDE/', {
      crfId: slice.join(','),
      diseaseId: DISEASE_ID,
    });
    for (const r of page) {
      // Details can return multiple rows per cdeId (one per crf). Keep the
      // first; fall back to another if needed.
      if (!details.has(r.cdeId)) details.set(r.cdeId, r);
    }
    process.stdout.write(`    ${Math.min(i + BATCH, uniqueCdeIds.length)}/${uniqueCdeIds.length}\r`);
  }
  process.stdout.write('\n');
  const missing = uniqueCdeIds.filter((id) => !details.has(id));
  if (missing.length) console.warn(`  ⚠  no details returned for ${missing.length} CDEs`);

  return { catalog, crfs, details };
}

// ── Transform ────────────────────────────────────────────────────────────────

function build({ catalog, crfs, details }) {
  // ----- Provenance ----------------------------------------------------------
  const provenance = {
    id: uid(`provenance:${SOURCE_KEY}`),
    data: {
      source_key: SOURCE_KEY,
      label: `${SOURCE_LABEL} CDEs`,
      study_type: 'Clinical',
    },
  };

  // ----- CDE records (one per unique cdeId) ---------------------------------
  const cdeIdToUuid = new Map();
  const cdeRecords = [];
  for (const [cdeId, d] of details) {
    const uuid = uid(`cde:${cdeId}`);
    cdeIdToUuid.set(cdeId, uuid);
    cdeRecords.push({
      id: uuid,
      data: {
        cde_name: d.cdeName,
        // NINDS doesn't expose alternate designations; aliases stay null.
        aliases: null,
        cde_data_type: mapDataType(d.dataType, d.inputRestrictions),
        cde_definition: nullIfEmpty(d.definition) || d.cdeName,
        cde_source: SOURCE_LABEL,
        cde_type: null,
        // Steward org is implicit for this source — it's all NINDS.
        steward_org: 'NINDS',
        // NINDS doesn't surface a registration lifecycle marker.
        registration_status: null,
        keywords: null,
        preferred_question_text: nullIfEmpty(d.shortDescription),
        pv_codes: null,
        pv_labels: pipe(d.permissibleValues),
        pv_definitions: pipe(d.pvDescriptions),
        pv_code_systems: null,
        pv_concept_identifiers: null,
        pv_terminology_sources: null,
        unit_of_measure: nullIfEmpty(d.measurementType),
        // CDE-intrinsic numeric range (moved from cde_classification).
        min_value: nullIfEmpty(d.minValue),
        max_value: nullIfEmpty(d.maxValue),
        cde_origin: 'COLLECTED',
        population: nullIfEmpty(d.population),
        cdisc_domain: null,
        cdisc_variable_name: nullIfEmpty(d.externalID_CDISC),
        cdisc_variable_label: null,
        references:
          d.diseaseSpecificReference && d.diseaseSpecificReference !== 'No references available'
            ? d.diseaseSpecificReference
            : null,
        nlm_identifier: d.cdeId,
        dec_identifier: nullIfEmpty(d.externalID_caDSR),
        dec_terminology_source: d.externalID_caDSR ? 'caDSR' : null,
        dec_name: null,
        other_identifiers: buildOtherIdentifiers(d),
      },
    });
  }

  // NINDS has no NT-PRECEDS-style "bundle" (tight set of CDEs always captured
  // together, e.g. Age Value + Age Unit). CRFs are too coarse (20–100 CDEs) to
  // map onto that concept, so no bundle records are emitted.

  // ----- Classification records (one per cde × crf pairing = one row in the
  //       NINDS catalog response) -----
  const clsRecords = [];
  const classifiesRels = []; // classification → cde
  const sourcedRels = []; // cde → provenance (unique per cde)
  const sourcedClsRels = []; // classification → provenance

  for (const row of catalog) {
    const cdeUuid = cdeIdToUuid.get(row.cdeId);
    if (!cdeUuid) continue; // skipped: no detail record
    const det = details.get(row.cdeId) || {};
    const clsUuid = uid(`cls:${row.cdeId}:${row.crfId}`);
    clsRecords.push({
      id: clsUuid,
      data: {
        variable_name: `${row.cdeId}_${row.crfId}`,
        version_name: `NINDS ${row.crfName} v${row.version || '1.00'}`,
        version_date: row.versionDate ? row.versionDate.slice(0, 10) : TODAY,
        notes: nullIfEmpty(det.additionalNotes),
        additional_instructions: nullIfEmpty(det.diseaseSpecificInstructions),
        // NINDS records the disease scope authoritatively (diseaseId=EPILEPSY
        // for every row in this pull). Other disease columns exist so the view
        // can LEFT JOIN across heterogeneous sources without missing-column errors.
        disease_epilepsy: 'Y',
        classification_epilepsy: row.classification || null,
        disease_agnostic: 'N',
        classification_agnostic: null,
        disease_neurotrauma: 'N',
        classification_neurotrauma: null,
        disease_tbi: 'N',
        classification_tbi: null,
        disease_pte: 'N',
        classification_pte: null,
        disease_sci: 'N',
        classification_sci: null,
        domain: row.domainName || det.domainName || null,
        subdomain: row.subDomainName || det.subDomainName || null,
        category: row.crfName || null,
      },
    });
    classifiesRels.push([clsUuid, cdeUuid]);
    sourcedClsRels.push([clsUuid, provenance.id]);
  }

  for (const cdeUuid of cdeIdToUuid.values()) {
    sourcedRels.push([cdeUuid, provenance.id]);
  }

  // ----- CRF records ---------------------------------------------------------
  // Include all listed CRFs (incl. those without CDEs attached — associatedCDE=false
  // — with empty items arrays). The items array lists the CDE names mapped to each.
  const catalogByCrf = new Map();
  for (const row of catalog) {
    if (!catalogByCrf.has(row.crfId)) catalogByCrf.set(row.crfId, []);
    catalogByCrf.get(row.crfId).push(row);
  }
  const crfRecords = [];
  const seenCrfNames = new Set();
  for (const crf of crfs) {
    // crf_name is the key — ensure uniqueness.
    let base = slug(crf.crfName) || slug(crf.crfId);
    let name = base;
    let n = 2;
    while (seenCrfNames.has(name)) name = `${base}_${n++}`;
    seenCrfNames.add(name);
    const items = (catalogByCrf.get(crf.crfId) || []).map((row) => ({
      type: 'cde',
      ref: row.cdeName,
    }));
    // NINDS doesn't expose structured instructions — they live inside the
    // canonical DOCX at externalUrl. Surface the URL as a first-class field
    // so the CRF detail view can render a proper link/button.
    const docUrl = crf.externalUrl
      ? `${NINDS_DOC_BASE}/${crf.externalUrl}`
      : null;
    crfRecords.push({
      id: uid(`crf:${crf.crfId}`),
      data: {
        crf_name: name,
        title: crf.crfName,
        description:
          crf.crfDescription ||
          [crf.domainName, crf.subDomainName].filter(Boolean).join(' · ') ||
          null,
        instructions: null,
        external_url: docUrl,
        version: crf.version || '1.0',
        disease_scope: 'Epilepsy',
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

  writeFileSync(resolve(META, 'files.csv'), 'name,path,size,fileType\n');

  writeFileSync(
    resolve(OUT, 'manifest.json'),
    JSON.stringify(
      {
        name: 'NINDS Epilepsy CDE Dataset',
        description:
          'Epilepsy CDEs extracted from the NINDS CDE Catalog (diseaseId=EPILEPSY).',
        version: 1,
        datePublished: TODAY,
        pennsieveSchemaVersion: '5.0',
      },
      null,
      2,
    ) + '\n',
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const fetched = await fetchEverything();
  const built = build(fetched);
  emit(built);

  console.log('');
  console.log(`Wrote ${OUT}:`)
  console.log(`  cde:                ${built.cdeRecords.length}`);
  console.log(`  cde_classification: ${built.clsRecords.length}`);
  console.log(`  crf:                ${built.crfRecords.length}`);
  console.log(`  provenance:         1`);
  console.log(`  (no bundles — NINDS doesn't expose the concept)`);
  console.log('');
  console.log('Next:  node scripts/prepare-data.mjs data/ninds-epilepsy');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});