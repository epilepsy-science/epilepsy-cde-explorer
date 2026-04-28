#!/usr/bin/env node
// Generic NLM CDE Repository fetcher. Pulls CDEs and Forms (CRFs) from
// https://cde.nlm.nih.gov for a given steward org and optional classification
// path, then emits Pennsieve-format JSONL into ./<output-dir>/.
//
// Usage:
//   node scripts/fetch-nlm-cde.mjs <org> [classification…] [flags]
//
// Examples:
//   node scripts/fetch-nlm-cde.mjs NINDS Disease Epilepsy --study-type=Clinical
//   node scripts/fetch-nlm-cde.mjs NIDA
//   node scripts/fetch-nlm-cde.mjs NHLBI --study-type=Clinical \
//        --source-key=nlm-nhlbi --label="NLM NHLBI"
//
// Flags:
//   --study-type=Clinical|Preclinical
//   --source-key=<custom-source-key>  (default: nlm-<org-lower>[-<class>...])
//   --label="<display label>"        (default: NLM <ORG> <Class>...)
//   --out=<dir>                       (default: <source-key>-data)
//
// Endpoints (reverse-engineered from the SPA at /cde/search):
//   POST https://cde.nlm.nih.gov/server/de/search    — CDE search
//   POST https://cde.nlm.nih.gov/server/form/search  — Form (CRF) search
// Both accept the same Elasticsearch-style query body.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── CLI parsing ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of argv) {
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else flags[a.slice(2)] = true;
  } else positional.push(a);
}
if (positional.length < 1) {
  console.error('Usage: node scripts/fetch-nlm-cde.mjs <org> [classification…] [--study-type=…] [--source-key=…] [--label=…] [--out=…]');
  process.exit(1);
}
const ORG = positional[0];
const CLASSIFICATION = positional.slice(1);
const STUDY_TYPE = flags['study-type'] ?? null;
const SLUG = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const KEY_PARTS = [ORG, ...CLASSIFICATION].map(SLUG).filter(Boolean);
const SOURCE_KEY = flags['source-key'] ?? `nlm-${KEY_PARTS.join('-')}`;
const SOURCE_LABEL = flags['label'] ?? `NLM ${[ORG, ...CLASSIFICATION].join(' ')}`;
const OUT = resolve(ROOT, flags['out'] ?? `data/${SOURCE_KEY}`);
const META = resolve(OUT, 'metadata');
const TODAY = new Date().toISOString().slice(0, 10);

const API = 'https://cde.nlm.nih.gov';
const HEADERS = { 'Content-Type': 'application/json' };

// ── Helpers ──────────────────────────────────────────────────────────────────

function uid(s) {
  const h = createHash('sha1').update(`${SOURCE_KEY}:${s}`).digest('hex');
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

function nullIfEmpty(s) {
  if (s == null) return null;
  const t = String(s).trim();
  return t || null;
}

function pipe(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const filtered = arr.map((x) => (x == null ? '' : String(x))).filter(Boolean);
  return filtered.length ? filtered.join('|') : null;
}

function slug(s) {
  return String(s).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
}

/** NLM datatypes already align with our enum; pass through with safe fallback. */
function mapDataType(dt) {
  const t = (dt || '').trim();
  const allowed = new Set(['Value List', 'Text', 'Number', 'Date', 'Time', 'Datetime', 'Geolocation', 'File/URI/URL', 'Other']);
  if (allowed.has(t)) return t;
  if (t === 'Externally Defined') return 'Other';
  if (!t) return 'Other';
  return 'Other';
}

/**
 * Walk an NLM `classification[]` tree and extract the structured sub-elements
 * we care about for our schema: domain/subdomain/category, classification tier,
 * population. NLM nests these under (steward → Disease → <name> → {Classification, Domain, Population}).
 */
function extractClassification(classifications, focusDisease) {
  const out = { domain: null, subdomain: null, category: null, tier: null, populations: new Set(), disease: null };
  if (!Array.isArray(classifications)) return out;
  // Each classification[] entry is rooted at a steward org with `elements[]`.
  // Population can appear as a top-level sibling AND nested under
  // Disease > <name> > Population. NINDS Disease/Epilepsy CDEs typically
  // emit BOTH Adult and Pediatric as parallel paths; we collect every one.
  for (const root of classifications) {
    for (const top of root.elements ?? []) {
      // top.name is e.g. 'Disease', 'Domain', 'Population'.
      if (top.name === 'Disease') {
        for (const dis of top.elements ?? []) {
          if (focusDisease && dis.name?.toLowerCase() !== focusDisease.toLowerCase()) continue;
          out.disease = dis.name;
          for (const sub of dis.elements ?? []) {
            if (sub.name === 'Classification' && sub.elements?.[0]?.name) {
              out.tier = sub.elements[0].name;
            } else if (sub.name === 'Domain') {
              const d = sub.elements?.[0];
              if (d) {
                out.domain = d.name;
                const sd = d.elements?.[0];
                if (sd) out.subdomain = sd.name;
              }
            } else if (sub.name === 'Population') {
              for (const p of sub.elements ?? []) if (p.name) out.populations.add(p.name);
            }
          }
        }
      } else if (top.name === 'Domain' && !out.domain) {
        const d = top.elements?.[0];
        if (d) {
          out.domain = d.name;
          const sd = d.elements?.[0];
          if (sd) out.subdomain = sd.name;
        }
      } else if (top.name === 'Population') {
        for (const p of top.elements ?? []) if (p.name) out.populations.add(p.name);
      }
    }
  }
  return out;
}

/** Recursively flatten an NLM `formElements[]` tree into our flat items list. */
function flattenFormItems(elements, items = []) {
  if (!Array.isArray(elements)) return items;
  for (const el of elements) {
    if (el.elementType === 'section') {
      items.push({
        type: 'section',
        label: el.label || el.section?.name || null,
        instructions: el.instructions?.value ?? null,
      });
      flattenFormItems(el.formElements, items);
    } else if (el.elementType === 'question') {
      const ref = el.label || el.question?.cde?.name || el.question?.label || null;
      if (ref) items.push({ type: 'cde', ref });
    }
  }
  return items;
}

// ── Fetchers ─────────────────────────────────────────────────────────────────

const baseSearchBody = {
  resultPerPage: 100,
  searchTerm: '',
  selectedOrg: ORG,
  selectedOrgAlt: '',
  excludeAllOrgs: false,
  excludeOrgs: [],
  includeRetired: false,
  selectedElements: CLASSIFICATION,
  selectedElementsAlt: [],
  page: 1,
  includeAggregations: false,
  meshTree: '',
  selectedAdminStatuses: [],
  selectedStatuses: [],
  selectedDatatypes: [],
  selectedCopyrightStatus: [],
  searchToken: 'fetch-nlm-cde-mjs',
  nihEndorsed: false,
};

async function fetchAll(endpoint, key) {
  const all = [];
  let page = 1;
  let totalItems = null;
  while (true) {
    const r = await postJSON(endpoint, { ...baseSearchBody, page });
    const items = r[key] ?? [];
    all.push(...items);
    if (totalItems == null) totalItems = r.totalItems ?? items.length;
    process.stdout.write(`    page ${page}: +${items.length} (${all.length} so far)\r`);
    if (!items.length) break;
    page++;
    // Hard guard: NLM caps at ~10 pages × resultPerPage; if we've stopped
    // making progress, exit.
    if (page > 50) break;
  }
  process.stdout.write('\n');
  return all;
}

// ── Transform ────────────────────────────────────────────────────────────────

function buildCdeRecords(cdes, focusDisease) {
  const records = [];
  const tinyIdToUuid = new Map();
  const cdeIdToUuid = new Map(); // org code (e.g. C13053) → uuid

  for (const c of cdes) {
    const tinyId = c.tinyId;
    if (!tinyId) continue;
    const designations = c.designations ?? [];
    const designation = designations[0]?.designation;
    const definition = c.definitions?.[0]?.definition;
    if (!designation) continue;

    // Prefer the org's own code (e.g. NINDS "C13053") as nlm_identifier so that
    // the canonical-key dedup matches against parquet sources keyed by the
    // same code (e.g. our cde-editor NINDS extraction).
    const orgIdEntry = (c.ids ?? []).find((i) => i.source === ORG);
    const orgCode = orgIdEntry?.id ?? null;

    const otherIds = (c.ids ?? [])
      .filter((i) => i.source !== ORG && i.id)
      .map((i) => `${i.source}:${i.id}`);
    if (tinyId) otherIds.push(`NLM:${tinyId}`);

    const decConcepts = c.dataElementConcept?.concepts ?? [];
    const dec_identifier = pipe(decConcepts.map((d) => d.originId || d.name));
    const dec_terminology_source = pipe(decConcepts.map((d) => d.origin));
    // The concept's human-readable preferred name (e.g. "Address", "Age").
    const dec_name = pipe(decConcepts.map((d) => d.name || ''));

    // Permissible values: NLM ships rich per-PV metadata that we used to drop
    // entirely. Now we capture the full constellation: label, code (a stable
    // value-meaning code distinct from the user-facing label), definition,
    // and the per-PV concept mapping (codeSystemName + conceptId + conceptSource).
    const pvs = c.valueDomain?.permissibleValues ?? [];
    const pv_labels = pipe(pvs.map((p) => p.valueMeaningName || p.permissibleValue));
    const pv_codes = pipe(pvs.map((p) => p.valueMeaningCode || p.permissibleValue || ''));
    const pv_definitions = pipe(pvs.map((p) => p.valueMeaningDefinition || ''));
    const pv_code_systems = pipe(pvs.map((p) => p.codeSystemName || ''));
    const pv_concept_identifiers = pipe(pvs.map((p) => p.conceptId || ''));
    const pv_terminology_sources = pipe(pvs.map((p) => p.conceptSource || ''));

    // Numeric constraints — datatypeNumber.{minValue,maxValue}.
    const dtn = c.valueDomain?.datatypeNumber;
    const min_value = dtn?.minValue != null ? String(dtn.minValue) : null;
    const max_value = dtn?.maxValue != null ? String(dtn.maxValue) : null;

    // Unit of measure ships on the value domain.
    const unit_of_measure = nullIfEmpty(c.valueDomain?.uom);

    // Keywords land in NLM's properties bag as { key:'Keyword', value:'…' }.
    const keywords = pipe(
      (c.properties ?? [])
        .filter((p) => (p.key || '').toLowerCase() === 'keyword')
        .map((p) => p.value || ''),
    );

    // Aliases — every designation past the first.
    const aliases = pipe(designations.slice(1).map((d) => d.designation || ''));

    // Lifecycle marker (Standard / Qualified / Recorded / Candidate / Retired).
    const registration_status = nullIfEmpty(c.registrationState?.registrationStatus);

    // Owning organization. NLM federates many stewards (caDSR, NINDS, NHLBI,
    // CTEP, NIDA, …); steward_org keeps that distinction even though our
    // top-level cde_source collapses them all to "NLM …".
    const steward_org = nullIfEmpty(c.stewardOrg?.name);

    // Population (Adult / Pediatric / both) — collected from the
    // classification[] tree's Population nodes by extractClassification().
    const meta = extractClassification(c.classification, focusDisease);
    const population = meta.populations.size
      ? [...meta.populations].sort().join(';')
      : null;

    const refs = (c.referenceDocuments ?? [])
      .map((r) => r.document)
      .filter(Boolean)
      .join('; ');

    const uuid = uid(`cde:${tinyId}`);
    tinyIdToUuid.set(tinyId, uuid);
    if (orgCode) cdeIdToUuid.set(orgCode, uuid);

    records.push({
      id: uuid,
      data: {
        cde_name: designation,
        aliases,
        cde_data_type: mapDataType(c.valueDomain?.datatype),
        cde_definition: nullIfEmpty(definition) || designation,
        cde_source: SOURCE_LABEL,
        cde_type: null,
        steward_org,
        registration_status,
        keywords,
        preferred_question_text: null,
        pv_codes,
        pv_labels,
        pv_definitions,
        pv_code_systems,
        pv_concept_identifiers,
        pv_terminology_sources,
        unit_of_measure,
        // Numeric value-domain bounds (CDE-intrinsic, not per-classification).
        min_value,
        max_value,
        // Whether this CDE is observed vs derived. NLM ships everything as
        // 'COLLECTED'; we keep the field on cde so other sources can vary.
        cde_origin: 'COLLECTED',
        // Population scope (CDE-intrinsic). Pipe-joined with ';' to match
        // NINDS's "Adult;Pediatric" convention.
        population,
        // CDISC mapping is a CDE identity, not a per-classification thing.
        // NLM doesn't expose CDISC fields directly, but PTE-clinical and
        // NINDS sometimes do; left null on NLM rows.
        cdisc_domain: null,
        cdisc_variable_name: null,
        cdisc_variable_label: null,
        references: nullIfEmpty(refs),
        // Use the org's code (e.g., NINDS C13053) so canonical_key joins across
        // sources extracted via different paths. Falls back to NLM tinyId.
        nlm_identifier: orgCode ?? tinyId,
        dec_identifier,
        dec_terminology_source,
        dec_name,
        other_identifiers: otherIds.length ? otherIds.join('|') : null,
      },
    });
  }

  return { records, tinyIdToUuid, cdeIdToUuid };
}

function buildClassifications(cdes, tinyIdToUuid) {
  const records = [];
  const classifies = [];

  // Decide which disease (if any) to mark on the disease_<X> column based on
  // the CLI classification path. e.g. `Disease Epilepsy` → 'epilepsy'.
  const focusDisease =
    CLASSIFICATION[0] === 'Disease' && CLASSIFICATION[1] ? CLASSIFICATION[1] : null;
  const diseaseCol = focusDisease ? `disease_${SLUG(focusDisease).replace(/-/g, '_')}` : null;
  const tierCol = focusDisease ? `classification_${SLUG(focusDisease).replace(/-/g, '_')}` : null;

  for (const c of cdes) {
    const cdeUuid = tinyIdToUuid.get(c.tinyId);
    if (!cdeUuid) continue;
    const meta = extractClassification(c.classification, focusDisease);
    const orgCode = (c.ids ?? []).find((i) => i.source === ORG)?.id;
    const variableName = orgCode ?? c.tinyId;
    const versionDate = (c.updated || c.imported || `${TODAY}T00:00:00`).slice(0, 10);

    // Classification rows now describe ONLY the disease scope + tier + the
    // (CDE × disease) hierarchical placement. CDE-intrinsic fields
    // (min/max, cdisc_*, cde_origin, population) live on cde directly.
    const data = {
      variable_name: variableName,
      version_name: `${SOURCE_LABEL} v${c.version ?? '1.0'}`,
      version_date: versionDate,
      notes: null,
      additional_instructions: null,
      // Disease columns: leave all 'N' by default; the focus disease is set
      // explicitly. Existing dashboard view supports a small set hardcoded; new
      // disease columns get auto-rendered when the lens is set up for them.
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
      domain: nullIfEmpty(meta.domain),
      subdomain: nullIfEmpty(meta.subdomain),
      category: nullIfEmpty(meta.category) ?? null,
    };
    if (diseaseCol) {
      data[diseaseCol] = 'Y';
      data[tierCol] = nullIfEmpty(meta.tier);
    }

    const clsUuid = uid(`cls:${c.tinyId}`);
    records.push({ id: clsUuid, data });
    classifies.push([clsUuid, cdeUuid]);
  }

  return { records, classifies };
}

function buildCrfRecords(forms, cdeIdToUuid) {
  const records = [];
  const seenNames = new Set();
  for (const f of forms) {
    const designation = f.designations?.[0]?.designation;
    if (!designation) continue;
    let base = slug(designation) || `form_${f.tinyId}`;
    let name = base;
    let n = 2;
    while (seenNames.has(name)) name = `${base}_${n++}`;
    seenNames.add(name);
    const items = flattenFormItems(f.formElements);
    records.push({
      id: uid(`crf:${f.tinyId}`),
      data: {
        crf_name: name,
        title: designation,
        description: nullIfEmpty(f.definitions?.[0]?.definition),
        instructions: null,
        external_url: null,
        version: f.version ?? '1.0',
        disease_scope: CLASSIFICATION[1] ?? null,
        estimated_duration_minutes: null,
        collection_frequency: null,
        items,
      },
    });
  }
  return records;
}

// ── Emit ─────────────────────────────────────────────────────────────────────

function emit({ cdeRecords, clsRecords, crfRecords, classifies, provenance }) {
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

  writeJsonl(resolve(META, 'models/cde/versions/1'), schemaCde, cdeRecords);
  writeJsonl(resolve(META, 'models/cde_classification/versions/1'), schemaCls, clsRecords);
  writeJsonl(resolve(META, 'models/crf/versions/1'), schemaCrf, crfRecords);
  writeJsonl(resolve(META, 'models/provenance/versions/1'), schemaProv, [provenance]);

  const relLines = ['source_record_id,target_record_id,relationship_type'];
  for (const [s, t] of classifies) relLines.push(`${s},${t},CLASSIFIES`);
  for (const r of cdeRecords) relLines.push(`${r.id},${provenance.id},SOURCED_FROM`);
  for (const r of clsRecords) relLines.push(`${r.id},${provenance.id},SOURCED_FROM`);
  writeFileSync(resolve(META, 'relationships.csv'), relLines.join('\n') + '\n');

  writeFileSync(resolve(META, 'files.csv'), 'name,path,size,fileType\n');

  writeFileSync(
    resolve(OUT, 'manifest.json'),
    JSON.stringify(
      {
        name: SOURCE_LABEL,
        description: `Extracted from cde.nlm.nih.gov for org=${ORG}${CLASSIFICATION.length ? `, classification=[${CLASSIFICATION.join(', ')}]` : ''}.`,
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
  console.log(`NLM CDE Repository fetch`);
  console.log(`  org:            ${ORG}`);
  console.log(`  classification: ${CLASSIFICATION.length ? CLASSIFICATION.join(' › ') : '(none)'}`);
  console.log(`  source-key:     ${SOURCE_KEY}`);
  console.log(`  label:          ${SOURCE_LABEL}`);
  console.log(`  study-type:     ${STUDY_TYPE ?? '(unset)'}`);
  console.log(`  out:            ${OUT}`);
  console.log('');

  console.log('Fetching CDEs…');
  const cdes = await fetchAll('/server/de/search', 'cdes');
  console.log(`  → ${cdes.length} CDEs`);

  console.log('Fetching CRFs…');
  const forms = await fetchAll('/server/form/search', 'forms');
  console.log(`  → ${forms.length} CRFs`);

  const focusDisease =
    CLASSIFICATION[0] === 'Disease' && CLASSIFICATION[1] ? CLASSIFICATION[1] : null;
  const { records: cdeRecords, tinyIdToUuid, cdeIdToUuid } = buildCdeRecords(cdes, focusDisease);
  const { records: clsRecords, classifies } = buildClassifications(cdes, tinyIdToUuid);
  const crfRecords = buildCrfRecords(forms, cdeIdToUuid);

  const provenance = {
    id: uid(`provenance:${SOURCE_KEY}`),
    data: {
      source_key: SOURCE_KEY,
      label: SOURCE_LABEL,
      study_type: STUDY_TYPE,
    },
  };

  emit({ cdeRecords, clsRecords, crfRecords, classifies, provenance });

  console.log('');
  console.log(`Wrote ${OUT}:`);
  console.log(`  cde:                ${cdeRecords.length}`);
  console.log(`  cde_classification: ${clsRecords.length}`);
  console.log(`  crf:                ${crfRecords.length}`);
  console.log(`  provenance:         1`);
  console.log('');
  console.log(`Next:  node scripts/prepare-data.mjs data/demo data/ninds-epilepsy ${OUT.replace(ROOT + '/', '')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
