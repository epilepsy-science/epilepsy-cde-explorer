<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue';
import { useDuckDB } from '@/composables/useDuckDB';
import { useDiseaseLens } from '@/composables/useDiseaseLens';
import { useStudyType } from '@/composables/useStudyType';
import CdeDetailDrawer from '@/components/CdeDetailDrawer.vue';
import type { CdeRow } from '@/types';

const { status, query } = useDuckDB();
const { lens, option, clause } = useDiseaseLens();
const { filter: studyTypeFilter, clause: studyTypeClause } = useStudyType();

const rows = ref<CdeRow[]>([]);
const loading = ref(false);

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
    // One row per CDE — the tree groups by (domain, subdomain, category) in
    // JS. If the CDE belongs to a bundle, we show the bundle as an interior
    // node inside the category; CDEs not in any bundle hang off the category
    // directly. Clicking a CDE leaf opens the shared detail drawer.
    rows.value = await query<CdeRow>(`
      SELECT * FROM cde_full
      ${where}
      ORDER BY cde_domain, cde_subdomain, cde_category, bundle_name, cde_name
    `);
  } finally {
    loading.value = false;
  }
}

watch([status, lens, studyTypeFilter], load);
onMounted(load);

const selectedCde = ref<CdeRow | null>(null);
const cdeDrawerOpen = ref(false);

interface TreeNode {
  id: string;
  label: string;
  count: number;
  children?: TreeNode[];
  bundleId?: string;
  cde?: CdeRow;
}

const tree = computed<TreeNode[]>(() => {
  // domain → subdomain → category → (bundle | direct CDE) → CDE
  type BundleBucket = { bundle_id: string; bundle_name: string; cdes: CdeRow[] };
  type CategoryBucket = { bundles: Map<string, BundleBucket>; unbundled: CdeRow[] };
  const byDomain = new Map<string, Map<string, Map<string, CategoryBucket>>>();
  for (const r of rows.value) {
    const d = r.cde_domain || 'Unassigned';
    const sd = r.cde_subdomain || '—';
    const c = r.cde_category || '—';
    if (!byDomain.has(d)) byDomain.set(d, new Map());
    const dm = byDomain.get(d)!;
    if (!dm.has(sd)) dm.set(sd, new Map());
    const sm = dm.get(sd)!;
    if (!sm.has(c)) sm.set(c, { bundles: new Map(), unbundled: [] });
    const bucket = sm.get(c)!;
    if (r.bundle_id && r.bundle_name) {
      if (!bucket.bundles.has(r.bundle_id)) {
        bucket.bundles.set(r.bundle_id, {
          bundle_id: r.bundle_id,
          bundle_name: r.bundle_name,
          cdes: [],
        });
      }
      bucket.bundles.get(r.bundle_id)!.cdes.push(r);
    } else {
      bucket.unbundled.push(r);
    }
  }
  const cdeLeaf = (r: CdeRow): TreeNode => ({
    id: `cde-${r.cde_id}`,
    label: r.cde_name,
    count: 1,
    cde: r,
  });
  const nodes: TreeNode[] = [];
  for (const [d, dm] of byDomain) {
    const dChildren: TreeNode[] = [];
    let dTotal = 0;
    for (const [sd, sm] of dm) {
      const sChildren: TreeNode[] = [];
      let sTotal = 0;
      for (const [c, bucket] of sm) {
        const cChildren: TreeNode[] = [];
        let cTotal = 0;
        for (const b of bucket.bundles.values()) {
          cChildren.push({
            id: `b-${b.bundle_id}`,
            label: b.bundle_name,
            count: b.cdes.length,
            bundleId: b.bundle_id,
            children: b.cdes.map(cdeLeaf),
          });
          cTotal += b.cdes.length;
        }
        for (const r of bucket.unbundled) {
          cChildren.push(cdeLeaf(r));
          cTotal += 1;
        }
        sTotal += cTotal;
        sChildren.push({
          id: `c-${d}-${sd}-${c}`,
          label: c,
          count: cTotal,
          children: cChildren,
        });
      }
      dTotal += sTotal;
      dChildren.push({
        id: `sd-${d}-${sd}`,
        label: sd,
        count: sTotal,
        children: sChildren,
      });
    }
    nodes.push({
      id: `d-${d}`,
      label: d,
      count: dTotal,
      children: dChildren,
    });
  }
  return nodes.sort((a, b) => b.count - a.count);
});

function handleNodeClick(node: TreeNode) {
  if (node.cde) {
    selectedCde.value = node.cde;
    cdeDrawerOpen.value = true;
  }
  // Bundle and category/subdomain/domain nodes just expand — no navigation.
}

const defaultExpanded = computed(() => tree.value.slice(0, 2).map((n) => n.id));
</script>

<template>
  <div class="tree-tab" v-loading="loading">
    <p class="subtle">
      Drill through the NT-PRECEDS organizational hierarchy for
      <strong>{{ option(lens).longLabel }}</strong>.
      Click a bundle to see the CDEs inside it.
    </p>

    <el-tree
      :data="tree"
      node-key="id"
      :default-expanded-keys="defaultExpanded"
      :expand-on-click-node="true"
      @node-click="handleNodeClick"
      class="tree"
    >
      <template #default="{ node, data }">
        <div class="tree-node" :class="{ 'is-leaf': data.cde || data.bundleId }">
          <span class="tree-node__label">{{ node.label }}</span>
          <span v-if="data.cde" class="tree-node__count">
            {{ (data.cde as CdeRow).cde_data_type }}
          </span>
          <span v-else class="tree-node__count">{{ data.count }} CDEs</span>
        </div>
      </template>
    </el-tree>

    <CdeDetailDrawer v-model="cdeDrawerOpen" :cde="selectedCde" />
  </div>
</template>

<style lang="scss" scoped>
.tree-tab {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.tree {
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 2px;
  padding: 0.5rem;

  :deep(.el-tree-node__content) {
    height: 32px;
  }
}

.tree-node {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding-right: 1rem;

  &__label {
    font-weight: 500;
    color: $gray_6;
  }

  &__count {
    font-size: 11px;
    color: $neutralGrey;
    background: $gray_0;
    padding: 1px 8px;
    border-radius: 2px;
  }

  &.is-leaf {
    .tree-node__label {
      color: $es-primary-color;
    }
  }
}
</style>
