<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useCrfStore } from '@/composables/useCrfStore';
import { useStudyType } from '@/composables/useStudyType';
import type { CrfRecord } from '@/types';

const router = useRouter();
const { crfs, ensureLoaded, loaded } = useCrfStore();
const { filter: studyTypeFilter } = useStudyType();
const search = ref('');
const filter = ref<'all' | 'seeded' | 'custom'>('all');

onMounted(async () => {
  await ensureLoaded();
});

interface CrfSummary {
  sections: number;
  cdes: number;
  bundles: number;
}

function summarize(c: CrfRecord): CrfSummary {
  const s: CrfSummary = { sections: 0, cdes: 0, bundles: 0 };
  for (const it of c.items) {
    if (it.type === 'section') s.sections++;
    else if (it.type === 'cde') s.cdes++;
    else if (it.type === 'bundle') s.bundles++;
  }
  return s;
}

const PREVIEW_LIMIT = 3;
function previewItems(c: CrfRecord): string[] {
  const out: string[] = [];
  for (const it of c.items) {
    if (it.type === 'section') continue;
    const label = it.ref ?? it.label;
    if (label) out.push(label);
    if (out.length >= PREVIEW_LIMIT) break;
  }
  return out;
}
function totalFields(c: CrfRecord): number {
  return c.items.filter((it) => it.type !== 'section').length;
}

const filtered = computed<CrfRecord[]>(() => {
  const q = search.value.trim().toLowerCase();
  const st = studyTypeFilter.value;
  return crfs.value.filter((c) => {
    if (filter.value !== 'all' && c.source !== filter.value) return false;
    // Custom CRFs (user-authored, study_type null) always show — they're in
    // the reviewer's personal workspace regardless of clinical/preclinical.
    if (st !== 'all' && c.source === 'seeded' && c.study_type !== st) return false;
    if (!q) return true;
    return (
      c.title.toLowerCase().includes(q) ||
      c.crf_name.toLowerCase().includes(q) ||
      (c.description ?? '').toLowerCase().includes(q)
    );
  });
});

const counts = computed(() => ({
  all: crfs.value.length,
  seeded: crfs.value.filter((c) => c.source === 'seeded').length,
  custom: crfs.value.filter((c) => c.source === 'custom').length,
}));
</script>

<template>
  <div class="crfs-view">
    <header class="crfs-view__head page-header">
      <div>
        <h1>Case Report Forms</h1>
        <p class="lede">
          Data-collection forms that group CDEs for a specific study event —
          intake, follow-up, outcome. Pick a ready-made CRF to adopt, or
          assemble your own from the CDE library.
        </p>
      </div>
    </header>

    <div class="crfs-view__filters">
      <el-input
        v-model="search"
        placeholder="Search title, name, or description…"
        clearable
        class="search-input"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-radio-group v-model="filter" size="default">
        <el-radio-button value="all">All ({{ counts.all }})</el-radio-button>
        <el-radio-button value="seeded">Validated ({{ counts.seeded }})</el-radio-button>
        <el-radio-button value="custom">Custom ({{ counts.custom }})</el-radio-button>
      </el-radio-group>
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

    <div v-if="!loaded" class="crfs-view__loading">Loading CRFs…</div>
    <div v-else-if="filtered.length === 0" class="crfs-view__empty subtle">
      No CRFs match.
    </div>

    <div v-else class="crf-grid">
      <article
        v-for="c in filtered"
        :key="c.id"
        class="crf-card"
        @click="router.push(`/crfs/${c.id}`)"
      >
        <header class="crf-card__head">
          <span
            class="crf-card__source"
            :class="c.source === 'seeded' ? 'crf-card__source--seeded' : 'crf-card__source--custom'"
          >
            {{ c.source === 'seeded' ? 'Validated' : 'Custom' }}
          </span>
          <span v-if="c.disease_scope" class="crf-card__scope">{{ c.disease_scope }}</span>
        </header>
        <h3 class="crf-card__title">{{ c.title }}</h3>
        <p v-if="c.description" class="crf-card__desc">{{ c.description }}</p>
        <ul v-if="previewItems(c).length" class="crf-card__preview">
          <li v-for="(p, i) in previewItems(c)" :key="i">
            <span class="crf-card__preview-num">{{ i + 1 }}.</span>
            {{ p }}
          </li>
          <li v-if="totalFields(c) > previewItems(c).length" class="crf-card__preview-more">
            + {{ totalFields(c) - previewItems(c).length }} more
          </li>
        </ul>
        <footer class="crf-card__meta">
          <span
            v-for="(n, k) in summarize(c)"
            :key="k"
            v-show="n > 0"
            class="crf-card__stat"
          >
            {{ n }} {{ k }}
          </span>
          <span v-if="c.estimated_duration_minutes" class="crf-card__stat muted">
            · ~{{ c.estimated_duration_minutes }} min
          </span>
        </footer>
        <div v-if="c.collection_frequency" class="crf-card__freq subtle">
          {{ c.collection_frequency }}
        </div>
      </article>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.crfs-view {
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
    width: 180px;
    flex: 0 0 auto;
  }

  &__loading,
  &__empty {
    padding: 2rem;
    text-align: center;
  }
}

.crf-grid {
  display: grid;
  // Two wider, form-shaped cards side-by-side on desktop; collapses to one
  // column under ~1200px so cards don't get too narrow.
  grid-template-columns: repeat(auto-fill, minmax(520px, 1fr));
  gap: 14px;
}

.crf-card {
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 2px;
  padding: 14px 16px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: transform 80ms ease, box-shadow 80ms ease, border-color 80ms ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
    border-color: $es-primary-color;
  }

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  &__source {
    display: inline-block;
    padding: 1px 7px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    border-radius: 2px;

    &--seeded {
      background: #eaf1fa;
      color: #1f528f;
      border-left: 2px solid #1f528f;
    }
    &--custom {
      background: #fdf3df;
      color: #7a4a05;
      border-left: 2px solid #c08b00;
    }
  }

  &__scope {
    font-size: 11px;
    color: $gray_4;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }

  &__title {
    font-size: 15px;
    font-weight: 600;
    color: $gray_6;
    margin: 0;
    line-height: 1.3;
  }

  &__desc {
    font-size: 12px;
    color: $gray_5;
    margin: 0;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  &__preview {
    margin: 2px 0 0;
    padding: 8px 12px;
    list-style: none;
    background: $gray_0;
    border-left: 2px solid $lineColor2;
    font-size: 12px;
    color: $gray_6;
    display: flex;
    flex-direction: column;
    gap: 3px;

    li {
      display: flex;
      gap: 6px;
      align-items: baseline;
      line-height: 1.35;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  &__preview-num {
    color: $neutralGrey;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  &__preview-more {
    color: $neutralGrey;
    font-style: italic;
    padding-left: 18px;
  }

  &__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 11px;
    color: $gray_5;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  &__stat {
    font-weight: 600;

    &.muted {
      font-weight: 400;
    }
  }

  &__freq {
    font-size: 11px;
    margin-top: auto;
  }
}
</style>
