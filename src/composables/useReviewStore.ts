import { computed, ref, watch } from 'vue';
import { useDuckDB } from '@/composables/useDuckDB';
import type {
  DiseaseKey,
  Review,
  ReviewClassification,
  ReviewFlag,
  Reviewer,
  ReviewTargetType,
} from '@/types';

const REVIEWER_KEY = 'cde-dashboard:reviewer:v1';
const REVIEWS_KEY = 'cde-dashboard:reviews:v1';

interface ReviewsStorage {
  version: 1;
  reviews: Review[];
}

const reviewer = ref<Reviewer | null>(readReviewer());
const reviews = ref<Review[]>(readReviews());

function readReviewer(): Reviewer | null {
  try {
    const raw = localStorage.getItem(REVIEWER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Reviewer;
    // Migrate v1 profiles to v2:
    //   primary_disease (single) → primary_diseases (array)
    //   primary_study_type defaults to null (= both clinical & preclinical)
    if (!Array.isArray(parsed.primary_diseases)) {
      parsed.primary_diseases = parsed.primary_disease ? [parsed.primary_disease] : [];
    }
    if (parsed.primary_study_type === undefined) parsed.primary_study_type = null;
    return parsed;
  } catch {
    return null;
  }
}

function readReviews(): Review[] {
  try {
    const raw = localStorage.getItem(REVIEWS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ReviewsStorage;
    if (parsed.version !== 1 || !Array.isArray(parsed.reviews)) return [];
    // Backfill `flags` on older records persisted before the field existed.
    return parsed.reviews.map((r) => ({
      ...r,
      flags: Array.isArray((r as Review).flags) ? (r as Review).flags : [],
    }));
  } catch {
    return [];
  }
}

watch(
  reviewer,
  (r) => {
    if (r) localStorage.setItem(REVIEWER_KEY, JSON.stringify(r));
    else localStorage.removeItem(REVIEWER_KEY);
  },
  { deep: true },
);

watch(
  reviews,
  (list) => {
    const payload: ReviewsStorage = { version: 1, reviews: list };
    localStorage.setItem(REVIEWS_KEY, JSON.stringify(payload));
  },
  { deep: true },
);

function diseaseColumn(d: DiseaseKey): string {
  return `disease_${d}`;
}

// ── Reviewer management ─────────────────────────────────────────────────────

function saveReviewer(partial: Omit<Reviewer, 'id' | 'created_at'>): Reviewer {
  const existing = reviewer.value;
  const rec: Reviewer = {
    id: existing?.id ?? crypto.randomUUID(),
    created_at: existing?.created_at ?? new Date().toISOString(),
    ...partial,
  };
  reviewer.value = rec;
  return rec;
}

function clearReviewer() {
  reviewer.value = null;
}

// ── Review CRUD ─────────────────────────────────────────────────────────────

function submitReview(partial: {
  target_type: ReviewTargetType;
  target_ref: string;
  disease: DiseaseKey;
  classification: ReviewClassification;
  comment?: string | null;
  flags?: ReviewFlag[];
}): Review | null {
  if (!reviewer.value) return null;
  const now = new Date().toISOString();
  const flags = partial.flags ?? [];
  // One review per (reviewer, target, disease) — upsert.
  const idx = reviews.value.findIndex(
    (r) =>
      r.reviewer_id === reviewer.value!.id &&
      r.target_type === partial.target_type &&
      r.target_ref === partial.target_ref &&
      r.disease === partial.disease,
  );
  if (idx >= 0) {
    const existing = reviews.value[idx];
    const next: Review = {
      ...existing,
      classification: partial.classification,
      comment: partial.comment ?? null,
      flags,
      updated_at: now,
      sync_status: 'local',
    };
    const list = [...reviews.value];
    list[idx] = next;
    reviews.value = list;
    return next;
  }
  const rec: Review = {
    id: crypto.randomUUID(),
    reviewer_id: reviewer.value.id,
    target_type: partial.target_type,
    target_ref: partial.target_ref,
    disease: partial.disease,
    classification: partial.classification,
    comment: partial.comment ?? null,
    flags,
    created_at: now,
    updated_at: now,
    sync_status: 'local',
  };
  reviews.value = [...reviews.value, rec];
  return rec;
}

function findReview(
  target_type: ReviewTargetType,
  target_ref: string,
  disease: DiseaseKey,
): Review | undefined {
  if (!reviewer.value) return undefined;
  return reviews.value.find(
    (r) =>
      r.reviewer_id === reviewer.value!.id &&
      r.target_type === target_type &&
      r.target_ref === target_ref &&
      r.disease === disease,
  );
}

function deleteReview(reviewId: string): boolean {
  const before = reviews.value.length;
  reviews.value = reviews.value.filter((r) => r.id !== reviewId);
  return reviews.value.length < before;
}

// ── Session target selection ─────────────────────────────────────────────────

export interface ReviewTarget {
  type: ReviewTargetType;
  /** Stable human-readable key — bundle_name or cde_name. */
  ref: string;
  /** Visible title for the card. */
  title: string;
  /** cde_domain for both types (for bundles, derived from any member). */
  domain: string | null;
}

export interface SessionFilter {
  disease: DiseaseKey;
  /** null = both clinical and preclinical. */
  studyType: 'Clinical' | 'Preclinical' | null;
  limit: number;
  /** When true, include items this reviewer has already reviewed for the
   *  chosen disease so they can amend their classification. */
  includeReviewed?: boolean;
}

/** SQL fragment to filter cde_full by study_type. The column is comma-joined
 *  on the canonical view (e.g. "Clinical,Preclinical"); we pad and substring-
 *  match so single-typed and dual-typed CDEs both pass when their type matches. */
function studyTypeClause(studyType: SessionFilter['studyType']): string {
  if (!studyType) return '';
  return `AND ',' || COALESCE(study_types, '') || ',' LIKE '%,${studyType},%'`;
}

/** Pick N review targets. Excludes anything the current reviewer has already
 *  reviewed for the chosen disease. Caps at 5 per domain for cross-domain
 *  spread. Random tie-break keeps repeat sessions fresh. */
async function selectSessionTargets(
  filter: SessionFilter,
): Promise<ReviewTarget[]> {
  if (!reviewer.value) return [];
  const { query } = useDuckDB();
  const diseaseCol = diseaseColumn(filter.disease);
  const stClause = studyTypeClause(filter.studyType);

  // Bundle candidates: a bundle qualifies if any member CDE matches the disease
  // + (optionally) the study type. Deduplicate by bundle_name.
  const bundleRows = await query<{
    bundle_name: string;
    cde_domain: string | null;
  }>(
    `SELECT DISTINCT bundle_name, any_value(cde_domain) AS cde_domain
     FROM cde_full
     WHERE ${diseaseCol} = 'Y'
       AND bundle_id IS NOT NULL
       ${stClause}
     GROUP BY bundle_name`,
  );

  // Standalone CDE candidates.
  const cdeRows = await query<{
    cde_name: string;
    cde_domain: string | null;
  }>(
    `SELECT cde_name, cde_domain
     FROM cde_full
     WHERE ${diseaseCol} = 'Y'
       AND bundle_id IS NULL
       ${stClause}`,
  );

  const reviewed = new Set(
    reviews.value
      .filter(
        (r) =>
          r.reviewer_id === reviewer.value!.id && r.disease === filter.disease,
      )
      .map((r) => `${r.target_type}:${r.target_ref}`),
  );

  const allCandidates: ReviewTarget[] = [
    ...bundleRows.map<ReviewTarget>((r) => ({
      type: 'bundle',
      ref: r.bundle_name,
      title: r.bundle_name,
      domain: r.cde_domain,
    })),
    ...cdeRows.map<ReviewTarget>((r) => ({
      type: 'cde',
      ref: r.cde_name,
      title: r.cde_name,
      domain: r.cde_domain,
    })),
  ];
  const candidates = filter.includeReviewed
    ? allCandidates
    : allCandidates.filter((t) => !reviewed.has(`${t.type}:${t.ref}`));

  // Shuffle first, then apply per-domain cap so the session spans multiple
  // domains rather than dumping 20 from one domain.
  shuffle(candidates);
  const perDomainCap = 5;
  const byDomain = new Map<string, number>();
  const kept: ReviewTarget[] = [];
  for (const t of candidates) {
    const key = t.domain ?? '__none__';
    const n = byDomain.get(key) ?? 0;
    if (n >= perDomainCap) continue;
    byDomain.set(key, n + 1);
    kept.push(t);
    if (kept.length >= filter.limit) break;
  }
  return kept;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Coverage stats ──────────────────────────────────────────────────────────

interface Coverage {
  reviewed: number;
  total: number;
}

async function coverageFor(
  disease: DiseaseKey,
  studyType: 'Clinical' | 'Preclinical' | null,
): Promise<Coverage> {
  if (!reviewer.value) return { reviewed: 0, total: 0 };
  const { query } = useDuckDB();
  const diseaseCol = diseaseColumn(disease);
  const stClause = studyTypeClause(studyType);
  const params: unknown[] = [];

  const bundleTotal = await query<{ n: number }>(
    `SELECT COUNT(DISTINCT bundle_name) AS n
     FROM cde_full
     WHERE ${diseaseCol} = 'Y' AND bundle_id IS NOT NULL ${stClause}`,
    params,
  );
  const cdeTotal = await query<{ n: number }>(
    `SELECT COUNT(*) AS n
     FROM cde_full
     WHERE ${diseaseCol} = 'Y' AND bundle_id IS NULL ${stClause}`,
    params,
  );
  const total = Number(bundleTotal[0]?.n ?? 0) + Number(cdeTotal[0]?.n ?? 0);

  const reviewed = reviews.value.filter(
    (r) => r.reviewer_id === reviewer.value!.id && r.disease === disease,
  ).length;

  return { reviewed, total };
}

export function useReviewStore() {
  const myReviews = computed(() =>
    reviewer.value
      ? reviews.value.filter((r) => r.reviewer_id === reviewer.value!.id)
      : [],
  );

  return {
    reviewer: computed(() => reviewer.value),
    saveReviewer,
    clearReviewer,

    reviews: computed(() => reviews.value),
    myReviews,
    submitReview,
    findReview,
    deleteReview,

    selectSessionTargets,
    coverageFor,
  };
}
