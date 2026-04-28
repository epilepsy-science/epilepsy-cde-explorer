<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDuckDB } from '@/composables/useDuckDB';
import { useStudyType } from '@/composables/useStudyType';
import { DISEASE_OPTIONS, useDiseaseLens } from '@/composables/useDiseaseLens';
import CdeDetailDrawer from '@/components/CdeDetailDrawer.vue';
import ClassificationPill from '@/components/ClassificationPill.vue';
import DiseaseScopeCell from '@/components/DiseaseScopeCell.vue';
import {
  CLASSIFICATION_OPTIONS,
  isActiveTier,
  type CdeRow,
} from '@/types';

const route = useRoute();
const router = useRouter();
const { status, query } = useDuckDB();
const { filter: studyTypeFilter, clause: studyTypeClause } = useStudyType();
const { classificationColumn } = useDiseaseLens();

// Every classification_* column on cde_full, derived from DISEASE_OPTIONS so
// adding a disease doesn't require touching this file.
const ALL_CLASSIFICATION_COLS = DISEASE_OPTIONS
  .map((o) => classificationColumn(o.key))
  .filter((c): c is string => c !== null);

// Vue Router types route.query values as `LocationQueryValue | LocationQueryValue[]`
// where `LocationQueryValue = string | null`. Accept both shapes and silently
// drop any null entries.
type RawQueryValue = string | null | (string | null)[] | undefined;
function csvParam(v: RawQueryValue): string[] {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .filter((x): x is string => typeof x === 'string')
    .flatMap((x) => x.split(',').map((s) => s.trim()).filter(Boolean));
}

// Filters — driven by URL so drill-through links from /explore land here
// pre-filtered, and so navigating to /cdes again with new params (e.g. clicking
// another heatmap cell) replaces the active filter set instead of layering on
// top of stale state. The watcher below resyncs whenever route.query changes.
const search = ref<string>('');
const disease = ref<string[]>([]);
const classTier = ref<string[]>([]);
const bundleFilter = ref<string | null>(null);
const cdeIdFilter = ref<string | null>(null);
const originFilter = ref<string[]>([]);
const domainFilter = ref<string | null>(null);
const subdomainFilter = ref<string | null>(null);
const categoryFilter = ref<string | null>(null);

function strParam(v: RawQueryValue): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function syncFiltersFromQuery() {
  search.value = strParam(route.query.q) ?? '';
  disease.value = csvParam(route.query.disease);
  classTier.value = csvParam(route.query.tier);
  bundleFilter.value = strParam(route.query.bundle);
  cdeIdFilter.value = strParam(route.query.cde);
  originFilter.value = csvParam(route.query.origin);
  domainFilter.value = strParam(route.query.domain);
  subdomainFilter.value = strParam(route.query.subdomain);
  categoryFilter.value = strParam(route.query.category);
}
syncFiltersFromQuery();
const rows = ref<CdeRow[]>([]);
const total = ref(0);
const loading = ref(false);
const page = ref(1);
const pageSize = ref(20);

const selectedCde = ref<CdeRow | null>(null);
const drawerOpen = ref(false);
const viewMode = ref<'grouped' | 'flat' | 'concept'>('grouped');
// True iff the active dataset has any bundles at all. When false, the grouped
// view would collapse every CDE into a single "Unbundled" parent, which is
// bad UX — so we hide the toggle and force flat.
const hasAnyBundles = ref(true);

// A tree row — either a bundle header (parent) or a CDE (leaf).
interface BundleHeader {
  kind: 'bundle';
  id: string;
  bundle_id: string | null;
  bundle_name: string;
  bundle_category: string | null;
  bundle_domain: string | null;
  bundle_working_group: string | null;
  cde_count: number;
  tier_summary: Record<string, number>;
  children: Array<CdeRow & { kind: 'cde'; id: string }>;
  hasChildren: boolean;
}
// Concept group header — same outer shape as BundleHeader so the existing
// tree expansion / pagination machinery treats them uniformly. The
// rendering branches on `kind` to show concept-specific text + link.
interface ConceptHeader {
  kind: 'concept';
  id: string;
  /** null for the synthetic "Unmapped" group. */
  concept_id: string | null;
  concept_label: string;
  concept_source: string | null;
  concept_identifier: string | null;
  concept_cui: string | null;
  cde_count: number;
  tier_summary: Record<string, number>;
  children: Array<CdeRow & { kind: 'cde'; id: string }>;
  hasChildren: boolean;
}
type HeaderRow = BundleHeader | ConceptHeader;
type TreeRow = HeaderRow | (CdeRow & { kind: 'cde'; id: string });

const treeRows = ref<TreeRow[]>([]);
const tableRef = ref<any>(null);

function buildWhere(): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (search.value.trim()) {
    const q = `%${search.value.trim().toLowerCase()}%`;
    clauses.push(
      `(LOWER(cde_name) LIKE ? OR LOWER(cde_definition) LIKE ? OR LOWER(coalesce(variable_name,'')) LIKE ? OR LOWER(coalesce(keywords,'')) LIKE ?)`,
    );
    params.push(q, q, q, q);
  }
  if (disease.value.length) {
    const diseaseClauses = disease.value.map((d) => {
      const opt = DISEASE_OPTIONS.find((o) => o.key === d);
      return opt?.column ? `${opt.column} = 'Y'` : '1=0';
    });
    clauses.push(`(${diseaseClauses.join(' OR ')})`);
  }
  if (classTier.value.length) {
    // A CDE matches if any of its classification_* columns is in the selected tier set.
    const placeholders = classTier.value.map(() => '?').join(',');
    clauses.push(
      `(${ALL_CLASSIFICATION_COLS.map((c) => `${c} IN (${placeholders})`).join(' OR ')})`,
    );
    for (const _ of ALL_CLASSIFICATION_COLS) params.push(...classTier.value);
  }
  if (bundleFilter.value) {
    clauses.push(`bundle_id = ?`);
    params.push(bundleFilter.value);
  }
  if (cdeIdFilter.value) {
    clauses.push(`cde_id = ?`);
    params.push(cdeIdFilter.value);
  }
  if (originFilter.value.length) {
    // origin_keys is a comma-joined list of source keys; match any of the
    // selected values via a substring check on a padded string.
    const ors = originFilter.value
      .map(() => `',' || COALESCE(origin_keys, '') || ',' LIKE ?`)
      .join(' OR ');
    clauses.push(`(${ors})`);
    for (const key of originFilter.value) params.push(`%,${key},%`);
  }
  const studyClause = studyTypeClause();
  if (studyClause) clauses.push(studyClause);
  if (domainFilter.value) {
    // cde_domain already COALESCEs cl.domain → b.domain, so this works for
    // bundled (NT-PRECEDS) and unbundled (NINDS) sources alike.
    clauses.push(`cde_domain = ?`);
    params.push(domainFilter.value);
  }
  if (subdomainFilter.value) {
    clauses.push(`cde_subdomain = ?`);
    params.push(subdomainFilter.value);
  }
  if (categoryFilter.value) {
    clauses.push(`cde_category = ?`);
    params.push(categoryFilter.value);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

async function loadFlat() {
  const { where, params } = buildWhere();
  const offset = (page.value - 1) * pageSize.value;
  const [dataRows, countRows] = await Promise.all([
    query<CdeRow>(
      `SELECT * FROM cde_full ${where} ORDER BY cde_name LIMIT ${pageSize.value} OFFSET ${offset}`,
      params,
    ),
    query<{ n: number }>(`SELECT count(*) AS n FROM cde_full ${where}`, params),
  ]);
  rows.value = dataRows;
  treeRows.value = [];
  total.value = Number(countRows[0]?.n ?? 0);
}

/**
 * Grouped mode: paginate by BUNDLE (not CDE).
 * - Count distinct bundles whose CDEs match the filter (+1 synthetic "Unbundled" group if any unbundled CDEs match).
 * - For this page of bundles, fetch all member CDEs and nest them as children.
 */
async function loadGrouped() {
  const { where, params } = buildWhere();

  // Count bundles that have at least one matching CDE, plus the unbundled group.
  const [bundleCountRows, unbundledRows] = await Promise.all([
    query<{ n: number }>(
      `SELECT count(DISTINCT bundle_id) AS n FROM cde_full ${where}${where ? ' AND' : ' WHERE'} bundle_id IS NOT NULL`,
      params,
    ),
    query<{ n: number }>(
      `SELECT count(*) AS n FROM cde_full ${where}${where ? ' AND' : ' WHERE'} bundle_id IS NULL`,
      params,
    ),
  ]);
  const bundleCount = Number(bundleCountRows[0]?.n ?? 0);
  const unbundledCount = Number(unbundledRows[0]?.n ?? 0);
  total.value = bundleCount + (unbundledCount > 0 ? 1 : 0);

  // Page slice of bundles (ordered alphabetically).
  const offset = (page.value - 1) * pageSize.value;
  const bundlePage = await query<{
    bundle_id: string;
    bundle_name: string;
    bundle_category: string | null;
    bundle_domain: string | null;
    bundle_working_group: string | null;
    n: number;
  }>(
    `SELECT bundle_id, bundle_name, bundle_category, bundle_domain, bundle_working_group, count(*) AS n
     FROM cde_full ${where}${where ? ' AND' : ' WHERE'} bundle_id IS NOT NULL
     GROUP BY bundle_id, bundle_name, bundle_category, bundle_domain, bundle_working_group
     ORDER BY bundle_name
     LIMIT ${pageSize.value} OFFSET ${offset}`,
    params,
  );

  // Decide if the synthetic Unbundled group belongs on this page (appended last).
  const totalPages = Math.max(1, Math.ceil(total.value / pageSize.value));
  const includeUnbundled = unbundledCount > 0 && page.value === totalPages;

  // Fetch child CDEs for the bundles on this page.
  const bundleIds = bundlePage.map((b) => b.bundle_id);
  const children: CdeRow[] = [];
  if (bundleIds.length) {
    const placeholders = bundleIds.map(() => '?').join(',');
    const childRows = await query<CdeRow>(
      `SELECT * FROM cde_full ${where}${where ? ' AND' : ' WHERE'} bundle_id IN (${placeholders})
       ORDER BY bundle_name, cde_name`,
      [...params, ...bundleIds],
    );
    children.push(...childRows);
  }

  // Optionally add the synthetic Unbundled group's CDEs (limit — just grab them all; usually small).
  let unbundledChildren: CdeRow[] = [];
  if (includeUnbundled) {
    unbundledChildren = await query<CdeRow>(
      `SELECT * FROM cde_full ${where}${where ? ' AND' : ' WHERE'} bundle_id IS NULL ORDER BY cde_name`,
      params,
    );
  }

  const byBundle = new Map<string, CdeRow[]>();
  for (const c of children) {
    if (!c.bundle_id) continue;
    if (!byBundle.has(c.bundle_id)) byBundle.set(c.bundle_id, []);
    byBundle.get(c.bundle_id)!.push(c);
  }

  const tree: TreeRow[] = bundlePage.map((b) => {
    const kids = byBundle.get(b.bundle_id) ?? [];
    return {
      kind: 'bundle' as const,
      id: `b:${b.bundle_id}`,
      bundle_id: b.bundle_id,
      bundle_name: b.bundle_name,
      bundle_category: b.bundle_category,
      bundle_domain: b.bundle_domain,
      bundle_working_group: b.bundle_working_group,
      cde_count: kids.length,
      tier_summary: summarizeTiers(kids),
      children: kids.map((c) => ({ ...c, kind: 'cde' as const, id: `c:${c.cde_id}` })),
      hasChildren: kids.length > 0,
    };
  });

  if (includeUnbundled && unbundledChildren.length) {
    tree.push({
      kind: 'bundle',
      id: 'b:__unbundled__',
      bundle_id: null,
      bundle_name: 'Unbundled CDEs',
      bundle_category: null,
      bundle_domain: null,
      bundle_working_group: null,
      cde_count: unbundledChildren.length,
      tier_summary: summarizeTiers(unbundledChildren),
      children: unbundledChildren.map((c) => ({
        ...c,
        kind: 'cde' as const,
        id: `c:${c.cde_id}`,
      })),
      hasChildren: true,
    });
  }

  treeRows.value = tree;
  rows.value = [];
}

function summarizeTiers(cdes: CdeRow[]): Record<string, number> {
  const cols: Array<keyof CdeRow> = [
    'classification_tbi',
    'classification_pte',
    'classification_sci',
    'classification_neurotrauma',
    'classification_agnostic',
  ];
  const out: Record<string, number> = { Core: 0, Recommended: 0, Supplemental: 0 };
  for (const c of cdes) {
    let best: string | null = null;
    for (const col of cols) {
      const v = c[col] as string | null;
      if (v === 'Core') {
        best = 'Core';
        break;
      }
      if (v === 'Recommended' && best !== 'Core') best = 'Recommended';
      else if (v === 'Supplemental' && !best) best = 'Supplemental';
    }
    if (best && out[best] !== undefined) out[best]++;
  }
  return out;
}

/**
 * Concept mode: paginate by CONCEPT.
 * Each header row is one concept (or the synthetic "Unmapped" group for
 * CDEs that have no row in cde_represents_concept). Children are the CDEs
 * that point at the concept. Same pagination invariants as loadGrouped.
 */
async function loadByConcept() {
  const { where, params } = buildWhere();

  // The user's filter clauses (built by buildWhere()) reference unqualified
  // columns like `cde_id`, `bundle_id`, etc. These exist on cde_full but
  // also on cde_represents_concept — so we evaluate the filter inside a CTE
  // over cde_full alone, then JOIN downstream against that single-table
  // filter result. This keeps every column reference unambiguous.
  //
  // We bind the filter params twice (for count and concept-page queries),
  // so each call repeats the same params array.
  const ctePrefix = `WITH matching_cdes AS (SELECT cde_id FROM cde_full ${where})`;

  const [conceptCountRows, unmappedRows] = await Promise.all([
    query<{ n: number }>(
      `${ctePrefix}
       SELECT count(DISTINCT r.concept_id) AS n
       FROM cde_represents_concept r
       WHERE r.cde_id IN (SELECT cde_id FROM matching_cdes)`,
      params,
    ),
    query<{ n: number }>(
      `${ctePrefix}
       SELECT count(*) AS n
       FROM matching_cdes
       WHERE cde_id NOT IN (SELECT cde_id FROM cde_represents_concept)`,
      params,
    ),
  ]);
  const conceptCount = Number(conceptCountRows[0]?.n ?? 0);
  const unmappedCount = Number(unmappedRows[0]?.n ?? 0);
  total.value = conceptCount + (unmappedCount > 0 ? 1 : 0);

  const offset = (page.value - 1) * pageSize.value;
  const conceptPage = await query<{
    concept_id: string;
    source: string;
    identifier: string;
    cui: string | null;
    preferred_label: string | null;
    n: number;
  }>(
    `${ctePrefix}
     SELECT
       c.id AS concept_id,
       c.source,
       c.identifier,
       c.cui,
       c.preferred_label,
       count(DISTINCT r.cde_id) AS n
     FROM concept c
     JOIN cde_represents_concept r ON r.concept_id = c.id
     WHERE r.cde_id IN (SELECT cde_id FROM matching_cdes)
     GROUP BY c.id, c.source, c.identifier, c.cui, c.preferred_label
     ORDER BY c.source, c.identifier
     LIMIT ${pageSize.value} OFFSET ${offset}`,
    params,
  );

  const totalPages = Math.max(1, Math.ceil(total.value / pageSize.value));
  const includeUnmapped = unmappedCount > 0 && page.value === totalPages;

  const conceptIds = conceptPage.map((c) => c.concept_id);
  const children: Array<CdeRow & { _concept_id: string }> = [];
  if (conceptIds.length) {
    const placeholders = conceptIds.map(() => '?').join(',');
    const childRows = await query<CdeRow & { _concept_id: string }>(
      `${ctePrefix}
       SELECT f.*, r.concept_id AS _concept_id
       FROM cde_full f
       JOIN cde_represents_concept r ON r.cde_id = f.cde_id
       WHERE f.cde_id IN (SELECT cde_id FROM matching_cdes)
         AND r.concept_id IN (${placeholders})
       ORDER BY r.concept_id, f.cde_name`,
      [...params, ...conceptIds],
    );
    children.push(...childRows);
  }

  let unmappedChildren: CdeRow[] = [];
  if (includeUnmapped) {
    unmappedChildren = await query<CdeRow>(
      `${ctePrefix}
       SELECT f.* FROM cde_full f
       WHERE f.cde_id IN (SELECT cde_id FROM matching_cdes)
         AND f.cde_id NOT IN (SELECT cde_id FROM cde_represents_concept)
       ORDER BY f.cde_name`,
      params,
    );
  }

  const byConcept = new Map<string, CdeRow[]>();
  for (const c of children) {
    if (!byConcept.has(c._concept_id)) byConcept.set(c._concept_id, []);
    byConcept.get(c._concept_id)!.push(c);
  }

  const tree: TreeRow[] = conceptPage.map((c) => {
    const kids = byConcept.get(c.concept_id) ?? [];
    return {
      kind: 'concept' as const,
      id: `cn:${c.concept_id}`,
      concept_id: c.concept_id,
      concept_label:
        c.preferred_label?.trim() || `${c.source}:${c.identifier}`,
      concept_source: c.source,
      concept_identifier: c.identifier,
      concept_cui: c.cui,
      cde_count: kids.length,
      tier_summary: summarizeTiers(kids),
      children: kids.map((k) => ({ ...k, kind: 'cde' as const, id: `c:${k.cde_id}` })),
      hasChildren: kids.length > 0,
    };
  });

  if (includeUnmapped && unmappedChildren.length) {
    tree.push({
      kind: 'concept',
      id: 'cn:__unmapped__',
      concept_id: null,
      concept_label: 'Unmapped',
      concept_source: null,
      concept_identifier: null,
      concept_cui: null,
      cde_count: unmappedChildren.length,
      tier_summary: summarizeTiers(unmappedChildren),
      children: unmappedChildren.map((c) => ({
        ...c,
        kind: 'cde' as const,
        id: `c:${c.cde_id}`,
      })),
      hasChildren: unmappedChildren.length > 0,
    });
  }

  treeRows.value = tree;
  rows.value = [];
}

async function load() {
  if (status.value !== 'ready') return;
  loading.value = true;
  try {
    if (viewMode.value === 'grouped') await loadGrouped();
    else if (viewMode.value === 'concept') await loadByConcept();
    else await loadFlat();
  } finally {
    loading.value = false;
  }
}

watch(status, async (s) => {
  if (s === 'ready') {
    const r = await query<{ n: number }>(
      `SELECT count(*) AS n FROM cde_full WHERE bundle_id IS NOT NULL`,
    );
    hasAnyBundles.value = Number(r[0]?.n ?? 0) > 0;
    if (!hasAnyBundles.value) viewMode.value = 'flat';
    load();
  }
});

watch(
  [search, disease, classTier, bundleFilter, cdeIdFilter, domainFilter, subdomainFilter, categoryFilter, originFilter, studyTypeFilter, pageSize, viewMode],
  () => {
    page.value = 1;
    load();
  },
);

// Resync filters when the URL query changes (heatmap drill-through, in-app
// links, browser back/forward). The component instance persists across
// /explore → /cdes navigations, so without this the new query params would be
// ignored and the page would render with whatever filters were last set.
watch(() => route.query, syncFiltersFromQuery);

function isBundleRow(row: TreeRow): row is BundleHeader {
  return (row as BundleHeader).kind === 'bundle';
}
function isConceptRow(row: TreeRow): row is ConceptHeader {
  return (row as ConceptHeader).kind === 'concept';
}
function isHeaderRow(row: TreeRow): row is HeaderRow {
  return isBundleRow(row) || isConceptRow(row);
}

function handleRowClick(row: TreeRow) {
  if (isHeaderRow(row)) {
    // Click on a parent row toggles expansion.
    tableRef.value?.toggleRowExpansion?.(row);
    return;
  }
  selectedCde.value = row as unknown as CdeRow;
  drawerOpen.value = true;
}

function expandAll() {
  for (const r of treeRows.value) {
    if (isHeaderRow(r) && r.hasChildren) {
      tableRef.value?.toggleRowExpansion?.(r, true);
    }
  }
}

function collapseAll() {
  for (const r of treeRows.value) {
    if (isHeaderRow(r) && r.hasChildren) {
      tableRef.value?.toggleRowExpansion?.(r, false);
    }
  }
}

// Row className so we can style header rows differently from leaf CDE rows.
function rowClass({ row }: { row: TreeRow }) {
  if (viewMode.value === 'flat') return '';
  return isHeaderRow(row) ? 'row-bundle-header' : 'row-cde-leaf';
}

watch(page, () => load());

onMounted(async () => {
  if (status.value === 'ready') {
    const r = await query<{ n: number }>(
      `SELECT count(*) AS n FROM cde_full WHERE bundle_id IS NOT NULL`,
    );
    hasAnyBundles.value = Number(r[0]?.n ?? 0) > 0;
    if (!hasAnyBundles.value) viewMode.value = 'flat';
    load();
  }
});

const bundleOptions = ref<Array<{ id: string; label: string }>>([]);
async function loadBundleOptions() {
  const r = await query<{ id: string; bundle_name: string; category: string }>(
    `SELECT id, bundle_name, category FROM bundle ORDER BY bundle_name`,
  );
  bundleOptions.value = r.map((b) => ({
    id: b.id,
    label: `${b.bundle_name}${b.category ? '  ·  ' + b.category : ''}`,
  }));
}
watch(status, (s) => {
  if (s === 'ready') loadBundleOptions();
}, { immediate: true });

const bundleFilterLabel = computed(() => {
  if (!bundleFilter.value) return null;
  return bundleOptions.value.find((b) => b.id === bundleFilter.value)?.label ?? null;
});

function clearQueryParam(key: string) {
  const q = { ...route.query };
  delete q[key];
  router.replace({ query: q });
}

function clearBundleFilter() {
  bundleFilter.value = null;
  clearQueryParam('bundle');
}
function clearDomainFilter() {
  domainFilter.value = null;
  clearQueryParam('domain');
}
function clearSubdomainFilter() {
  subdomainFilter.value = null;
  clearQueryParam('subdomain');
}
function clearCategoryFilter() {
  categoryFilter.value = null;
  clearQueryParam('category');
}
function clearCdeIdFilter() {
  cdeIdFilter.value = null;
  clearQueryParam('cde');
}

const diseaseOptions = DISEASE_OPTIONS
  .filter((o) => o.column !== null)
  .map((o) => ({ value: o.key, label: o.label }));

// Origin options — loaded dynamically from the data so new sources pick up
// automatically without a code change.
const originOptions = ref<Array<{ value: string; label: string; study_type: string | null }>>([]);
async function loadOriginOptions() {
  try {
    const rows = await query<{ source_key: string; label: string; study_type: string | null }>(
      `SELECT source_key, label, study_type FROM source_labels ORDER BY ord`,
    );
    originOptions.value = rows.map((r) => ({
      value: r.source_key,
      label: r.label,
      study_type: r.study_type ?? null,
    }));
  } catch {
    originOptions.value = [];
  }
}
watch(status, (s) => {
  if (s === 'ready') loadOriginOptions();
}, { immediate: true });

// When the user picks origin(s), auto-align the Study type filter so they
// don't accidentally filter out everything they just selected. If the chosen
// origins agree on a study_type, snap to it; if they disagree, drop to "all".
watch(originFilter, (selected) => {
  if (!selected.length || !originOptions.value.length) return;
  const types = new Set(
    selected
      .map((k) => originOptions.value.find((o) => o.value === k)?.study_type)
      .filter((t): t is 'Clinical' | 'Preclinical' => t === 'Clinical' || t === 'Preclinical'),
  );
  if (types.size === 1) {
    studyTypeFilter.value = [...types][0];
  } else if (types.size > 1) {
    studyTypeFilter.value = 'all';
  }
});
</script>

<template>
  <div class="cdes-view">
    <div class="cdes-view__header page-header">
      <div>
        <h1>Common Data Elements</h1>
        <p class="lede">
          Standardized questions with defined data types, permissible values,
          and code systems — the building blocks you combine into Case Report
          Forms.
        </p>
        <div class="subtle">
          {{ loading ? 'Loading…' : `${total.toLocaleString()} CDEs` }}
          <template v-if="bundleFilterLabel">
            · bundle:
            <el-tag size="small" closable @close="clearBundleFilter">
              {{ bundleFilterLabel }}
            </el-tag>
          </template>
          <template v-if="domainFilter">
            · domain:
            <el-tag size="small" closable type="info" @close="clearDomainFilter">
              {{ domainFilter }}
            </el-tag>
          </template>
          <template v-if="subdomainFilter">
            · subdomain:
            <el-tag size="small" closable type="info" @close="clearSubdomainFilter">
              {{ subdomainFilter }}
            </el-tag>
          </template>
          <template v-if="categoryFilter">
            · category:
            <el-tag size="small" closable type="info" @close="clearCategoryFilter">
              {{ categoryFilter }}
            </el-tag>
          </template>
          <template v-if="cdeIdFilter">
            · CDE:
            <el-tag size="small" closable type="info" @close="clearCdeIdFilter">
              {{ cdeIdFilter }}
            </el-tag>
          </template>
        </div>
      </div>
    </div>

    <div class="cdes-view__filters">
      <el-input
        v-model="search"
        placeholder="Search name, definition, variable, keywords…"
        clearable
        class="search-input"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>

      <el-select
        v-model="disease"
        multiple
        collapse-tags
        collapse-tags-tooltip
        placeholder="Disease scope"
        class="filter-select"
      >
        <el-option
          v-for="d in diseaseOptions"
          :key="d.value"
          :label="d.label"
          :value="d.value"
        />
      </el-select>

      <el-select
        v-model="classTier"
        multiple
        collapse-tags
        collapse-tags-tooltip
        placeholder="Classification tier"
        class="filter-select"
      >
        <el-option
          v-for="c in CLASSIFICATION_OPTIONS"
          :key="c"
          :label="c"
          :value="c"
        />
      </el-select>

      <el-select
        v-if="originOptions.length > 1"
        v-model="originFilter"
        multiple
        collapse-tags
        collapse-tags-tooltip
        placeholder="Origin"
        class="filter-select"
      >
        <el-option
          v-for="o in originOptions"
          :key="o.value"
          :label="o.label"
          :value="o.value"
        />
      </el-select>

      <el-select
        v-model="studyTypeFilter"
        placeholder="Study type"
        class="filter-select"
      >
        <el-option label="All studies" value="all" />
        <el-option label="Clinical" value="Clinical" />
        <el-option label="Preclinical" value="Preclinical" />
      </el-select>

    </div>

    <div class="cdes-view__view-strip">
      <el-radio-group v-if="hasAnyBundles" v-model="viewMode" size="small">
        <el-radio-button value="grouped">
          <el-icon><Grid /></el-icon>&nbsp;Grouped by bundle
        </el-radio-button>
        <el-radio-button value="concept">
          <el-icon><Connection /></el-icon>&nbsp;Grouped by concept
        </el-radio-button>
        <el-radio-button value="flat">
          <el-icon><List /></el-icon>&nbsp;Flat list
        </el-radio-button>
      </el-radio-group>

      <div v-if="viewMode !== 'flat'" class="view-actions">
        <el-button size="small" text @click="expandAll">
          <el-icon><Expand /></el-icon>&nbsp;Expand all
        </el-button>
        <el-button size="small" text @click="collapseAll">
          <el-icon><Fold /></el-icon>&nbsp;Collapse all
        </el-button>
      </div>
    </div>

    <el-table
      v-if="viewMode !== 'flat'"
      ref="tableRef"
      :data="treeRows"
      v-loading="loading"
      row-key="id"
      :tree-props="{ children: 'children' }"
      :row-class-name="rowClass"
      border
      size="small"
      height="calc(100vh - 320px)"
      highlight-current-row
      @row-click="handleRowClick"
      class="cde-table"
    >
      <el-table-column label="Bundle / CDE" min-width="340">
        <template #default="{ row }">
          <template v-if="row.kind === 'bundle'">
            <div class="bundle-header">
              <div class="bundle-header__text">
                <div class="bundle-header__row bundle-header__row--title">
                  <span class="bundle-header__kind">Bundle</span>
                  <span class="bundle-header__name">{{ row.bundle_name }}</span>
                </div>
                <div class="bundle-header__row bundle-header__row--meta">
                  <span class="bundle-header__count">{{ row.cde_count }} CDEs</span>
                  <span v-if="row.bundle_category" class="bundle-header__meta">
                    · {{ row.bundle_category }}
                  </span>
                  <span v-if="row.bundle_working_group" class="bundle-header__meta">
                    · {{ row.bundle_working_group }}
                  </span>
                </div>
              </div>
              <router-link
                v-if="row.bundle_id"
                :to="`/bundles/${row.bundle_id}`"
                class="bundle-header__link"
                @click.stop
              >
                Open →
              </router-link>
            </div>
          </template>
          <template v-else-if="row.kind === 'concept'">
            <div class="bundle-header bundle-header--concept">
              <div class="bundle-header__text">
                <div class="bundle-header__row bundle-header__row--title">
                  <span class="bundle-header__kind bundle-header__kind--concept">
                    {{ row.concept_id ? 'Concept' : '—' }}
                  </span>
                  <span class="bundle-header__name">{{ row.concept_label }}</span>
                  <span v-if="row.concept_cui" class="bundle-header__cui mono">
                    {{ row.concept_cui }}
                  </span>
                </div>
                <div class="bundle-header__row bundle-header__row--meta">
                  <span class="bundle-header__count">{{ row.cde_count }} CDEs</span>
                  <span v-if="row.concept_source" class="bundle-header__meta">
                    · {{ row.concept_source }}
                  </span>
                  <span v-if="row.concept_identifier" class="bundle-header__meta mono">
                    · {{ row.concept_identifier }}
                  </span>
                </div>
              </div>
              <router-link
                v-if="row.concept_id"
                :to="`/concepts/${row.concept_id}`"
                class="bundle-header__link"
                @click.stop
              >
                Open →
              </router-link>
            </div>
          </template>
          <template v-else>
            <div class="cell-name">
              <span class="cell-name__label">{{ row.cde_name }}</span>
              <span v-if="row.variable_name" class="mono muted">
                {{ row.variable_name }}
              </span>
            </div>
          </template>
        </template>
      </el-table-column>
      <el-table-column label="Type" width="115">
        <template #default="{ row }">
          <span v-if="row.kind === 'cde'">{{ row.cde_data_type }}</span>
        </template>
      </el-table-column>
      <el-table-column label="Definition" min-width="320" show-overflow-tooltip>
        <template #default="{ row }">
          <template v-if="row.kind === 'cde'">{{ row.cde_definition }}</template>
          <template v-else-if="row.kind === 'bundle'">
            <span class="bundle-header__domain muted">{{ row.bundle_domain }}</span>
          </template>
        </template>
      </el-table-column>
      <el-table-column label="Disease" width="160">
        <template #default="{ row }">
          <DiseaseScopeCell v-if="row.kind === 'cde'" :row="row" />
        </template>
      </el-table-column>
      <el-table-column label="Classification" width="240">
        <template #default="{ row }">
          <template v-if="row.kind === 'bundle' || row.kind === 'concept'">
            <div class="cell-class">
              <span
                v-if="row.tier_summary.Core"
                class="pill pill--core"
              >Core · {{ row.tier_summary.Core }}</span>
              <span
                v-if="row.tier_summary.Recommended"
                class="pill pill--recommended"
              >Rec · {{ row.tier_summary.Recommended }}</span>
              <span
                v-if="row.tier_summary.Supplemental"
                class="pill pill--supplemental"
              >Suppl · {{ row.tier_summary.Supplemental }}</span>
            </div>
          </template>
          <template v-else>
            <div class="cell-class">
              <ClassificationPill
                v-if="isActiveTier(row.classification_agnostic)"
                :value="row.classification_agnostic"
                prefix="AGN"
              />
              <ClassificationPill
                v-if="isActiveTier(row.classification_neurotrauma)"
                :value="row.classification_neurotrauma"
                prefix="NT"
              />
              <ClassificationPill
                v-if="isActiveTier(row.classification_tbi)"
                :value="row.classification_tbi"
                prefix="TBI"
              />
              <ClassificationPill
                v-if="isActiveTier(row.classification_pte)"
                :value="row.classification_pte"
                prefix="PTE"
              />
              <ClassificationPill
                v-if="isActiveTier(row.classification_sci)"
                :value="row.classification_sci"
                prefix="SCI"
              />
            </div>
          </template>
        </template>
      </el-table-column>
    </el-table>

    <el-table
      v-else
      :data="rows"
      v-loading="loading"
      stripe
      border
      size="small"
      height="calc(100vh - 320px)"
      highlight-current-row
      @row-click="handleRowClick"
      class="cde-table"
    >
      <el-table-column prop="cde_name" label="Name" min-width="260" fixed>
        <template #default="{ row }">
          <div class="cell-name">
            <span class="cell-name__label">{{ row.cde_name }}</span>
            <span v-if="row.variable_name" class="mono muted">
              {{ row.variable_name }}
            </span>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="cde_data_type" label="Type" width="115" />
      <el-table-column label="Definition" min-width="320" show-overflow-tooltip>
        <template #default="{ row }">{{ row.cde_definition }}</template>
      </el-table-column>
      <el-table-column label="Disease" width="160">
        <template #default="{ row }"><DiseaseScopeCell :row="row" /></template>
      </el-table-column>
      <el-table-column label="Classification" width="220">
        <template #default="{ row }">
          <div class="cell-class">
            <ClassificationPill
              v-if="isActiveTier(row.classification_agnostic)"
              :value="row.classification_agnostic"
              prefix="AGN"
            />
            <ClassificationPill
              v-if="isActiveTier(row.classification_neurotrauma)"
              :value="row.classification_neurotrauma"
              prefix="NT"
            />
            <ClassificationPill
              v-if="isActiveTier(row.classification_tbi)"
              :value="row.classification_tbi"
              prefix="TBI"
            />
            <ClassificationPill
              v-if="isActiveTier(row.classification_pte)"
              :value="row.classification_pte"
              prefix="PTE"
            />
            <ClassificationPill
              v-if="isActiveTier(row.classification_sci)"
              :value="row.classification_sci"
              prefix="SCI"
            />
          </div>
        </template>
      </el-table-column>
      <el-table-column label="Bundle" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">
          <router-link
            v-if="row.bundle_id"
            :to="`/bundles/${row.bundle_id}`"
            @click.stop
          >
            {{ row.bundle_name }}
          </router-link>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="source_count" label="Sources" width="90" align="center">
        <template #default="{ row }">
          <el-tooltip
            v-if="row.source_labels"
            :content="row.source_labels"
            placement="top"
          >
            <span>{{ row.source_count }}</span>
          </el-tooltip>
          <span v-else class="muted">0</span>
        </template>
      </el-table-column>
    </el-table>

    <div class="cdes-view__pager">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :page-sizes="viewMode !== 'flat' ? [10, 20, 50, 100] : [25, 50, 100, 200]"
        layout="total, sizes, prev, pager, next, jumper"
        :total="total"
        background
      />
      <div class="pager-note subtle">
        {{ viewMode === 'grouped' ? 'bundles per page' : viewMode === 'concept' ? 'concepts per page' : 'CDEs per page' }}
      </div>
    </div>

    <CdeDetailDrawer
      v-model="drawerOpen"
      :cde="selectedCde"
    />
  </div>
</template>

<style lang="scss" scoped>
.cdes-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;

  &__header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
  }

  &__filters {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .search-input {
    flex: 1 1 320px;
    max-width: 520px;
  }

  .filter-select {
    width: 200px;
  }

  &__pager {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 12px;
  }

  &__view-strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 6px 10px;
    background: $white;
    border: 1px solid $lineColor2;
    border-radius: 2px;
  }
}

.pager-note {
  font-size: 11px;
}

.view-actions {
  display: flex;
  gap: 4px;
}

.cde-table :deep(.el-table__row) {
  cursor: pointer;
}

.cell-name {
  display: flex;
  flex-direction: column;
  gap: 2px;

  &__label {
    font-weight: 500;
    color: $gray_6;
  }
}

.cell-class {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}

// Option A: white table, blue-tinted bundle rows. One accent color
// ($es-primary-color) carries the hierarchy — header underline, bundle fill,
// leaf hover — so no competing grays.
.cde-table {
  // Column header: white (same as leaf rows) anchored by a darker-than-rows
  // hairline bottom border. The table already reads as a white island on the
  // gray page, so the header needs weight + a rule, not a fill or an accent.
  :deep(.el-table__header th.el-table__cell) {
    background-color: $white;
    padding-top: 10px;
    padding-bottom: 10px;
    font-weight: 600;
    color: $gray_6;
    border-bottom: 1px solid $lineColor1;
  }

  // Bundle header rows: a neutral gray tint separates them from leaves; the
  // "BUNDLE" eyebrow label + a subtle accent border on the first cell carries
  // the "this is a group header" signal without a big green blob.
  :deep(.el-table__row.row-bundle-header) {
    td {
      background-color: $gray_1;
      padding: 6px 10px;
    }
    td:first-child {
      box-shadow: inset 3px 0 0 $es-primary-color;
    }
    &:hover td {
      background-color: $gray_0 !important;
    }
    // Row click toggles expansion; hide the built-in chevron to keep the row clean.
    .el-table__expand-icon {
      display: none;
    }
    // Reclaim the indent the chevron used to occupy.
    .el-table__indent + .el-table__placeholder,
    .el-table__indent {
      display: none;
    }
  }

  // Leaf CDE rows: white with loose vertical rhythm.
  :deep(.el-table__row.row-cde-leaf) td {
    background-color: $white;
    padding: 10px 10px;
    line-height: 1.5;
  }

  // Flat-mode rows pick up the same breathing room.
  :deep(.el-table__row) td {
    line-height: 1.5;
  }
  :deep(.el-table--small .el-table__cell) {
    padding-top: 8px;
    padding-bottom: 8px;
  }

  // Hairline row divider — borders over shadows.
  :deep(.el-table td.el-table__cell) {
    border-bottom-color: $lineColor2;
  }

  // Subtle hover on leaves — same tint as bundle rows so the hover "pops" to
  // the group-row layer rather than introducing a new color.
  :deep(.el-table__row.row-cde-leaf:hover > td.el-table__cell),
  :deep(.el-table--enable-row-hover .el-table__row:not(.row-bundle-header):hover > td.el-table__cell) {
    background-color: $gray_1;
  }
}

.bundle-header {
  display: flex;
  align-items: center;
  gap: 10px;
  color: $gray_6;
  min-width: 0;

  &__text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  &__row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;

    &--meta {
      gap: 6px;
    }
  }

  &__kind {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: $gray_4;
    font-weight: 600;

    &--concept {
      color: $purple_3;
    }
  }

  &__name {
    font-weight: 600;
    font-size: 13px;
    color: $gray_6;
  }

  &__cui {
    font-size: 10px;
    color: $gray_5;
    background: $gray_1;
    padding: 1px 6px;
    border-radius: 2px;
  }

  &__count {
    font-size: 11px;
    background: $gray_2;
    color: $gray_6;
    padding: 0 6px;
    border-radius: 2px;
    font-weight: 600;
    letter-spacing: 0.3px;
  }

  &__meta {
    font-size: 11px;
    color: $gray_4;
  }

  &__link {
    flex-shrink: 0;
    margin-left: auto;
    font-size: 11px;
    color: $es-primary-color;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 600;
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }
}
</style>
