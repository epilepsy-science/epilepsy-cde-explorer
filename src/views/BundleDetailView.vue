<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDuckDB } from '@/composables/useDuckDB';
import CdeDetailDrawer from '@/components/CdeDetailDrawer.vue';
import ClassificationPill from '@/components/ClassificationPill.vue';
import DiseaseScopeCell from '@/components/DiseaseScopeCell.vue';
import AddToCrfButton from '@/components/AddToCrfButton.vue';
import { DISEASE_OPTIONS } from '@/composables/useDiseaseLens';
import type { BundleRow, CdeRow } from '@/types';

const route = useRoute();
const router = useRouter();
const { status, query } = useDuckDB();

const bundle = ref<BundleRow | null>(null);
const cdes = ref<CdeRow[]>([]);
const loading = ref(false);
const selectedCde = ref<CdeRow | null>(null);
const drawerOpen = ref(false);

const bundleId = computed(() => route.params.id as string);

async function load() {
  if (status.value !== 'ready' || !bundleId.value) return;
  loading.value = true;
  try {
    const [bRows, cdeRows] = await Promise.all([
      query<BundleRow>(`SELECT * FROM bundle_full WHERE id = ?`, [bundleId.value]),
      query<CdeRow>(
        `SELECT * FROM cde_full WHERE bundle_id = ? ORDER BY cde_name`,
        [bundleId.value],
      ),
    ]);
    bundle.value = bRows[0] ?? null;
    cdes.value = cdeRows;
  } finally {
    loading.value = false;
  }
}

watch([status, bundleId], () => {
  if (status.value === 'ready') load();
});
onMounted(() => {
  if (status.value === 'ready') load();
});

function openRow(row: CdeRow) {
  selectedCde.value = row;
  drawerOpen.value = true;
}

// Per-disease classification columns derived from DISEASE_OPTIONS so adding a
// disease automatically participates in the bundle's tier roll-up.
const CLASSIFICATION_COLS: Array<keyof CdeRow> = DISEASE_OPTIONS
  .filter((o) => o.column !== null)
  .map((o) => `classification_${o.key}` as keyof CdeRow);

const classificationSummary = computed(() => {
  const tiers = ['Core', 'Recommended', 'Supplemental', 'Not Applicable'];
  const counts: Record<string, number> = {};
  for (const t of tiers) counts[t] = 0;
  for (const c of cdes.value) {
    let best: string | null = null;
    for (const col of CLASSIFICATION_COLS) {
      const v = c[col] as string | null;
      if (v === 'Core') {
        best = 'Core';
        break;
      }
      if (v === 'Recommended' && best !== 'Core') best = 'Recommended';
      else if (v === 'Supplemental' && !best) best = 'Supplemental';
      else if (v === 'Not Applicable' && !best) best = 'Not Applicable';
    }
    if (best) counts[best] = (counts[best] ?? 0) + 1;
  }
  return counts;
});
</script>

<template>
  <div class="bundle-detail" v-loading="loading">
    <div class="bundle-detail__back">
      <el-button text @click="router.push('/cdes')">
        <el-icon><ArrowLeft /></el-icon>&nbsp;Back to CDEs
      </el-button>
    </div>

    <template v-if="bundle">
      <header class="bundle-detail__header">
        <div class="breadcrumb subtle">
          <span>{{ bundle.domain }}</span>
          <span class="sep">›</span>
          <span>{{ bundle.subdomain }}</span>
          <span class="sep">›</span>
          <span>{{ bundle.category }}</span>
        </div>
        <div class="bundle-detail__title-row">
          <h1>{{ bundle.bundle_name }}</h1>
          <AddToCrfButton kind="bundle" :target-ref="bundle.bundle_name" />
        </div>
        <div class="bundle-detail__meta">
          <el-tag size="small">{{ bundle.working_group }}</el-tag>
          <el-tag type="info" size="small">{{ bundle.cde_count }} CDEs</el-tag>
        </div>
      </header>

      <div class="bundle-detail__stats">
        <div class="stat" v-for="(count, tier) in classificationSummary" :key="tier">
          <div class="stat__value">{{ count }}</div>
          <div class="stat__label">
            <ClassificationPill :value="tier === 'Not Applicable' ? 'Not Applicable' : tier" />
          </div>
        </div>
      </div>

      <h2>CDEs in this bundle</h2>
      <el-table
        :data="cdes"
        size="small"
        stripe
        border
        highlight-current-row
        @row-click="openRow"
        class="cde-table"
      >
        <el-table-column prop="cde_name" label="Name" min-width="240">
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
        <el-table-column label="Classification (best)" width="180">
          <template #default="{ row }">
            <ClassificationPill
              :value="row.classification_tbi || row.classification_pte || row.classification_sci || row.classification_neurotrauma || row.classification_agnostic"
            />
          </template>
        </el-table-column>
        <el-table-column prop="unit_of_measure" label="Unit" width="100">
          <template #default="{ row }">
            <span v-if="row.unit_of_measure" class="mono">{{ row.unit_of_measure }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
      </el-table>

      <CdeDetailDrawer v-model="drawerOpen" :cde="selectedCde" />
    </template>

    <el-empty v-else-if="!loading" description="Bundle not found" />
  </div>
</template>

<style lang="scss" scoped>
.bundle-detail {
  display: flex;
  flex-direction: column;
  gap: 1rem;

  &__back {
    margin-bottom: -0.5rem;
  }

  &__header {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  &__title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;

    h1 {
      margin: 0;
    }
  }

  &__meta {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  &__stats {
    display: flex;
    gap: 1rem;
    padding: 1rem;
    background: $white;
    border: 1px solid $lineColor2;
    border-radius: 2px;
  }
}

.breadcrumb {
  font-size: 13px;

  .sep {
    margin: 0 6px;
    color: $gray_3;
  }
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
  padding-right: 1.5rem;
  border-right: 1px solid $lineColor2;

  &:last-child {
    border-right: none;
  }

  &__value {
    font-size: 22px;
    font-weight: 600;
    color: $gray_6;
  }

  &__label {
    font-size: 11px;
  }
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
</style>
