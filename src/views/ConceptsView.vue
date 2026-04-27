<script setup lang="ts">
// Concepts list view. Surfaces the derived concept registry built at
// data-prep time. Each row is one (source, identifier) pair, with how
// many CDEs currently point at it. Phase 4 enrichment will fill in
// preferred_label / definition / cross-walks; until then we show
// "<source>:<identifier>" as the label.

import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useDuckDB } from '@/composables/useDuckDB';
import { useConcepts, conceptLabel, type ConceptListRow } from '@/composables/useConcepts';

const router = useRouter();
const { status } = useDuckDB();
const { listConcepts } = useConcepts();

const all = ref<ConceptListRow[]>([]);
const loading = ref(false);
const search = ref('');
const sourceFilter = ref<string>('all');

async function load() {
  if (status.value !== 'ready') return;
  loading.value = true;
  try {
    all.value = await listConcepts();
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(status, load);

const sources = computed(() => {
  const set = new Set<string>();
  for (const c of all.value) set.add(c.source);
  return [...set].sort();
});

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return all.value.filter((c) => {
    if (sourceFilter.value !== 'all' && c.source !== sourceFilter.value) return false;
    if (!q) return true;
    if (c.identifier.toLowerCase().includes(q)) return true;
    if (c.preferred_label?.toLowerCase().includes(q)) return true;
    if (c.cui?.toLowerCase().includes(q)) return true;
    return false;
  });
});

function go(c: ConceptListRow) {
  router.push(`/concepts/${c.id}`);
}
</script>

<template>
  <div class="concepts-view">
    <header class="concepts-view__head page-header">
      <div>
        <h1>Concepts</h1>
        <p class="lede">
          The semantic anchors behind the data elements — concepts like
          <em>Age</em> or <em>Systolic Blood Pressure</em>. Each concept can
          be implemented by one or more CDEs across the library. Mappings
          come from the source vocabularies that ship with each CDE
          (caDSR, LOINC, SNOMED CT, …); cross-vocabulary linking via
          UMLS CUIs lands in a later release.
        </p>
      </div>
    </header>

    <div class="concepts-view__filters">
      <el-input
        v-model="search"
        placeholder="Search by label, identifier, or CUI…"
        clearable
        class="search-input"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-select v-model="sourceFilter" placeholder="Source" class="filter-select">
        <el-option label="All sources" value="all" />
        <el-option
          v-for="s in sources"
          :key="s"
          :label="s"
          :value="s"
        />
      </el-select>
    </div>

    <div v-if="loading" class="concepts-view__loading subtle">Loading concepts…</div>
    <div
      v-else-if="all.length === 0"
      class="concepts-view__empty subtle"
    >
      No concepts in the registry yet. Concepts are derived from CDE
      records that ship a <code>dec_identifier</code>; if no source carries
      one, this list stays empty.
    </div>
    <div v-else-if="filtered.length === 0" class="concepts-view__empty subtle">
      No concepts match.
    </div>

    <div v-else class="concept-grid">
      <article
        v-for="c in filtered"
        :key="c.id"
        class="concept-card"
        @click="go(c)"
      >
        <header class="concept-card__head">
          <span class="concept-card__source">{{ c.source }}</span>
          <span v-if="c.cui" class="concept-card__cui mono">{{ c.cui }}</span>
        </header>
        <h3 class="concept-card__title">{{ conceptLabel(c) }}</h3>
        <p v-if="c.definition" class="concept-card__def">
          {{ c.definition }}
        </p>
        <footer class="concept-card__meta">
          <span class="mono muted">{{ c.identifier }}</span>
          <span class="concept-card__count">
            {{ c.cde_count }} CDE{{ c.cde_count === 1 ? '' : 's' }}
          </span>
        </footer>
      </article>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.concepts-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;

  &__head h1 {
    margin-bottom: 0.25rem;
  }

  &__filters {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .search-input {
    flex: 1 1 320px;
    max-width: 520px;
  }

  .filter-select {
    width: 200px;
    flex: 0 0 auto;
  }

  &__loading,
  &__empty {
    padding: 2rem;
    text-align: center;
  }

  &__empty code {
    background: $gray_1;
    padding: 1px 6px;
    border-radius: 2px;
    font-size: 90%;
  }
}

.concept-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}

.concept-card {
  background: $white;
  border: 1px solid $lineColor2;
  border-left: 3px solid $purple_3;
  border-radius: 2px;
  padding: 14px 16px 12px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: transform 80ms ease, box-shadow 80ms ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
  }

  &__head {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: space-between;
  }

  &__source {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: $purple_3;
    font-weight: 700;
  }

  &__cui {
    font-size: 11px;
    color: $gray_5;
    background: $gray_1;
    padding: 1px 6px;
    border-radius: 2px;
  }

  &__title {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
    color: $gray_6;
    line-height: 1.3;
  }

  &__def {
    margin: 0;
    font-size: 12px;
    color: $gray_5;
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  &__meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: auto;
    padding-top: 4px;
    font-size: 12px;
  }

  &__count {
    color: $gray_5;
  }
}
</style>
