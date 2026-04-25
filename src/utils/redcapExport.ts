// Build a REDCap Data Dictionary CSV for a single CRF.
//
// REDCap import expects 18 columns in a fixed order. Column descriptions:
// https://help.redcap.vanderbilt.edu/  → "Data Dictionary File Format".
//
// The tricky piece: REDCap's "Section Header" is attached to the next field,
// not to a standalone row. So CRF section items get absorbed into the header
// cell of the immediately-following CDE/bundle-member row.

import { splitPipe, type CrfRecord } from '@/types';

// Minimal CDE shape this exporter needs. Matches CrfDetailView's ResolvedCde
// subset — kept here so the utility can be called from anywhere.
export interface RedcapCdeInput {
  cde_name: string;
  cde_data_type: string;
  cde_definition: string | null;
  preferred_question_text: string | null;
  variable_name: string | null;
  unit_of_measure: string | null;
  pv_labels: string | null;
  pv_codes: string | null;
  min_value: number | null;
  max_value: number | null;
}

export interface RedcapBundleInput {
  bundle_name: string;
  cdes: RedcapCdeInput[];
}

export const REDCAP_COLUMNS = [
  'Variable / Field Name',
  'Form Name',
  'Section Header',
  'Field Type',
  'Field Label',
  'Choices, Calculations, OR Slider Labels',
  'Field Note',
  'Text Validation Type OR Show Slider Number',
  'Text Validation Min',
  'Text Validation Max',
  'Identifier?',
  'Branching Logic (Show field only if...)',
  'Required Field?',
  'Custom Alignment',
  'Question Number (surveys only)',
  'Matrix Group Name',
  'Matrix Ranking?',
  'Field Annotation',
] as const;

type RedcapRow = string[];

/** REDCap field names must be lowercase, alphanumeric + underscore, start with a
 *  letter, and at most 26 chars. */
function toRedcapFieldName(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'x_$1')
    .replace(/_+/g, '_');
  return (slug || 'field').slice(0, 26);
}

/** Map NT-PRECEDS CDE data type to REDCap Field Type + Text Validation Type. */
function mapFieldType(dtype: string, pvCount: number): {
  fieldType: string;
  validation: string;
} {
  const t = (dtype ?? '').toLowerCase();
  if (t === 'value list') {
    // Short lists → radio, longer → dropdown. 6 is the Vanderbilt-recommended
    // visual-comfort cutoff; adjust to taste.
    return { fieldType: pvCount > 6 ? 'dropdown' : 'radio', validation: '' };
  }
  if (t === 'text') return { fieldType: 'text', validation: '' };
  if (t === 'number') return { fieldType: 'text', validation: 'number' };
  if (t === 'date') return { fieldType: 'text', validation: 'date_ymd' };
  if (t === 'time') return { fieldType: 'text', validation: 'time' };
  if (t === 'datetime') return { fieldType: 'text', validation: 'datetime_seconds_ymd' };
  if (t === 'file/uri/url') return { fieldType: 'text', validation: '' };
  if (t === 'geolocation') return { fieldType: 'text', validation: '' };
  return { fieldType: 'text', validation: '' };
}

/** Build the REDCap Choices column: "code1, label1 | code2, label2". If codes
 *  are missing, fall back to "1, label1 | 2, label2". */
function buildChoices(cde: RedcapCdeInput): string {
  const labels = splitPipe(cde.pv_labels);
  if (!labels.length) return '';
  const codes = splitPipe(cde.pv_codes);
  return labels
    .map((label, i) => {
      const code = codes[i] ?? String(i + 1);
      return `${code}, ${label}`;
    })
    .join(' | ');
}

/** CSV-escape a single cell: if it contains comma, quote, or newline, wrap in
 *  double quotes and double any internal quotes. */
function csvCell(v: string | number | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function cdeToRow(
  cde: RedcapCdeInput,
  formName: string,
  sectionHeader: string,
  existingNames: Set<string>,
): RedcapRow {
  // Prefer the classification's variable_name stripped of any "NT-PRECEDS:"-style
  // prefix; fall back to the CDE name.
  const base = cde.variable_name
    ? cde.variable_name.replace(/^[A-Z0-9_-]+:/, '')
    : cde.cde_name;
  let fieldName = toRedcapFieldName(base);
  // Guarantee uniqueness within this CSV.
  if (existingNames.has(fieldName)) {
    let i = 2;
    while (existingNames.has(`${fieldName.slice(0, 24)}_${i}`)) i++;
    fieldName = `${fieldName.slice(0, 24)}_${i}`;
  }
  existingNames.add(fieldName);

  const pvCount = splitPipe(cde.pv_labels).length;
  const { fieldType, validation } = mapFieldType(cde.cde_data_type, pvCount);
  const choices = fieldType === 'radio' || fieldType === 'dropdown' ? buildChoices(cde) : '';
  const label = cde.preferred_question_text ?? cde.cde_name;
  const note = cde.unit_of_measure ? `Unit: ${cde.unit_of_measure}` : '';

  return [
    fieldName,
    formName,
    sectionHeader,
    fieldType,
    label,
    choices,
    note,
    validation,
    cde.min_value == null ? '' : String(cde.min_value),
    cde.max_value == null ? '' : String(cde.max_value),
    '', // Identifier?
    '', // Branching Logic
    '', // Required Field? — left blank for reviewer to set per-study
    '', // Custom Alignment
    '', // Question Number
    '', // Matrix Group Name
    '', // Matrix Ranking?
    cde.cde_definition ?? '', // Field Annotation — definition is useful context
  ];
}

export function buildRedcapCsv(
  crf: CrfRecord,
  cdesByRef: Map<string, RedcapCdeInput>,
  bundlesByRef: Map<string, RedcapBundleInput>,
): { csv: string; fieldCount: number; missingRefs: string[] } {
  const formName = toRedcapFieldName(crf.crf_name || crf.title);
  const rows: RedcapRow[] = [REDCAP_COLUMNS.slice()];
  const existingNames = new Set<string>();
  const missingRefs: string[] = [];
  let pendingHeader = '';

  const consumeHeader = () => {
    const h = pendingHeader;
    pendingHeader = '';
    return h;
  };

  for (const item of crf.items) {
    if (item.type === 'section') {
      pendingHeader = item.label ?? '';
      continue;
    }
    if (item.type === 'cde' && item.ref) {
      const cde = cdesByRef.get(item.ref);
      if (!cde) {
        missingRefs.push(`cde:${item.ref}`);
        continue;
      }
      rows.push(cdeToRow(cde, formName, consumeHeader(), existingNames));
      continue;
    }
    if (item.type === 'bundle' && item.ref) {
      const bundle = bundlesByRef.get(item.ref);
      if (!bundle) {
        missingRefs.push(`bundle:${item.ref}`);
        continue;
      }
      // Only the first member row carries the pending section header.
      let header = consumeHeader();
      if (bundle.cdes.length === 0) continue;
      for (const cde of bundle.cdes) {
        rows.push(cdeToRow(cde, formName, header, existingNames));
        header = '';
      }
    }
  }

  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  return { csv, fieldCount: rows.length - 1, missingRefs };
}

export function downloadRedcapCsv(crf: CrfRecord, csv: string) {
  const name = (crf.crf_name || crf.title).replace(/\s+/g, '_');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}_redcap_data_dictionary.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
