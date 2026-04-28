// Build a JSON Schema (draft 2020-12) document for a single CRF.
//
// Each CDE on the form becomes one property in the root object. Bundles
// are flattened into the same property bag (their member CDEs surface
// alongside standalone CDEs, mirroring REDCap export behavior).
//
// Sections are surfaced via an `x-section` annotation on each subsequent
// property until the next section, plus a top-level `x-sections` array
// that lists section labels in order — JSON Schema has no native section
// concept, but the extension keys round-trip cleanly.

import { splitPipe, type CrfRecord } from '@/types';

export interface JsonSchemaCdeInput {
  cde_name: string;
  cde_data_type: string;
  cde_definition: string | null;
  preferred_question_text: string | null;
  variable_name: string | null;
  unit_of_measure: string | null;
  pv_labels: string | null;
  pv_codes: string | null;
  pv_definitions: string | null;
  min_value: number | null;
  max_value: number | null;
  nlm_identifier: string | null;
  cde_id: string | null;
  // Per-disease classification — used to derive Core-as-required when a
  // specific disease scope is known, with "best tier across diseases" as
  // fallback for CRFs that aren't disease-scoped.
  classification_agnostic: string | null;
  classification_neurotrauma: string | null;
  classification_tbi: string | null;
  classification_pte: string | null;
  classification_sci: string | null;
  classification_epilepsy: string | null;
}

export interface JsonSchemaBundleInput {
  bundle_name: string;
  bundle_id?: string | null;
  cdes: JsonSchemaCdeInput[];
}

interface JsonSchemaProperty {
  type?: string | string[];
  /** Human-readable CDE label — JSON Schema's standard `title` keyword.
   *  Sits alongside `description` (the CDE definition). */
  title?: string;
  description?: string;
  enum?: Array<string | number>;
  format?: string;
  minimum?: number;
  maximum?: number;
  // x- extensions are preserved by every JSON Schema validator and let us
  // round-trip CDE-specific metadata that has no standard keyword.
  'x-cde-id'?: string;
  'x-nlm-id'?: string;
  'x-unit'?: string;
  'x-enum-labels'?: string[];
  'x-enum-definitions'?: string[];
  'x-section'?: string;
  'x-bundle'?: string;
  /** Effective classification tier — Core / Recommended / Supplemental.
   *  Drives the schema's `required` array (Core → required). */
  'x-classification'?: 'Core' | 'Recommended' | 'Supplemental';
}

interface JsonSchemaDoc {
  $schema: string;
  $id: string;
  title: string;
  description?: string;
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  /** Reject extra fields when validating data records — keeps collected
   *  data tight to the form's contract. Set to false; consumers that want
   *  extensibility can override post-export. */
  additionalProperties: boolean;
  'x-crf-name': string;
  'x-version': string;
  /** Reviewer/data-collector instructions in markdown. JSON Schema has no
   *  native slot for procedural guidance, so we surface it as an extension. */
  'x-instructions'?: string;
  'x-disease-scope'?: string;
  'x-study-type'?: string;
  'x-collection-frequency'?: string;
  'x-estimated-duration-minutes'?: number;
  'x-sections'?: string[];
  'x-source': string;
}

function toPropertyName(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'x_$1')
    .replace(/_+/g, '_');
  return slug || 'field';
}

function uniquePropertyName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) {
    existing.add(base);
    return base;
  }
  let i = 2;
  while (existing.has(`${base}_${i}`)) i++;
  const name = `${base}_${i}`;
  existing.add(name);
  return name;
}

/** Map a CRF's free-text `disease_scope` to one of our disease keys. Lenient:
 *  case-insensitive contains-check against the long labels and keys. Returns
 *  null when no match — caller should fall back to the cross-disease "best"
 *  tier. */
function diseaseKeyFromScope(scope: string | null | undefined): string | null {
  if (!scope) return null;
  const s = scope.trim().toLowerCase();
  // Order matters — match the more-specific labels before the broader ones
  // so "Post-Traumatic Epilepsy" lands on PTE, not Epilepsy.
  const keys: Array<{ key: string; needles: string[] }> = [
    { key: 'pte', needles: ['post-traumatic epilepsy', 'pte'] },
    { key: 'tbi', needles: ['traumatic brain injury', 'tbi'] },
    { key: 'sci', needles: ['spinal cord injury', 'sci'] },
    { key: 'neurotrauma', needles: ['neurotrauma'] },
    { key: 'epilepsy', needles: ['epilepsy'] },
    { key: 'agnostic', needles: ['agnostic', 'disease-agnostic'] },
  ];
  for (const { key, needles } of keys) {
    if (needles.some((n) => s.includes(n))) return key;
  }
  return null;
}

const ALL_CLASSIFICATION_COLS: Array<keyof JsonSchemaCdeInput> = [
  'classification_agnostic',
  'classification_neurotrauma',
  'classification_tbi',
  'classification_pte',
  'classification_sci',
  'classification_epilepsy',
];

/** Effective tier for a CDE under a given disease lens.
 *  - When `diseaseKey` is set, read just that disease's classification column
 *    so "required" reflects the disease the CRF is actually about.
 *  - When null (no disease scope on the CRF and no override), fall back to
 *    "best across diseases" — Core > Recommended > Supplemental. */
function effectiveTier(
  cde: JsonSchemaCdeInput,
  diseaseKey: string | null,
): 'Core' | 'Recommended' | 'Supplemental' | null {
  if (diseaseKey) {
    const col = `classification_${diseaseKey}` as keyof JsonSchemaCdeInput;
    const v = cde[col] as string | null | undefined;
    if (v === 'Core' || v === 'Recommended' || v === 'Supplemental') return v;
    return null;
  }
  const tiers = ALL_CLASSIFICATION_COLS.map((c) => cde[c] as string | null);
  if (tiers.includes('Core')) return 'Core';
  if (tiers.includes('Recommended')) return 'Recommended';
  if (tiers.includes('Supplemental')) return 'Supplemental';
  return null;
}

function cdeToProperty(
  cde: JsonSchemaCdeInput,
  diseaseKey: string | null,
): JsonSchemaProperty {
  const dt = (cde.cde_data_type ?? '').toLowerCase();
  const prop: JsonSchemaProperty = {
    title: cde.cde_name,
  };
  if (cde.cde_definition) prop.description = cde.cde_definition;

  switch (dt) {
    case 'value list': {
      prop.type = 'string';
      const labels = splitPipe(cde.pv_labels);
      const codes = splitPipe(cde.pv_codes);
      const defs = splitPipe(cde.pv_definitions);
      // Prefer codes for the canonical enum (machine-friendly); fall back to
      // labels when no codes are published. Always emit labels as a sibling
      // x-enum-labels array so consumers can render human-readable choices.
      const enumValues = codes.length === labels.length && codes.length ? codes : labels;
      if (enumValues.length) prop.enum = enumValues;
      if (labels.length) prop['x-enum-labels'] = labels;
      if (defs.length) prop['x-enum-definitions'] = defs;
      break;
    }
    case 'number': {
      prop.type = 'number';
      if (cde.min_value != null) prop.minimum = cde.min_value;
      if (cde.max_value != null) prop.maximum = cde.max_value;
      break;
    }
    case 'date':
      prop.type = 'string';
      prop.format = 'date';
      break;
    case 'time':
      prop.type = 'string';
      prop.format = 'time';
      break;
    case 'datetime':
      prop.type = 'string';
      prop.format = 'date-time';
      break;
    case 'file/uri/url':
      prop.type = 'string';
      prop.format = 'uri';
      break;
    case 'geolocation':
      // No JSON Schema standard for geolocation; emit a {lat, lon} shape that
      // matches GeoJSON's "Point" coordinates ordering.
      prop.type = 'object';
      break;
    case 'text':
    case 'other':
    default:
      prop.type = 'string';
      break;
  }

  if (cde.unit_of_measure) prop['x-unit'] = cde.unit_of_measure;
  if (cde.nlm_identifier) prop['x-nlm-id'] = cde.nlm_identifier;
  if (cde.cde_id) prop['x-cde-id'] = cde.cde_id;
  const tier = effectiveTier(cde, diseaseKey);
  if (tier) prop['x-classification'] = tier;

  return prop;
}

export function buildJsonSchema(
  crf: CrfRecord,
  cdesByRef: Map<string, JsonSchemaCdeInput>,
  bundlesByRef: Map<string, JsonSchemaBundleInput>,
  /** Optional override; defaults to mapping crf.disease_scope to a key. */
  diseaseKeyOverride?: string | null,
): { schema: JsonSchemaDoc; fieldCount: number; missingRefs: string[]; diseaseKey: string | null } {
  const baseId = `https://cde.epilepsy.science/crf/${encodeURIComponent(crf.crf_name)}.json`;
  const diseaseKey = diseaseKeyOverride ?? diseaseKeyFromScope(crf.disease_scope);

  const doc: JsonSchemaDoc = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: baseId,
    title: crf.title,
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
    'x-crf-name': crf.crf_name,
    'x-version': crf.version,
    'x-source': 'Pennsieve CDE Review Dashboard',
  };
  if (crf.description) doc.description = crf.description;
  if (crf.instructions) doc['x-instructions'] = crf.instructions;
  if (crf.disease_scope) doc['x-disease-scope'] = crf.disease_scope;
  if (crf.study_type) doc['x-study-type'] = crf.study_type;
  if (crf.collection_frequency) doc['x-collection-frequency'] = crf.collection_frequency;
  if (crf.estimated_duration_minutes != null) {
    doc['x-estimated-duration-minutes'] = crf.estimated_duration_minutes;
  }

  const sections: string[] = [];
  const existing = new Set<string>();
  const missingRefs: string[] = [];
  let currentSection: string | null = null;

  const addCde = (cde: JsonSchemaCdeInput, bundleName?: string) => {
    // Property key = the source's stable ID handle: variable_name when set
    // (NINDS/NLM convention, e.g. C01013_F1105 or AGE_YRS), else a slug of
    // cde_name. Either way, display_name on the property carries the
    // human-readable CDE name.
    const idSource = cde.variable_name?.replace(/^[A-Z0-9_-]+:/, '').trim();
    const base = idSource ? toPropertyName(idSource) : toPropertyName(cde.cde_name);
    const name = uniquePropertyName(base, existing);
    const prop = cdeToProperty(cde, diseaseKey);
    if (currentSection) prop['x-section'] = currentSection;
    if (bundleName) prop['x-bundle'] = bundleName;
    doc.properties[name] = prop;
    if (prop['x-classification'] === 'Core') doc.required.push(name);
  };

  for (const item of crf.items) {
    if (item.type === 'section') {
      currentSection = item.label ?? '';
      if (currentSection && !sections.includes(currentSection)) {
        sections.push(currentSection);
      }
      continue;
    }
    if (item.type === 'cde' && item.ref) {
      const cde = cdesByRef.get(item.ref);
      if (!cde) {
        missingRefs.push(`cde:${item.ref}`);
        continue;
      }
      addCde(cde);
      continue;
    }
    if (item.type === 'bundle' && item.ref) {
      const bundle = bundlesByRef.get(item.ref);
      if (!bundle) {
        missingRefs.push(`bundle:${item.ref}`);
        continue;
      }
      for (const cde of bundle.cdes) addCde(cde, bundle.bundle_name);
    }
  }

  if (sections.length) doc['x-sections'] = sections;

  return {
    schema: doc,
    fieldCount: Object.keys(doc.properties).length,
    missingRefs,
    diseaseKey,
  };
}

export function downloadJsonSchema(crf: CrfRecord, schema: JsonSchemaDoc) {
  const name = (crf.crf_name || crf.title).replace(/\s+/g, '_');
  const json = JSON.stringify(schema, null, 2);
  const blob = new Blob([json], { type: 'application/schema+json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}_schema.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
