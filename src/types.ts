export interface CdeRow {
  cde_id: string;
  cde_name: string;
  cde_data_type: string;
  cde_definition: string;
  cde_source: string | null;
  cde_type: string | null;
  keywords: string | null;
  preferred_question_text: string | null;

  pv_labels: string | null;
  pv_codes: string | null;
  pv_definitions: string | null;
  pv_code_systems: string | null;
  pv_concept_identifiers: string | null;
  pv_terminology_sources: string | null;
  pv_uri: string | null;
  unit_of_measure: string | null;
  refs: string | null;
  nlm_identifier: string | null;
  dec_identifier: string | null;
  dec_terminology_source: string | null;
  other_identifiers: string | null;

  variable_name: string | null;
  cdisc_domain: string | null;
  cdisc_variable_name: string | null;
  cdisc_variable_label: string | null;
  cde_origin: string | null;
  version_name: string | null;
  version_date: string | null;
  min_value: number | null;
  max_value: number | null;
  classification_notes: string | null;
  additional_instructions: string | null;

  disease_agnostic: 'Y' | 'N' | null;
  disease_neurotrauma: 'Y' | 'N' | null;
  disease_tbi: 'Y' | 'N' | null;
  disease_pte: 'Y' | 'N' | null;
  disease_sci: 'Y' | 'N' | null;

  classification_agnostic: string | null;
  classification_neurotrauma: string | null;
  classification_tbi: string | null;
  classification_pte: string | null;
  classification_sci: string | null;

  bundle_id: string | null;
  bundle_name: string | null;
  bundle_domain: string | null;
  bundle_subdomain: string | null;
  bundle_category: string | null;
  bundle_working_group: string | null;

  // CDE-level taxonomy from cde_full (COALESCE(cl.<col>, b.<col>)). Surfaces on
  // every row regardless of whether the CDE belongs to a bundle.
  cde_domain: string | null;
  cde_subdomain: string | null;
  cde_category: string | null;

  source_labels: string | null;
  source_count: number | null;

  // Origin reconciliation (populated by the canonical-dedup view across sources).
  origins: string | null;
  origin_keys: string | null;
  origin_count: number | null;
  study_types: string | null; // e.g. "Clinical" | "Preclinical" | "Clinical,Preclinical"
  study_type_count: number | null;
  canonical_key: string | null; // Used by the diff panel to fetch sibling source rows.
}

export interface BundleRow {
  id: string;
  bundle_name: string;
  domain: string;
  subdomain: string;
  category: string;
  working_group: string;
  cde_group: string | null;
  cde_count: number;
}

export type Classification =
  | 'Core'
  | 'Recommended'
  | 'Supplemental'
  | 'Not Applicable'
  | null;

export const CLASSIFICATION_OPTIONS: Array<Exclude<Classification, null>> = [
  'Core',
  'Recommended',
  'Supplemental',
  'Not Applicable',
];

export const DATA_TYPES = [
  'Value List',
  'Text',
  'Number',
  'Date',
  'Time',
  'Datetime',
  'Geolocation',
  'File/URI/URL',
  'Other',
];

export function classificationPillClass(v: string | null | undefined): string {
  if (!v) return 'pill pill--na';
  switch (v) {
    case 'Core':
      return 'pill pill--core';
    case 'Recommended':
      return 'pill pill--recommended';
    case 'Supplemental':
      return 'pill pill--supplemental';
    default:
      return 'pill pill--na';
  }
}

/** A "meaningful" classification — i.e. something other than null or "Not Applicable". */
export function isActiveTier(v: string | null | undefined): boolean {
  return v === 'Core' || v === 'Recommended' || v === 'Supplemental';
}

export function splitPipe(s: string | null | undefined): string[] {
  if (!s) return [];
  return s.split('|').map((x) => x.trim()).filter(Boolean);
}

export function splitSemi(s: string | null | undefined): string[] {
  if (!s) return [];
  return s.split(';').map((x) => x.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// CRF (Case Report Form)
// ─────────────────────────────────────────────────────────────────────────────

export type CrfItemKind = 'section' | 'cde' | 'bundle';

export interface CrfItem {
  type: CrfItemKind;
  /** For 'cde' and 'bundle': the stable human key (cde_name / bundle_name). */
  ref?: string | null;
  /** For 'section': the visible heading. Optional override on 'cde'/'bundle'. */
  label?: string | null;
  /** Markdown instructions attached to this item (usually only on sections). */
  instructions?: string | null;
}

export interface CrfRecord {
  id: string;
  crf_name: string;
  title: string;
  description: string | null;
  instructions: string | null;
  version: string;
  disease_scope: string | null;
  estimated_duration_minutes: number | null;
  collection_frequency: string | null;
  external_url: string | null;
  study_type: 'Clinical' | 'Preclinical' | null;
  items: CrfItem[];
  /** 'seeded' = read-only from parquet; 'custom' = user-authored, in localStorage. */
  source: 'seeded' | 'custom';
  created_at?: string;
  updated_at?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Review (reviewer-assigned classification, stored locally, eventually synced)
// ─────────────────────────────────────────────────────────────────────────────

export type DiseaseKey =
  | 'pte'
  | 'tbi'
  | 'sci'
  | 'neurotrauma'
  | 'agnostic';

export interface Reviewer {
  id: string;
  name: string;
  /**
   * Diseases this reviewer is qualified to review. Sessions cycle through them
   * one at a time via a "Next disease" button.
   * Older profiles stored a single `primary_disease`; the store migrates them.
   */
  primary_diseases: DiseaseKey[];
  /** Reviewer's preferred study context. null = both clinical & preclinical. */
  primary_study_type: 'Clinical' | 'Preclinical' | null;
  /** @deprecated kept for backwards compat with v1 profiles in localStorage. */
  primary_disease?: DiseaseKey;
  /** @deprecated kept for backwards compat with v1 profiles in localStorage. */
  primary_domain?: string | null;
  created_at: string;
}

export type ReviewTargetType = 'bundle' | 'cde';

export type ReviewClassification =
  | 'Core'
  | 'Recommended'
  | 'Supplemental'
  | 'Not Applicable';

export type ReviewFlag =
  | 'pvs_incomplete'
  | 'pvs_incorrect'
  | 'definition_unclear'
  | 'unit_issue'
  | 'wrong_bundle'
  | 'possible_duplicate'
  | 'data_type_mismatch';

export const REVIEW_FLAGS: Array<{
  key: ReviewFlag;
  label: string;
  description: string;
}> = [
  {
    key: 'pvs_incomplete',
    label: 'PVs incomplete',
    description:
      'Permissible values (the allowed answer options) are missing — e.g., no "Unknown" option, a required category absent.',
  },
  {
    key: 'pvs_incorrect',
    label: 'PVs incorrect',
    description:
      'Permissible values are wrong, mislabeled, ambiguous, or use the wrong code system.',
  },
  {
    key: 'definition_unclear',
    label: 'Definition unclear',
    description:
      'The CDE definition is ambiguous, too narrow, too broad, or contradicts the question text.',
  },
  {
    key: 'unit_issue',
    label: 'Unit issue',
    description:
      'Wrong unit of measure, unit missing, or multiple units needed for different study contexts.',
  },
  {
    key: 'wrong_bundle',
    label: 'Wrong bundle',
    description:
      'This element belongs in a different bundle, should be split off as standalone, or the bundle itself needs revision.',
  },
  {
    key: 'possible_duplicate',
    label: 'Possible duplicate',
    description:
      'This appears to duplicate another CDE or bundle in the set — merge or clarify the distinction.',
  },
  {
    key: 'data_type_mismatch',
    label: 'Data type mismatch',
    description:
      'Wrong data type — e.g., a numeric field currently typed as free text, or an enum field typed as text.',
  },
];

export interface Review {
  id: string;
  reviewer_id: string;
  target_type: ReviewTargetType;
  /** bundle_name for bundles, cde_name for standalone CDEs. */
  target_ref: string;
  disease: DiseaseKey;
  classification: ReviewClassification;
  comment: string | null;
  /** Structured revision flags — which aspects of this element need fixing. */
  flags: ReviewFlag[];
  created_at: string;
  updated_at: string;
  /** Placeholder for eventual backend sync. */
  sync_status: 'local' | 'synced';
}
