<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useDuckDB } from '@/composables/useDuckDB';
import { useDiseaseLens } from '@/composables/useDiseaseLens';
import { useStudyType } from '@/composables/useStudyType';
import DonutChart from './DonutChart.vue';

const router = useRouter();
const { status, query } = useDuckDB();
const { lens, option, clause, classificationColumn } = useDiseaseLens();
const { filter: studyTypeFilter, clause: studyTypeClause } = useStudyType();

const heatmap = ref<HeatCell[]>([]);
// Donut data — three slices through the same filtered CDE set.
interface SliceRow {
  label: string;
  count: number;
}
const tierSlices = ref<SliceRow[]>([]);
const domainSlices = ref<SliceRow[]>([]);
const sourceSlices = ref<SliceRow[]>([]);
const loading = ref(false);

// Heatmap row dimension — what each row groups by. Tier stays on the columns
// (3 fixed buckets) so this dimension can have many values without making
// the heatmap unreadably wide.
type GroupBy = 'domain' | 'subdomain' | 'category' | 'source';
const groupBy = ref<GroupBy>('domain');

const GROUP_BY_OPTIONS: Array<{ key: GroupBy; label: string; sqlExpr: string }> = [
  { key: 'domain', label: 'Domain', sqlExpr: `COALESCE(bundle_domain, 'Unassigned')` },
  { key: 'subdomain', label: 'Subdomain', sqlExpr: `COALESCE(bundle_subdomain, 'Unassigned')` },
  { key: 'category', label: 'Category', sqlExpr: `COALESCE(bundle_category, 'Unassigned')` },
  { key: 'source', label: 'Source', sqlExpr: `COALESCE(origins, 'Unknown')` },
];

const groupBySqlExpr = computed(
  () => GROUP_BY_OPTIONS.find((o) => o.key === groupBy.value)!.sqlExpr,
);
const groupByLabel = computed(
  () => GROUP_BY_OPTIONS.find((o) => o.key === groupBy.value)!.label,
);

// Tier color tokens — kept in sync with the heatmap + tier-stat-card borders.
const TIER_COLORS: Record<string, string> = {
  Core: '#2d6b3a',
  Recommended: '#1f528f',
  Supplemental: '#7a4a05',
  'Not Applicable': '#9aa0a6',
  Unclassified: '#c4c8cc',
};

// Categorical palette for domain/source donuts. Picked for readable contrast
// against each other and against the white panel background.
const PALETTE = [
  '#1f528f', '#2d6b3a', '#7a4a05', '#7c3aed',
  '#0ea5a3', '#b45309', '#be185d', '#475569',
];

function tierColor(label: string): string {
  return TIER_COLORS[label] ?? PALETTE[0];
}
function paletteColor(i: number): string {
  return PALETTE[i % PALETTE.length];
}

const tierDonutSegments = computed(() =>
  tierSlices.value.map((s) => ({ ...s, color: tierColor(s.label) })),
);
const domainDonutSegments = computed(() =>
  domainSlices.value.map((s, i) => ({ ...s, color: paletteColor(i) })),
);
const sourceDonutSegments = computed(() =>
  sourceSlices.value.map((s, i) => ({ ...s, color: paletteColor(i) })),
);

interface HeatCell {
  tier: string;
  group: string;
  cde_count: number;
}

const TIER_ROWS: Array<{ key: 'Core' | 'Recommended' | 'Supplemental'; label: string }> = [
  { key: 'Core', label: 'Core' },
  { key: 'Recommended', label: 'Recommended' },
  { key: 'Supplemental', label: 'Supplemental' },
];

// When lens = 'all', we still want a tier × domain view — fall back to the
// best tier across all five classification columns per CDE.
const ALL_TIER_COLS = [
  'classification_agnostic',
  'classification_neurotrauma',
  'classification_tbi',
  'classification_pte',
  'classification_sci',
];
const ALL_TIER_LIST = `[${ALL_TIER_COLS.join(', ')}]`;

function tierExpression(tierCol: string | null): string {
  if (tierCol) return tierCol;
  // Best tier across all disease columns.
  return `CASE
    WHEN list_contains(${ALL_TIER_LIST}, 'Core') THEN 'Core'
    WHEN list_contains(${ALL_TIER_LIST}, 'Recommended') THEN 'Recommended'
    WHEN list_contains(${ALL_TIER_LIST}, 'Supplemental') THEN 'Supplemental'
    ELSE NULL
  END`;
}

async function load() {
  if (status.value !== 'ready') return;
  loading.value = true;
  try {
    const parts: string[] = [];
    const lensClause = clause();
    if (lensClause) parts.push(lensClause);
    const stClause = studyTypeClause();
    if (stClause) parts.push(stClause);
    const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
    const tierCol = classificationColumn();
    const tierExpr = tierExpression(tierCol);

    const groupExpr = groupBySqlExpr.value;
    const [tiers, heat, domainBreakdown, sourceBreakdown] = await Promise.all([
      query<{ tier: string; n: number }>(
        `SELECT ${tierExpr} AS tier, count(*) AS n FROM cde_full ${where} GROUP BY ${tierExpr}`,
      ),
      query<HeatCell>(`
        SELECT
          ${tierExpr} AS tier,
          ${groupExpr} AS "group",
          count(*) AS cde_count
        FROM cde_full
        ${where}
        GROUP BY ${tierExpr}, ${groupExpr}
        HAVING ${tierExpr} IN ('Core', 'Recommended', 'Supplemental')
      `),
      query<{ label: string; n: number }>(`
        SELECT COALESCE(bundle_domain, 'Unassigned') AS label, count(*) AS n
        FROM cde_full ${where}
        GROUP BY COALESCE(bundle_domain, 'Unassigned')
      `),
      // Origins is the canonical-dedup label list (e.g. "NINDS Epilepsy · NLM
      // CDE Repository") — bucket each CDE by the full set of sources it
      // appeared in, so multi-source CDEs become their own slice.
      query<{ label: string; n: number }>(`
        SELECT COALESCE(origins, 'Unknown') AS label, count(*) AS n
        FROM cde_full ${where}
        GROUP BY COALESCE(origins, 'Unknown')
      `),
    ]);

    heatmap.value = heat.map((c) => ({ ...c, cde_count: Number(c.cde_count) }));

    // Tier donut: stable order, fold null/empty under "Unclassified" so the
    // donut always sums to the filtered total.
    const tierOrder = ['Core', 'Recommended', 'Supplemental', 'Not Applicable'];
    const tierByLabel = new Map<string, number>();
    for (const t of tiers) {
      const label = (t.tier && tierOrder.includes(t.tier)) ? t.tier : 'Unclassified';
      tierByLabel.set(label, (tierByLabel.get(label) ?? 0) + Number(t.n));
    }
    tierSlices.value = [...tierOrder, 'Unclassified']
      .filter((k) => tierByLabel.has(k))
      .map((label) => ({ label, count: tierByLabel.get(label)! }));

    domainSlices.value = domainBreakdown.map((d) => ({ label: d.label, count: Number(d.n) }));
    sourceSlices.value = sourceBreakdown.map((s) => ({ label: s.label, count: Number(s.n) }));
  } finally {
    loading.value = false;
  }
}

watch([status, lens, studyTypeFilter, groupBy], load);
onMounted(load);

// Heatmap row labels: unique values of the selected groupBy dimension,
// sorted by their total CDE count desc so the biggest groups float to top.
const groupRows = computed(() => {
  const counts = new Map<string, number>();
  for (const c of heatmap.value) {
    counts.set(c.group, (counts.get(c.group) ?? 0) + c.cde_count);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([d]) => d);
});

// Pivoted matrix: one entry per row (groupBy value), each holding the three
// tier-column cells. Tier moves to columns so the row dimension can have
// many values without making the table unreadably wide.
const heatmapMatrix = computed(() => {
  const max = heatmap.value.reduce((m, c) => Math.max(m, c.cde_count), 0);
  return groupRows.value.map((g) => ({
    group: g,
    cells: TIER_ROWS.map((t) => {
      const cell = heatmap.value.find(
        (h) => h.tier === t.key && h.group === g,
      );
      const n = cell?.cde_count ?? 0;
      return {
        tier: t.key,
        count: n,
        intensity: max > 0 ? n / max : 0,
      };
    }),
  }));
});

// Map the active groupBy + clicked row label into the CDE list filter shape.
// `domain` and `source` are filterable on the /cdes route; subdomain and
// category fall back to disease+tier filtering with the row label only used
// for the URL search query string for now.
function rowFilterFor(group: string): Record<string, string | undefined> {
  switch (groupBy.value) {
    case 'domain':
      return { domain: group };
    case 'source':
      return { source: group };
    case 'subdomain':
      return { subdomain: group };
    case 'category':
      return { category: group };
  }
}

function goToCdes(params: Record<string, string | undefined>) {
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v) q[k] = v;
  if (lens.value !== 'all' && !('disease' in params)) q.disease = lens.value;
  router.push({ path: '/cdes', query: q });
}

</script>

<template>
  <div class="overview" v-loading="loading">
    <!-- High-level breakdowns — three donuts over the same filtered set so
         the reviewer can size up the collection at a glance. The donut
         center totals + the per-tier slice counts replace what the stat
         cards used to show, so this section also serves as the "hero". -->
    <section class="donut-row">
      <DonutChart
        title="By tier"
        center-label="CDEs"
        :segments="tierDonutSegments"
      />
      <DonutChart
        title="By domain"
        center-label="CDEs"
        :segments="domainDonutSegments"
      />
      <DonutChart
        title="By source"
        center-label="CDEs"
        :segments="sourceDonutSegments"
      />
    </section>

    <!-- Coverage matrix: tier columns × user-pickable row dimension. Flipped
         from the older tier-on-rows layout so the row dimension can span
         many values (subdomain, source, …) without overflowing horizontally. -->
    <section class="panel">
      <header class="panel__head panel__head--row">
        <div>
          <h2>Coverage by tier × {{ groupByLabel.toLowerCase() }}</h2>
          <p class="subtle">
            For {{ option(lens).longLabel }}: how Core, Recommended, and
            Supplemental CDEs distribute across the chosen breakdown.
            Darker = more CDEs. Click a cell to drill into the filtered CDE list.
          </p>
        </div>
        <div class="heatmap-controls">
          <span class="heatmap-controls__label">Rows by</span>
          <el-radio-group v-model="groupBy" size="small">
            <el-radio-button
              v-for="o in GROUP_BY_OPTIONS"
              :key="o.key"
              :value="o.key"
            >
              {{ o.label }}
            </el-radio-button>
          </el-radio-group>
        </div>
      </header>
      <div class="heatmap">
        <div class="heatmap__row heatmap__row--head">
          <div class="heatmap__corner">{{ groupByLabel }}</div>
          <div
            v-for="t in TIER_ROWS"
            :key="t.key"
            class="heatmap__col-head"
            :class="`tier-label--${t.key.toLowerCase()}`"
          >
            {{ t.label }}
          </div>
        </div>
        <div
          v-for="row in heatmapMatrix"
          :key="row.group"
          class="heatmap__row"
        >
          <div class="heatmap__row-head" :title="row.group">{{ row.group }}</div>
          <div
            v-for="cell in row.cells"
            :key="cell.tier"
            class="heatmap__cell"
            :class="{ 'is-empty': cell.count === 0 }"
            :style="{
              backgroundColor: cell.count === 0 ? undefined : `rgba(62, 120, 119, ${0.10 + 0.75 * cell.intensity})`,
              color: cell.intensity > 0.55 ? '#fff' : undefined,
            }"
            :title="`${cell.tier} · ${row.group}: ${cell.count} CDEs`"
            @click="cell.count && goToCdes({ tier: cell.tier, ...rowFilterFor(row.group) })"
          >
            {{ cell.count || '' }}
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style lang="scss" scoped>
.overview {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.donut-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}

.stat-card {
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 2px;
  padding: 16px;
  cursor: pointer;
  transition: transform 80ms ease, box-shadow 80ms ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
  }

  &--lead {
    background: $purple_3;
    color: $white;
    cursor: default;
    border-color: $purple_3;

    &:hover {
      transform: none;
      box-shadow: none;
    }

    .muted {
      color: rgba(255, 255, 255, 0.7);
    }
  }

  &__value {
    font-size: 28px;
    font-weight: 700;
    line-height: 1.1;
  }

  &__label {
    font-size: 13px;
    font-weight: 600;
    margin-top: 4px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  &__meta {
    font-size: 11px;
    margin-top: 4px;
  }

  &.tier-core {
    border-left: 4px solid #2d6b3a;
  }
  &.tier-recommended {
    border-left: 4px solid #1f528f;
  }
  &.tier-supplemental {
    border-left: 4px solid #7a4a05;
  }
}

.panel {
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 2px;
  padding: 1.25rem;

  &__head {
    margin-bottom: 1rem;

    h2 {
      margin-bottom: 0.25rem;
    }
    p {
      margin: 0;
    }
  }

  // Header variant where a control (e.g. dimension picker) lives flush right
  // of the title block. Wraps gracefully on narrow viewports.
  &__head--row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
}

// Flipped layout: rows = the user-picked dimension (domain/subdomain/category/
// source), columns = the three tiers. Row heights stay fixed; the row label
// truncates if it's long. Tier columns are uniform width so the heat reads
// left-to-right at a glance.
.heatmap {
  display: flex;
  flex-direction: column;
  gap: 2px;

  &__row {
    display: grid;
    grid-template-columns: minmax(220px, 1.4fr) repeat(3, minmax(110px, 1fr));
    gap: 2px;
    align-items: stretch;
  }

  &__row--head {
    .heatmap__col-head {
      font-size: 11px;
      font-weight: 700;
      color: $gray_6;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      padding: 6px 10px;
      text-align: center;
      border-bottom: 2px solid $lineColor2;
    }
    .heatmap__col-head.tier-label--core { border-bottom-color: #2d6b3a; }
    .heatmap__col-head.tier-label--recommended { border-bottom-color: #1f528f; }
    .heatmap__col-head.tier-label--supplemental { border-bottom-color: #7a4a05; }
  }

  &__corner {
    display: flex;
    align-items: center;
    padding: 6px 10px;
    font-weight: 700;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: $gray_4;
  }

  &__row-head {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    font-weight: 500;
    font-size: 13px;
    color: $gray_6;
    background: $gray_1;
    border-radius: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__cell {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 36px;
    font-size: 13px;
    font-weight: 500;
    background: $gray_0;
    color: $gray_6;
    border-radius: 2px;
    cursor: pointer;
    transition: transform 60ms ease;
    font-variant-numeric: tabular-nums;

    &:hover:not(.is-empty) {
      transform: scale(1.04);
      outline: 2px solid $es-primary-color;
      outline-offset: -2px;
    }

    &.is-empty {
      background: $gray_1;
      color: $gray_3;
      cursor: default;
    }
  }
}

.heatmap-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;

  &__label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    font-weight: 600;
    color: $gray_4;
  }
}
</style>
