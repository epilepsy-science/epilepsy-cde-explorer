// Reviewer profile + review state, backed by the API at api.cde.epilepsy.science.
//
// Identity comes from the JWT in localStorage (managed by src/api/client.ts).
// Profile + reviews are fetched from the server on `ensureLoaded()` and cached
// in module-level refs so consumers (Vue components) get reactive updates.
// Every write goes through the API; the local cache is updated optimistically
// from the response — no localStorage writes anywhere.
//
// Session-target selection (`selectSessionTargets`) and target-count queries
// (`coverageFor`) stay client-side because they read from the parquet via
// DuckDB-WASM — no need to round-trip those through the API.

import { computed, ref, watch } from 'vue';
import { api, apiToken, setToken, unwrap } from '@/api/client';
import { fetchDashboardConfig } from '@/api/dashboardConfig';
import { trackEvent } from '@/api/analytics';
import { useDuckDB } from '@/composables/useDuckDB';
import type {
  DiseaseKey,
  Review,
  ReviewClassification,
  ReviewFlag,
  Reviewer,
  ReviewTargetType,
} from '@/types';

// One-shot cleanup of the v1 localStorage keys. We don't migrate the data
// (no production reviews exist yet — only test data on dev machines). Just
// drop the keys silently so they don't sit around forever.
clearLegacyLocalStorage();
function clearLegacyLocalStorage() {
  try {
    localStorage.removeItem('cde-dashboard:reviewer:v1');
    localStorage.removeItem('cde-dashboard:reviews:v1');
  } catch {}
}

// ── Module-level reactive state ─────────────────────────────────────────────

const reviewer = ref<Reviewer | null>(null);
const reviews = ref<Review[]>([]);
const loaded = ref(false);
const loadingPromise = ref<Promise<void> | null>(null);

/** True iff there's a token and we've fetched the reviewer's state. */
const isAuthenticated = computed(() => apiToken.value !== null && reviewer.value !== null);

// When the token changes (set via verify-code or cleared on 401), re-sync state.
watch(apiToken, (t) => {
  if (!t) {
    reviewer.value = null;
    reviews.value = [];
    loaded.value = false;
    loadingPromise.value = null;
    return;
  }
  // Fresh token — re-fetch on next ensureLoaded() call.
  loaded.value = false;
  loadingPromise.value = null;
});

// ── Initial fetch ───────────────────────────────────────────────────────────

async function ensureLoaded(): Promise<void> {
  if (!apiToken.value) return;
  if (loaded.value) return;
  if (loadingPromise.value) {
    await loadingPromise.value;
    return;
  }
  loadingPromise.value = (async () => {
    try {
      const me = await unwrap(api.GET('/v1/me'));
      reviewer.value = profileToReviewer(me);
      const list = await unwrap(api.GET('/v1/reviews/me'));
      reviews.value = (list.reviews ?? []).map(serverReviewToLocal);
    } catch (e) {
      // 404 on /v1/me = profile not set yet. Caller should show profile setup.
      const status = (e as { status?: number }).status;
      if (status === 404) {
        reviewer.value = null;
        try {
          const list = await unwrap(api.GET('/v1/reviews/me'));
          reviews.value = (list.reviews ?? []).map(serverReviewToLocal);
        } catch {}
      } else if (status === 401) {
        // Token expired/revoked — client.ts already cleared apiToken.
        reviewer.value = null;
        reviews.value = [];
      } else {
        throw e;
      }
    } finally {
      loaded.value = true;
    }
  })();
  await loadingPromise.value;
}

// ── Reviewer management ─────────────────────────────────────────────────────

async function saveReviewer(partial: {
  name: string;
  linkedin_url?: string | null;
  primary_diseases: DiseaseKey[];
  primary_study_type: 'Clinical' | 'Preclinical' | null;
}): Promise<Reviewer> {
  const me = await unwrap(
    api.PUT('/v1/me', {
      body: {
        name: partial.name,
        linkedin_url: partial.linkedin_url ?? '',
        primary_diseases: partial.primary_diseases,
        primary_study_type: partial.primary_study_type ?? '',
      },
    }),
  );
  const next = profileToReviewer({ ...me, role: reviewer.value?.role });
  reviewer.value = next;
  return next;
}

/** Drop the JWT and clear all cached state. */
function logout(): void {
  setToken(null);
}

/** GDPR delete — removes profile, reviews, history server-side, then logs out. */
async function deleteAccount(): Promise<void> {
  await unwrap(api.DELETE('/v1/me'));
  logout();
}

// ── Review CRUD ─────────────────────────────────────────────────────────────

async function submitReview(partial: {
  target_type: ReviewTargetType;
  target_ref: string;
  disease: DiseaseKey;
  classification: ReviewClassification;
  comment?: string | null;
  flags?: ReviewFlag[];
}): Promise<Review | null> {
  if (!apiToken.value) return null;
  const saved = await unwrap(
    api.POST('/v1/reviews', {
      body: {
        target_type: partial.target_type,
        target_ref: partial.target_ref,
        disease: partial.disease,
        classification: partial.classification,
        comment: partial.comment ?? '',
        flags: (partial.flags ?? []) as string[],
      },
    }),
  );
  const local = serverReviewToLocal(saved);
  // Upsert in cache — keyed by (target_type, target_ref, disease).
  const i = reviews.value.findIndex(
    (r) =>
      r.target_type === local.target_type &&
      r.target_ref === local.target_ref &&
      r.disease === local.disease,
  );
  if (i >= 0) {
    const next = [...reviews.value];
    next[i] = local;
    reviews.value = next;
  } else {
    reviews.value = [...reviews.value, local];
  }

  // Analytics: emit a non-PII shape — target type, disease, tier, whether
  // this was an amend or a fresh review. Reviewer email, target_ref, and
  // comment text are deliberately excluded.
  trackEvent('review_submitted', {
    target_type: local.target_type,
    disease: local.disease,
    classification: local.classification,
    is_amend: i >= 0,
  });

  return local;
}

function findReview(
  target_type: ReviewTargetType,
  target_ref: string,
  disease: DiseaseKey,
): Review | undefined {
  return reviews.value.find(
    (r) =>
      r.target_type === target_type &&
      r.target_ref === target_ref &&
      r.disease === disease,
  );
}

// ── Session target selection (client-side over the parquet) ────────────────

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
  /** source_key — the dataset under review (e.g. 'pte-clinical'). */
  source: string;
  /** Disease the session is scoped to — same CDE can be Core for one and
   *  Supplemental for another, so a reviewer always works one at a time. */
  disease: DiseaseKey;
  limit: number;
  /** When true, include items this reviewer has already reviewed so they
   *  can amend their classification. */
  includeReviewed?: boolean;
}

/** One reviewable unit: a (source, disease) pair from the review_scope.
 *  A source whose CDEs span multiple diseases produces one entry per
 *  disease so a session is always scoped to a single classification axis. */
export interface ReviewableSource {
  /** Composite key for v-for / equality checks — `${source_key}::${disease}`. */
  id: string;
  /** Source key (source_labels.source_key, e.g. 'pte-clinical'). */
  key: string;
  /** Pretty source label for display ("PTE Clinical CDEs"). */
  label: string;
  /** Study type — Clinical or Preclinical, or null when the source mixes. */
  study_type: 'Clinical' | 'Preclinical' | null;
  /** Disease this entry's session reviews against. */
  disease: DiseaseKey;
  /** Total CDEs + Bundles in scope from this source flagged for `disease`. */
  target_count: number;
}

function originKeysClause(sourceKey: string): string {
  // origin_keys is a comma-joined list. Pad both ends with commas so we
  // match whole keys, not prefixes (e.g. 'pte' inside 'pte-clinical').
  const safe = sourceKey.replace(/'/g, "''");
  return `',' || COALESCE(origin_keys, '') || ',' LIKE '%,${safe},%'`;
}

async function selectSessionTargets(
  filter: SessionFilter,
): Promise<ReviewTarget[]> {
  if (!reviewer.value) return [];
  const { query } = useDuckDB();
  const sourceClause = originKeysClause(filter.source);
  const diseaseClause = `disease_${filter.disease} = 'Y'`;

  // Bundled CDEs are reviewed as a bundle (bundles travel together by
  // definition — same rule the CDE drawer enforces for "Add to CRF").
  const bundleRows = await query<{ bundle_name: string; cde_domain: string | null }>(
    `SELECT bundle_name, any_value(cde_domain) AS cde_domain
     FROM cde_full
     WHERE ${sourceClause}
       AND ${diseaseClause}
       AND bundle_name IS NOT NULL
     GROUP BY bundle_name`,
  );
  const cdeRows = await query<{ cde_name: string; cde_domain: string | null }>(
    `SELECT cde_name, cde_domain
     FROM cde_full
     WHERE ${sourceClause}
       AND ${diseaseClause}
       AND bundle_name IS NULL`,
  );

  // Already-reviewed for THIS disease — a CDE that the reviewer classified
  // for PTE should still surface when they're reviewing for TBI, since the
  // tier might differ. Restrict the dedup to the active disease.
  const reviewed = new Set(
    reviews.value
      .filter((r) => r.disease === filter.disease)
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

  // Operator-controlled review scope from /v1/dashboard-config. When
  // all_open is false, restrict the candidate pool to the named CDEs +
  // Bundles. Permissive when fetch failed or scope is missing.
  const config = await fetchDashboardConfig();
  const scope = config.review_scope;
  const scopedCandidates = scope.all_open
    ? allCandidates
    : allCandidates.filter((t) =>
        t.type === 'cde'
          ? scope.cdes.includes(t.ref)
          : scope.bundles.includes(t.ref),
      );

  const candidates = filter.includeReviewed
    ? scopedCandidates
    : scopedCandidates.filter((t) => !reviewed.has(`${t.type}:${t.ref}`));

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

/** Enumerate (source × disease) review buckets currently in scope. A
 *  source whose CDEs span multiple diseases produces one entry per
 *  disease so a session is always scoped to a single classification axis. */
async function reviewableSources(): Promise<ReviewableSource[]> {
  const { query, status } = useDuckDB();
  if (status.value !== 'ready') return [];
  const config = await fetchDashboardConfig();
  const scope = config.review_scope;

  // Union of in-scope CDE/bundle rows with their owning source(s) and ALL
  // disease flags (not just the dominant one). all_open => no filter.
  const cdeNames = scope.cdes;
  const bundleNames = scope.bundles;
  let where = '';
  let params: unknown[] = [];
  if (!scope.all_open) {
    const cdePh = cdeNames.map(() => '?').join(',');
    const bunPh = bundleNames.map(() => '?').join(',');
    const clauses: string[] = [];
    if (cdeNames.length) clauses.push(`cde_name IN (${cdePh})`);
    if (bundleNames.length) clauses.push(`bundle_name IN (${bunPh})`);
    if (!clauses.length) return [];
    where = `WHERE ${clauses.join(' OR ')}`;
    params = [...cdeNames, ...bundleNames];
  }

  const rows = await query<{
    cde_name: string;
    bundle_name: string | null;
    origin_keys: string | null;
    disease_pte: string | null;
    disease_epilepsy: string | null;
    disease_tbi: string | null;
    disease_sci: string | null;
    disease_neurotrauma: string | null;
    disease_agnostic: string | null;
  }>(
    `SELECT cde_name, bundle_name, origin_keys,
       disease_pte, disease_epilepsy, disease_tbi,
       disease_sci, disease_neurotrauma, disease_agnostic
     FROM cde_full
     ${where}`,
    params,
  );

  // Aggregate by (source, disease): a CDE flagged for both PTE and TBI in
  // a source counts toward both buckets. Bundles dedup via bundle_name.
  const buckets = new Map<string, { source: string; disease: DiseaseKey; targets: Set<string> }>();
  const diseaseFlags: Array<{ key: DiseaseKey; col: keyof typeof rows[number] }> = [
    { key: 'pte', col: 'disease_pte' },
    { key: 'epilepsy', col: 'disease_epilepsy' },
    { key: 'tbi', col: 'disease_tbi' },
    { key: 'sci', col: 'disease_sci' },
    { key: 'neurotrauma', col: 'disease_neurotrauma' },
    { key: 'agnostic', col: 'disease_agnostic' },
  ];
  for (const r of rows) {
    const targetKey = r.bundle_name
      ? `bundle:${r.bundle_name}`
      : `cde:${r.cde_name}`;
    const sourceKeys = (r.origin_keys ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const sourceKey of sourceKeys) {
      for (const { key: disease, col } of diseaseFlags) {
        if (r[col] !== 'Y') continue;
        const id = `${sourceKey}::${disease}`;
        let b = buckets.get(id);
        if (!b) {
          b = { source: sourceKey, disease, targets: new Set() };
          buckets.set(id, b);
        }
        b.targets.add(targetKey);
      }
    }
  }

  const labels = await query<{
    source_key: string;
    label: string;
    study_type: string | null;
  }>(`SELECT source_key, label, study_type FROM source_labels`);
  const labelMap = new Map(labels.map((l) => [l.source_key, l]));

  const out: ReviewableSource[] = [];
  for (const [id, b] of buckets) {
    const meta = labelMap.get(b.source);
    const studyType =
      meta?.study_type === 'Clinical' || meta?.study_type === 'Preclinical'
        ? meta.study_type
        : null;
    out.push({
      id,
      key: b.source,
      label: meta?.label ?? b.source,
      study_type: studyType,
      disease: b.disease,
      target_count: b.targets.size,
    });
  }
  // Stable order: source label, then disease key.
  out.sort((a, b) =>
    a.label.localeCompare(b.label) || a.disease.localeCompare(b.disease),
  );
  return out;
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

async function coverageFor(source: string, disease: DiseaseKey): Promise<Coverage> {
  if (!reviewer.value) return { reviewed: 0, total: 0 };
  const { query } = useDuckDB();
  const sourceClause = originKeysClause(source);
  const diseaseClause = `disease_${disease} = 'Y'`;

  const [cdeRows, bundleRows] = await Promise.all([
    query<{ cde_name: string }>(
      `SELECT cde_name FROM cde_full
       WHERE ${sourceClause} AND ${diseaseClause} AND bundle_name IS NULL`,
    ),
    query<{ bundle_name: string }>(
      `SELECT DISTINCT bundle_name FROM cde_full
       WHERE ${sourceClause} AND ${diseaseClause} AND bundle_name IS NOT NULL`,
    ),
  ]);

  const config = await fetchDashboardConfig();
  const scope = config.review_scope;
  let candidateCdes = cdeRows.map((r) => r.cde_name);
  let candidateBundles = bundleRows.map((r) => r.bundle_name);
  if (!scope.all_open) {
    const cdeSet = new Set(scope.cdes);
    const bunSet = new Set(scope.bundles);
    candidateCdes = candidateCdes.filter((n) => cdeSet.has(n));
    candidateBundles = candidateBundles.filter((n) => bunSet.has(n));
  }
  const total = candidateCdes.length + candidateBundles.length;

  // Reviewed for THIS disease only — same CDE reviewed for a different
  // disease still counts as "to do" here.
  const reviewedRefs = new Set(
    reviews.value
      .filter((r) => r.disease === disease)
      .map((r) => `${r.target_type}:${r.target_ref}`),
  );
  let reviewed = 0;
  for (const c of candidateCdes) if (reviewedRefs.has(`cde:${c}`)) reviewed++;
  for (const b of candidateBundles) if (reviewedRefs.has(`bundle:${b}`)) reviewed++;

  return { reviewed, total };
}

// ── API ↔ local model adapters ──────────────────────────────────────────────

interface ServerProfile {
  email: string;
  name: string;
  linkedin_url?: string | null;
  primary_diseases?: DiseaseKey[] | string[];
  // The OpenAPI schema marks this nullable + with an "" enum value (= both),
  // so the generated TS type widens to `'Clinical' | 'Preclinical' | '' | null
  // | undefined`. Accept all of them; narrow in the converter.
  primary_study_type?: 'Clinical' | 'Preclinical' | '' | null;
  created_at?: string;
  updated_at?: string;
  role?: 'rev' | 'admin';
}
interface ServerReview {
  target_type: 'cde' | 'bundle';
  target_ref: string;
  disease: DiseaseKey | string;
  classification: ReviewClassification | string;
  comment?: string;
  flags?: string[];
  version?: number;
  created_at?: string;
  updated_at?: string;
}

function profileToReviewer(p: ServerProfile): Reviewer {
  return {
    email: p.email,
    name: p.name,
    linkedin_url: p.linkedin_url ?? null,
    primary_diseases: (p.primary_diseases ?? []) as DiseaseKey[],
    primary_study_type:
      p.primary_study_type === 'Clinical' || p.primary_study_type === 'Preclinical'
        ? p.primary_study_type
        : null,
    created_at: p.created_at,
    updated_at: p.updated_at,
    role: p.role,
  };
}

function serverReviewToLocal(r: ServerReview): Review {
  return {
    target_type: r.target_type,
    target_ref: r.target_ref,
    disease: r.disease as DiseaseKey,
    classification: r.classification as ReviewClassification,
    comment: r.comment ?? null,
    flags: (r.flags ?? []) as ReviewFlag[],
    version: r.version ?? 1,
    created_at: r.created_at,
    updated_at: r.updated_at ?? new Date().toISOString(),
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

export function useReviewStore() {
  return {
    reviewer: computed(() => reviewer.value),
    isAuthenticated,
    loaded: computed(() => loaded.value),

    ensureLoaded,
    saveReviewer,
    logout,
    deleteAccount,

    reviews: computed(() => reviews.value),
    myReviews: computed(() => reviews.value),
    submitReview,
    findReview,

    selectSessionTargets,
    coverageFor,
    reviewableSources,
  };
}
