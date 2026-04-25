<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useDuckDB } from '@/composables/useDuckDB';
import { useDiseaseLens } from '@/composables/useDiseaseLens';
import { useStudyType } from '@/composables/useStudyType';

const router = useRouter();
const { status, query } = useDuckDB();
const { lens, option, clause, classificationColumn } = useDiseaseLens();
const { filter: studyTypeFilter, clause: studyTypeClause } = useStudyType();

interface Stats {
  total: number;
  bundles: number;
  core: number;
  recommended: number;
  supplemental: number;
}

const stats = ref<Stats>({ total: 0, bundles: 0, core: 0, recommended: 0, supplemental: 0 });
const heatmap = ref<HeatCell[]>([]);
const topBundles = ref<TopBundle[]>([]);
const loading = ref(false);

interface HeatCell {
  tier: string;
  domain: string;
  cde_count: number;
}
interface TopBundle {
  id: string;
  bundle_name: string;
  domain: string;
  category: string;
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

    const [totals, tiers, heat, topB] = await Promise.all([
      query<{ n: number; b: number }>(
        `SELECT count(*) AS n, count(DISTINCT bundle_id) AS b FROM cde_full ${where}`,
      ),
      query<{ tier: string; n: number }>(
        `SELECT ${tierExpr} AS tier, count(*) AS n FROM cde_full ${where} GROUP BY ${tierExpr}`,
      ),
      query<HeatCell>(`
        SELECT
          ${tierExpr} AS tier,
          COALESCE(bundle_domain, 'Unassigned') AS domain,
          count(*) AS cde_count
        FROM cde_full
        ${where}
        GROUP BY ${tierExpr}, COALESCE(bundle_domain, 'Unassigned')
        HAVING ${tierExpr} IN ('Core', 'Recommended', 'Supplemental')
      `),
      query<TopBundle>(`
        SELECT
          b.id,
          b.bundle_name,
          b.domain,
          b.category,
          count(f.cde_id) AS cde_count
        FROM cde_full f
        JOIN bundle b ON b.id = f.bundle_id
        ${where}
        GROUP BY b.id, b.bundle_name, b.domain, b.category
        ORDER BY cde_count DESC
        LIMIT 8
      `),
    ]);

    const tierMap: Record<string, number> = {};
    for (const t of tiers) tierMap[t.tier ?? ''] = Number(t.n);

    stats.value = {
      total: Number(totals[0]?.n ?? 0),
      bundles: Number(totals[0]?.b ?? 0),
      core: tierMap['Core'] ?? 0,
      recommended: tierMap['Recommended'] ?? 0,
      supplemental: tierMap['Supplemental'] ?? 0,
    };
    heatmap.value = heat.map((c) => ({ ...c, cde_count: Number(c.cde_count) }));
    topBundles.value = topB.map((b) => ({ ...b, cde_count: Number(b.cde_count) }));
  } finally {
    loading.value = false;
  }
}

watch([status, lens, studyTypeFilter], load);
onMounted(load);

// Heatmap grid: unique domains sorted by total CDEs desc.
const domains = computed(() => {
  const counts = new Map<string, number>();
  for (const c of heatmap.value) {
    counts.set(c.domain, (counts.get(c.domain) ?? 0) + c.cde_count);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([d]) => d);
});

const heatmapMatrix = computed(() => {
  const max = heatmap.value.reduce((m, c) => Math.max(m, c.cde_count), 0);
  return TIER_ROWS.map((t) => ({
    key: t.key,
    label: t.label,
    cells: domains.value.map((dom) => {
      const cell = heatmap.value.find(
        (h) => h.tier === t.key && h.domain === dom,
      );
      const n = cell?.cde_count ?? 0;
      return {
        domain: dom,
        count: n,
        intensity: max > 0 ? n / max : 0,
      };
    }),
  }));
});

function goToCdes(params: Record<string, string | undefined>) {
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v) q[k] = v;
  if (lens.value !== 'all' && !('disease' in params)) q.disease = lens.value;
  router.push({ path: '/cdes', query: q });
}

function pctOfTotal(n: number) {
  return stats.value.total ? Math.round((n / stats.value.total) * 100) : 0;
}
</script>

<template>
  <div class="overview" v-loading="loading">
    <!-- Hero stats -->
    <section class="stat-grid">
      <div class="stat-card stat-card--lead">
        <div class="stat-card__value">{{ stats.total.toLocaleString() }}</div>
        <div class="stat-card__label">
          CDEs for {{ option(lens).label }}
          <span v-if="studyTypeFilter !== 'all'">{{ studyTypeFilter }}</span>
        </div>
        <div class="stat-card__meta muted">across {{ stats.bundles }} bundles</div>
      </div>
      <div
        class="stat-card stat-card--tier tier-core"
        @click="goToCdes({ disease: lens, tier: 'Core' })"
      >
        <div class="stat-card__value">{{ stats.core.toLocaleString() }}</div>
        <div class="stat-card__label">Core <span class="muted">({{ pctOfTotal(stats.core) }}%)</span></div>
        <div class="stat-card__meta">Must-have for this study type</div>
      </div>
      <div
        class="stat-card stat-card--tier tier-recommended"
        @click="goToCdes({ disease: lens, tier: 'Recommended' })"
      >
        <div class="stat-card__value">{{ stats.recommended.toLocaleString() }}</div>
        <div class="stat-card__label">Recommended <span class="muted">({{ pctOfTotal(stats.recommended) }}%)</span></div>
        <div class="stat-card__meta">Strongly encouraged</div>
      </div>
      <div
        class="stat-card stat-card--tier tier-supplemental"
        @click="goToCdes({ disease: lens, tier: 'Supplemental' })"
      >
        <div class="stat-card__value">{{ stats.supplemental.toLocaleString() }}</div>
        <div class="stat-card__label">Supplemental <span class="muted">({{ pctOfTotal(stats.supplemental) }}%)</span></div>
        <div class="stat-card__meta">Domain- or study-specific</div>
      </div>
    </section>

    <!-- Tier × Domain heatmap -->
    <section class="panel">
      <header class="panel__head">
        <h2>Coverage by tier × domain</h2>
        <p class="subtle">
          For {{ option(lens).longLabel }}: how the required, recommended, and
          supplemental CDEs distribute across clinical domains.
          Darker = more CDEs. Click a cell to drill into the filtered CDE list.
        </p>
      </header>
      <div class="heatmap">
        <div class="heatmap__row heatmap__row--head">
          <div class="heatmap__corner" />
          <div
            v-for="d in domains"
            :key="d"
            class="heatmap__col-head"
            :title="d"
          >
            {{ d }}
          </div>
        </div>
        <div
          v-for="row in heatmapMatrix"
          :key="row.key"
          class="heatmap__row"
        >
          <div class="heatmap__row-head" :class="`tier-label tier-label--${row.key.toLowerCase()}`">{{ row.label }}</div>
          <div
            v-for="cell in row.cells"
            :key="cell.domain"
            class="heatmap__cell"
            :class="{ 'is-empty': cell.count === 0 }"
            :style="{
              backgroundColor: cell.count === 0 ? undefined : `rgba(62, 120, 119, ${0.10 + 0.75 * cell.intensity})`,
              color: cell.intensity > 0.55 ? '#fff' : undefined,
            }"
            :title="`${row.label} · ${cell.domain}: ${cell.count} CDEs`"
            @click="cell.count && goToCdes({ tier: row.key, domain: cell.domain })"
          >
            {{ cell.count || '' }}
          </div>
        </div>
      </div>
    </section>

    <!-- Top bundles -->
    <section class="panel">
      <header class="panel__head">
        <h2>Start with these bundles</h2>
        <p class="subtle">
          Largest pre-assembled groupings of CDEs relevant to
          {{ option(lens).longLabel }}.
          Each bundle becomes a REDCap form.
        </p>
      </header>
      <div class="bundle-grid">
        <el-card
          v-for="b in topBundles"
          :key="b.id"
          class="bundle-card"
          shadow="hover"
          @click="router.push(`/bundles/${b.id}`)"
        >
          <div class="bundle-card__title">{{ b.bundle_name }}</div>
          <div class="bundle-card__meta">
            <el-tag type="info" size="small">{{ b.cde_count }} CDEs</el-tag>
            <span class="muted">{{ b.category }}</span>
          </div>
          <div class="bundle-card__domain subtle">{{ b.domain }}</div>
        </el-card>
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
}

.heatmap {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-x: auto;

  &__row {
    display: grid;
    grid-template-columns: 120px repeat(auto-fit, minmax(90px, 1fr));
    gap: 2px;
    align-items: stretch;

    &--head .heatmap__col-head {
      font-size: 11px;
      font-weight: 600;
      color: $gray_6;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      padding: 4px 8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 90px;
    }

  }

  &__corner,
  &__row-head {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    font-weight: 600;
    font-size: 13px;
  }

  &__row-head {
    background: $gray_1;
    border-radius: 2px;
    justify-content: flex-start;
    color: $gray_6;
    border-left: 3px solid transparent;

    &.tier-label--core {
      border-left-color: #2d6b3a;
    }
    &.tier-label--recommended {
      border-left-color: #1f528f;
    }
    &.tier-label--supplemental {
      border-left-color: #7a4a05;
    }
  }

  &__cell {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 42px;
    min-width: 90px;
    font-size: 13px;
    font-weight: 500;
    background: $gray_0;
    color: $gray_6;
    border-radius: 2px;
    cursor: pointer;
    transition: transform 60ms ease;

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

.bundle-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 0.75rem;
}

.bundle-card {
  cursor: pointer;
  transition: transform 80ms ease;

  &:hover {
    transform: translateY(-1px);
  }

  :deep(.el-card__body) {
    padding: 12px 14px;
  }

  &__title {
    font-weight: 600;
    font-size: 14px;
    color: $gray_6;
    margin-bottom: 6px;
    line-height: 1.3;
  }

  &__meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    margin-bottom: 4px;
  }

  &__domain {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
}
</style>
