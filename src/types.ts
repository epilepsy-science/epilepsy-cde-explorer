/** A row from `cde_full` — one row per (canonical CDE × classification ×
 *  bundle). A CDE on multiple CRFs in different bundles surfaces as
 *  multiple `CdeRow`s. Used by per-context views (Tree, Treemap, Bundle
 *  detail, CRF detail) and review-session queries that need the
 *  classification axis. For "one row per CDE" use `CdeCanonicalRow`. */
export interface CdeRow {
  cde_id: string;
  /** Classification id for THIS row's context; null when the CDE has no
   *  classification at all. Distinguishes contextual rows for the same CDE. */
  cls_id: string | null;
  cde_name: string;
  /** Pipe-joined alternate designations (NLM `designations[1..]`). Null when
   *  the source doesn't ship aliases (NINDS, demo, PTE-clinical). */
  aliases: string | null;
  cde_data_type: string;
  cde_definition: string;
  cde_source: string | null;
  cde_type: string | null;
  /** Owning organization that stewards the CDE (NLM `stewardOrg.name`).
   *  NLM federates many stewards (caDSR, NINDS, NHLBI, CTEP, …); this keeps
   *  the distinction even when our top-level cde_source collapses them. */
  steward_org: string | null;
  /** NLM lifecycle marker — Standard / Qualified / Recorded / Candidate /
   *  Retired. Null when the source doesn't expose one. */
  registration_status: string | null;
  keywords: string | null;
  preferred_question_text: string | null;

  pv_labels: string | null;
  pv_codes: string | null;
  pv_definitions: string | null;
  pv_code_systems: string | null;
  pv_concept_identifiers: string | null;
  pv_terminology_sources: string | null;
  unit_of_measure: string | null;
  refs: string | null;
  nlm_identifier: string | null;
  dec_identifier: string | null;
  dec_terminology_source: string | null;
  other_identifiers: string | null;

  // CDE-intrinsic fields (moved from cde_classification — they don't vary
  // per disease so they belong with the CDE, not its disease tier).
  min_value: number | null;
  max_value: number | null;
  cde_origin: string | null;
  population: string | null;
  cdisc_domain: string | null;
  cdisc_variable_name: string | null;
  cdisc_variable_label: string | null;

  variable_name: string | null;
  version_name: string | null;
  version_date: string | null;
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

  // CDE-level taxonomy from cde_full (COALESCE(cl.<col>, b.<col>)). Surfaces
  // on every row regardless of whether the CDE belongs to a bundle. There
  // is no `cde_category` — `category` on cde_classification is per-context
  // (almost always the CRF name) and bundles have their own `bundle_category`.
  cde_domain: string | null;
  cde_subdomain: string | null;
  /** Canonical hierarchical path, ` / `-delimited. e.g. "Demographics / Age".
   *  Derived from domain/subdomain. */
  cde_path: string | null;

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

/** A row from `cde_canonical` — exactly one per canonical CDE. Multi-context
 *  fields (bundle attribution, taxonomy paths) are pipe-joined; per-disease
 *  flags are max-OR across contexts; per-disease tiers are the highest tier
 *  observed across contexts. Used by per-CDE listings (the /cdes table,
 *  Home tiles, Overview counts) and detail-drawer lookups. */
export interface CdeCanonicalRow {
  cde_id: string;
  cde_name: string;
  aliases: string | null;
  cde_data_type: string;
  cde_definition: string;
  cde_source: string | null;
  cde_type: string | null;
  steward_org: string | null;
  registration_status: string | null;
  keywords: string | null;
  preferred_question_text: string | null;

  pv_labels: string | null;
  pv_codes: string | null;
  pv_definitions: string | null;
  pv_code_systems: string | null;
  pv_concept_identifiers: string | null;
  pv_terminology_sources: string | null;
  unit_of_measure: string | null;
  refs: string | null;
  nlm_identifier: string | null;
  dec_identifier: string | null;
  dec_terminology_source: string | null;
  other_identifiers: string | null;

  min_value: number | null;
  max_value: number | null;
  cde_origin: string | null;
  population: string | null;
  cdisc_domain: string | null;
  cdisc_variable_name: string | null;
  cdisc_variable_label: string | null;

  // Disease scope: max-OR across all classification contexts. 'Y' if any
  // context has the disease flagged.
  disease_agnostic: 'Y' | 'N' | null;
  disease_neurotrauma: 'Y' | 'N' | null;
  disease_tbi: 'Y' | 'N' | null;
  disease_pte: 'Y' | 'N' | null;
  disease_sci: 'Y' | 'N' | null;
  disease_epilepsy: 'Y' | 'N' | null;

  // Per-disease tier: highest tier observed across contexts.
  classification_agnostic: string | null;
  classification_neurotrauma: string | null;
  classification_tbi: string | null;
  classification_pte: string | null;
  classification_sci: string | null;
  classification_epilepsy: string | null;

  // Pipe-joined distinct values across contexts.
  cde_domain: string | null;
  cde_subdomain: string | null;
  cde_paths: string | null;

  bundle_ids: string | null;
  bundle_names: string | null;
  bundle_domains: string | null;
  bundle_subdomains: string | null;
  bundle_categories: string | null;
  bundle_working_groups: string | null;
  bundle_count: number;
  context_count: number;

  source_labels: string | null;
  source_count: number | null;

  /** Pipe-joined distinct variable_names across classification contexts.
   *  Single-context CDEs render as one name; multi-context CDEs surface
   *  every variant. Null when no classification has set a variable_name. */
  variable_name: string | null;

  origins: string | null;
  origin_keys: string | null;
  origin_count: number | null;
  study_types: string | null;
  study_type_count: number | null;
  canonical_key: string | null;
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

// ── Concept layer ──────────────────────────────────────────────────────────
// Each Concept is the underlying semantic anchor for one or more CDEs.
// `(source, identifier)` is the natural key as it lands from the source —
// e.g., (LOINC, "30525-0"), (caDSR, "1285"), (SNOMED CT, "271649006").
//
// `cui` is the UMLS Concept Unique Identifier and is the canonical bridge
// across vocabularies — when populated, multiple (source, identifier)
// mappings that share a CUI represent the same semantic concept. Filled
// by the Phase 4 UTS cache; until then it's null and the UI groups by
// (source, identifier) directly.
//
// `preferred_label`, `definition`, and `alt_labels` are also Phase 4 — the
// UI falls back to `<source>:<identifier>` when label is null.
export interface ConceptRow {
  id: string;
  source: string;
  identifier: string;
  cui: string | null;
  preferred_label: string | null;
  definition: string | null;
  /** Pipe-separated alternative labels from the terminology service. */
  alt_labels: string | null;
}

/**
 * How a CDE relates to the concept it points at:
 *   - primary: the CDE *is* the concept's measurement (e.g., age-value)
 *   - unit: metadata on a primary CDE (e.g., age-unit)
 *   - qualifier: refines a primary CDE (e.g., age-method)
 *   - other: anything we haven't classified yet
 *
 * Default at extraction is 'primary'; later phases let admins refine.
 */
export type ConceptRole = 'primary' | 'unit' | 'qualifier' | 'other';

export interface CdeRepresentsConcept {
  cde_id: string;
  concept_id: string;
  role: ConceptRole;
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

/** NLM registration tier for a published form. Defaults to "Qualified" for
 *  seeded CRFs from sources that don't expose a status (NINDS, demo, PTE).
 *  We deliberately don't default to "Standard" — that label is reserved for
 *  NLM's explicit highest-tier marker; squatting on it would misrepresent
 *  forms whose actual tier we don't know. */
export const CRF_STATUS_DEFAULT = 'Qualified';
export type CrfStatusKind =
  | 'custom'
  | 'standard'
  | 'qualified'
  | 'recorded'
  | 'candidate'
  | 'retired';

export interface CrfBadge {
  /** Displayed label, e.g. "Standard", "Qualified", "Custom". */
  label: string;
  /** Lowercase status kind — components map this to their own scoped CSS. */
  kind: CrfStatusKind;
}

/** Plain-English explanation of each badge state. Surfaced as tooltip text
 *  on the detail view and as a popover legend next to the source filter. */
export const CRF_BADGE_DESCRIPTIONS: Record<CrfStatusKind | 'external', string> = {
  standard: 'Reference standard — fully accepted at the highest tier; no further review needed.',
  qualified: 'Reviewed and accepted by the stewardship body; recommended for use.',
  recorded: 'Accepted at a basic level; not yet formally vetted at the Qualified tier.',
  candidate: 'Newly submitted; under review for promotion to a higher tier.',
  retired: 'Deprecated — no longer recommended for new use.',
  custom: 'User-authored CRF stored in your browser; not from a source registry.',
  external:
    'Copyright-restricted external instrument. The source registry can\'t redistribute the items — only a link to the licensed publisher.',
};

/** Unified badge resolver used on the CRFs list, the CRF detail header, and
 *  the home-page featured panel so they stay in sync. */
export function crfBadge(c: { source: 'seeded' | 'custom'; registration_status: string | null }): CrfBadge {
  if (c.source === 'custom') return { label: 'Custom', kind: 'custom' };
  const label = c.registration_status?.trim() || CRF_STATUS_DEFAULT;
  const kind = label.toLowerCase();
  const known: CrfStatusKind[] = ['standard', 'qualified', 'recorded', 'candidate', 'retired'];
  return {
    label,
    kind: (known as string[]).includes(kind) ? (kind as CrfStatusKind) : 'standard',
  };
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
  /** NLM lifecycle marker — Standard / Qualified / Recorded / Candidate /
   *  Retired. Null when the source doesn't expose one (NINDS, demo, PTE,
   *  custom); UI defaults seeded CRFs without status to "Qualified" — see
   *  CRF_STATUS_DEFAULT for why "Standard" isn't used as the fallback. */
  registration_status: string | null;
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
  | 'epilepsy'
  | 'agnostic';

export interface Reviewer {
  /** Verified email — canonical identity (was `id` in the localStorage era). */
  email: string;
  name: string;
  /** Optional LinkedIn (or other) profile URL. null when not provided. */
  linkedin_url: string | null;
  /**
   * Diseases this reviewer is qualified to review. Sessions cycle through them
   * one at a time via a "Next disease" button.
   */
  primary_diseases: DiseaseKey[];
  /** Reviewer's preferred study context. null = both clinical & preclinical. */
  primary_study_type: 'Clinical' | 'Preclinical' | null;
  /** Server-managed timestamps. */
  created_at?: string;
  updated_at?: string;
  /** "rev" or "admin" — populated from /v1/me + the verify-code response. */
  role?: 'rev' | 'admin';
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
  target_type: ReviewTargetType;
  /** bundle_name for bundles, cde_name for standalone CDEs. */
  target_ref: string;
  disease: DiseaseKey;
  classification: ReviewClassification;
  comment: string | null;
  /** Structured revision flags — which aspects of this element need fixing. */
  flags: ReviewFlag[];
  /** Bumps on every amend. Server-managed. */
  version: number;
  created_at?: string;
  updated_at: string;
}
