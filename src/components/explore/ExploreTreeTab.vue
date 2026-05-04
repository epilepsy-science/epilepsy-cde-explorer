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
    // One row per CDE — the tree builds N levels by splitting cde_path on
    // ` / `. Bundles sit as an interior node under the deepest path
    // segment; unbundled CDEs hang off the segment directly. Clicking a
    // CDE leaf opens the shared detail drawer.
    rows.value = await query<CdeRow>(`
      SELECT * FROM cde_full
      ${where}
      ORDER BY cde_path, bundle_name, cde_name
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

const PATH_SEP = ' / ';

// Path-segment tree. Each CDE row carries a ` / `-delimited cde_path
// (currently 0–3 segments derived from domain/subdomain/category, but the
// builder is depth-agnostic — sources that emit longer paths just produce
// more nesting). At the leaf segment of a path, bundles appear as named
// interior nodes containing their CDEs; unbundled CDEs sit alongside.
const tree = computed<TreeNode[]>(() => {
  type BundleBucket = { bundle_id: string; bundle_name: string; cdes: CdeRow[] };
  // Each path → its bundles + its unbundled CDEs.
  type Bucket = { bundles: Map<string, BundleBucket>; unbundled: CdeRow[] };
  const byPath = new Map<string, Bucket>();
  for (const r of rows.value) {
    const path = r.cde_path?.trim() || 'Unassigned';
    let bucket = byPath.get(path);
    if (!bucket) {
      bucket = { bundles: new Map(), unbundled: [] };
      byPath.set(path, bucket);
    }
    if (r.bundle_id && r.bundle_name) {
      let b = bucket.bundles.get(r.bundle_id);
      if (!b) {
        b = { bundle_id: r.bundle_id, bundle_name: r.bundle_name, cdes: [] };
        bucket.bundles.set(r.bundle_id, b);
      }
      b.cdes.push(r);
    } else {
      bucket.unbundled.push(r);
    }
  }

  // Mutable shape used while building, before we roll up counts.
  type BuildNode = {
    id: string;
    label: string;
    count: number;
    children: BuildNode[];
    bundleId?: string;
    cde?: CdeRow;
  };

  const cdeLeaf = (r: CdeRow): BuildNode => ({
    id: `cde-${r.cde_id}`,
    label: r.cde_name,
    count: 1,
    children: [],
    cde: r,
  });
  const root: BuildNode = { id: '__root', label: '', count: 0, children: [] };

  const findOrCreateChild = (parent: BuildNode, label: string, idPrefix: string): BuildNode => {
    let child = parent.children.find((c) => c.label === label && !c.cde && !c.bundleId);
    if (!child) {
      child = {
        id: `${idPrefix}-${label}`,
        label,
        count: 0,
        children: [],
      };
      parent.children.push(child);
    }
    return child;
  };

  for (const [path, bucket] of byPath) {
    const segments = path.split(PATH_SEP).map((s) => s.trim()).filter(Boolean);
    let cursor = root;
    let acc = '';
    for (const seg of segments) {
      acc = acc ? `${acc}${PATH_SEP}${seg}` : seg;
      cursor = findOrCreateChild(cursor, seg, `seg-${acc}`);
    }
    // We're at the leaf segment node for this path. Drop bundles + CDEs.
    for (const b of bucket.bundles.values()) {
      cursor.children.push({
        id: `b-${b.bundle_id}`,
        label: b.bundle_name,
        count: b.cdes.length,
        bundleId: b.bundle_id,
        children: b.cdes.map(cdeLeaf),
      });
    }
    for (const r of bucket.unbundled) {
      cursor.children.push(cdeLeaf(r));
    }
  }

  // Roll up counts from leaves to roots.
  const rollup = (n: BuildNode): number => {
    if (n.cde) return 1;
    let total = 0;
    for (const c of n.children) total += rollup(c);
    n.count = total;
    return total;
  };
  for (const n of root.children) rollup(n);

  // Top-level sort: biggest segment first. Children stay in insertion order
  // (alphabetical within a path because rows are SQL-sorted by cde_path).
  return root.children
    .slice()
    .sort((a, b) => b.count - a.count) as TreeNode[];
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
      Drill through the organizational hierarchy for
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
