<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useCrfStore } from '@/composables/useCrfStore';
import { useStudyType } from '@/composables/useStudyType';
import { CRF_BADGE_DESCRIPTIONS, crfBadge, type CrfRecord } from '@/types';

// Status legend rows shown in the help popover next to the Source filter.
// Order matches NLM's tier hierarchy (most → least vetted) with Custom and
// External appended since they're our own dimensions.
const STATUS_LEGEND: Array<{ kind: 'standard' | 'qualified' | 'recorded' | 'candidate' | 'retired' | 'custom' | 'external'; label: string }> = [
  { kind: 'standard', label: 'Standard' },
  { kind: 'qualified', label: 'Qualified' },
  { kind: 'recorded', label: 'Recorded' },
  { kind: 'candidate', label: 'Candidate' },
  { kind: 'retired', label: 'Retired' },
  { kind: 'custom', label: 'Custom' },
  { kind: 'external', label: 'External' },
];
import CrfCreateDialog from '@/components/CrfCreateDialog.vue';

const router = useRouter();
const { crfs, ensureLoaded, loaded } = useCrfStore();
const { filter: studyTypeFilter } = useStudyType();
const search = ref('');
// Source filter values: 'all', 'custom', or a CRF status label that exists in
// the loaded data ('Standard', 'Qualified', etc.). Built dynamically from
// what's actually present so we don't list empty buckets.
const filter = ref<string>('all');
// Form-type filter: most external-only CRFs are NINDS NOC stubs (no items,
// just a redirect to a copyrighted instrument). Default to "items" so the
// list shows actual collectable forms; users can flip to "external" or
// "all" to surface the stubs explicitly.
const formType = ref<'items' | 'external' | 'all'>('items');
const createDialogOpen = ref(false);

// Match the CDEs page's setStudyType signature so the dropdown wiring
// matches the rest of the app.
function isExternalOnly(c: CrfRecord): boolean {
  return c.source === 'seeded' && c.items.length === 0;
}

function onCrfCreated(id: string) {
  router.push(`/crfs/${id}`);
}

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

function matchesSourceFilter(c: CrfRecord): boolean {
  const f = filter.value;
  if (f === 'all') return true;
  if (f === 'custom') return c.source === 'custom';
  // Any other value is a status label (Standard, Qualified, …).
  return c.source === 'seeded' && crfBadge(c).label === f;
}

const filtered = computed<CrfRecord[]>(() => {
  const q = search.value.trim().toLowerCase();
  const st = studyTypeFilter.value;
  return crfs.value.filter((c) => {
    if (!matchesSourceFilter(c)) return false;
    if (formType.value === 'items' && isExternalOnly(c)) return false;
    if (formType.value === 'external' && !isExternalOnly(c)) return false;
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

// Per-status counts for seeded CRFs, keyed by the badge label so the
// dropdown options stay in sync with what crfBadge() actually emits. Order
// follows STATUS_LEGEND so the dropdown reads top-tier → bottom-tier.
const seededStatusCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const c of crfs.value) {
    if (c.source !== 'seeded') continue;
    const label = crfBadge(c).label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  // Preserve legend order, dropping empty buckets.
  const ordered: Array<{ label: string; count: number }> = [];
  for (const row of STATUS_LEGEND) {
    if (row.kind === 'custom' || row.kind === 'external') continue;
    const n = counts.get(row.label);
    if (n) ordered.push({ label: row.label, count: n });
  }
  return ordered;
});

const counts = computed(() => ({
  all: crfs.value.length,
  custom: crfs.value.filter((c) => c.source === 'custom').length,
  externalOnly: crfs.value.filter((c) => isExternalOnly(c)).length,
}));
</script>

<template>
  <div class="crfs-view">
    <header class="crfs-view__head page-header">
      <div class="crfs-view__intro">
        <h1>Case Report Forms</h1>
        <p class="lede">
          Data-collection forms that group CDEs for a specific study event —
          intake, follow-up, outcome. Pick a ready-made CRF to adopt, or
          assemble your own from the CDE library.
        </p>
      </div>
      <div class="crfs-view__scope">
        <el-button type="primary" @click="createDialogOpen = true">
          <el-icon style="margin-right: 4px"><Plus /></el-icon>
          New CRF
        </el-button>
      </div>
    </header>

    <CrfCreateDialog v-model="createDialogOpen" @created="onCrfCreated" />

    <div class="crfs-view__filters">
      <el-input
        v-model="search"
        placeholder="Search title, name, or description…"
        clearable
        class="search-input"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <div class="filter-with-help">
        <el-select v-model="filter" placeholder="Source" class="filter-select">
          <el-option label="All sources" value="all" />
          <el-option
            v-for="s in seededStatusCounts"
            :key="s.label"
            :label="`${s.label} (${s.count})`"
            :value="s.label"
          />
          <el-option
            v-if="counts.custom > 0"
            :label="`Custom (${counts.custom})`"
            value="custom"
          />
        </el-select>
        <el-popover placement="bottom-start" :width="360" trigger="click">
          <template #reference>
            <el-button
              circle
              text
              size="small"
              class="filter-help-btn"
              title="What do these statuses mean?"
            >
              <el-icon><QuestionFilled /></el-icon>
            </el-button>
          </template>
          <div class="status-legend">
            <h4 class="status-legend__title">CRF status</h4>
            <p class="status-legend__lede">
              NLM tags every form with a lifecycle tier. Forms from other
              sources (NINDS, etc.) without an explicit tier default to
              "Qualified" — "Standard" stays reserved for NLM's explicit
              top-tier marker.
            </p>
            <div
              v-for="row in STATUS_LEGEND"
              :key="row.kind"
              class="status-legend__row"
            >
              <span
                class="status-legend__chip"
                :class="`status-legend__chip--${row.kind}`"
              >
                {{ row.label }}
              </span>
              <span class="status-legend__desc">
                {{ CRF_BADGE_DESCRIPTIONS[row.kind] }}
              </span>
            </div>
          </div>
        </el-popover>
      </div>
      <el-select v-model="formType" placeholder="Form type" class="filter-select">
        <el-option label="With items only" value="items" />
        <el-option :label="`External instruments (${counts.externalOnly})`" value="external" />
        <el-option label="All forms" value="all" />
      </el-select>
      <el-select v-model="studyTypeFilter" placeholder="Study type" class="filter-select">
        <el-option label="All" value="all" />
        <el-option label="Clinical" value="Clinical" />
        <el-option label="Preclinical" value="Preclinical" />
      </el-select>
    </div>

    <div v-if="!loaded" class="crfs-view__loading">Loading CRFs…</div>
    <div
      v-else-if="filtered.length === 0 && filter === 'custom' && counts.custom === 0"
      class="crfs-view__empty crfs-view__empty--cta"
    >
      <h3>No custom CRFs yet</h3>
      <p class="subtle">
        Group CDEs into your own data-collection form. You can also add
        items directly from a CDE or bundle's "Add to CRF" menu while browsing.
      </p>
      <el-button type="primary" @click="createDialogOpen = true">
        <el-icon style="margin-right: 4px"><Plus /></el-icon>
        Create your first CRF
      </el-button>
    </div>
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
          <div class="crf-card__head-tags">
            <span
              class="crf-card__source"
              :class="`crf-card__source--${crfBadge(c).kind}`"
            >
              {{ crfBadge(c).label }}
            </span>
            <span
              v-if="isExternalOnly(c)"
              class="crf-card__source crf-card__source--external"
            >
              External
            </span>
          </div>
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

  &__head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 2rem;
    flex-wrap: wrap;

    h1 {
      margin-bottom: 0.25rem;
    }
  }

  &__intro {
    flex: 1 1 400px;
  }

  &__scope {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-end;
  }

  .lens-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
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

  // Bigger, friendlier empty state with a primary CTA — only shown on the
  // Custom filter when the user has no custom CRFs yet.
  &__empty--cta {
    padding: 3rem 1.5rem;
    background: $white;
    border: 1px dashed $lineColor2;
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;

    h3 {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
      color: $gray_6;
    }

    p {
      max-width: 420px;
      margin: 0 0 6px;
      font-size: 13px;
      line-height: 1.5;
    }
  }
}

// Source filter sits next to a small (?) help button that opens the legend
// popover. Flex keeps them aligned and gap matches the other filter spacing.
.filter-with-help {
  display: flex;
  align-items: center;
  gap: 4px;
}
.filter-help-btn {
  color: $gray_4;

  &:hover {
    color: $es-primary-color;
  }
}

// Popover legend — same chip palette as cards, paired with the plain-English
// status descriptions so reviewers can learn the vocabulary in one place.
.status-legend {
  display: flex;
  flex-direction: column;
  gap: 8px;

  &__title {
    margin: 0;
    font-size: 14px;
    font-weight: 700;
    color: $gray_6;
  }

  &__lede {
    margin: 0;
    font-size: 12px;
    color: $gray_5;
    line-height: 1.5;
  }

  &__row {
    display: grid;
    grid-template-columns: 92px 1fr;
    align-items: start;
    gap: 10px;
    font-size: 12px;
    line-height: 1.45;
  }

  &__chip {
    display: inline-block;
    padding: 1px 7px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    border-radius: 2px;

    &--standard,
    &--qualified {
      background: #e6f4ea;
      color: #1f7a3a;
      border-left: 2px solid #2d6b3a;
    }
    &--recorded {
      background: #eaf1fa;
      color: #1f528f;
      border-left: 2px solid #1f528f;
    }
    &--candidate {
      background: #fff7ec;
      color: #b45309;
      border-left: 2px solid #b45309;
    }
    &--retired {
      background: #fdecec;
      color: #a02828;
      border-left: 2px solid #a02828;
    }
    &--custom {
      background: #fdf3df;
      color: #7a4a05;
      border-left: 2px solid #c08b00;
    }
    &--external {
      background: #f4ecff;
      color: #5b21b6;
      border-left: 2px solid #7c3aed;
    }
  }

  &__desc {
    color: $gray_6;
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

    // Standard / Qualified — recognized authoritative tiers (NLM "Standard"
    // and "Qualified" are the green-light states).
    &--standard,
    &--qualified {
      background: #e6f4ea;
      color: #1f7a3a;
      border-left: 2px solid #2d6b3a;
    }
    // Recorded — accepted but provisional.
    &--recorded {
      background: #eaf1fa;
      color: #1f528f;
      border-left: 2px solid #1f528f;
    }
    // Candidate — proposed, not yet accepted.
    &--candidate {
      background: #fff7ec;
      color: #b45309;
      border-left: 2px solid #b45309;
    }
    // Retired — deprecated; show in muted red.
    &--retired {
      background: #fdecec;
      color: #a02828;
      border-left: 2px solid #a02828;
    }
    &--custom {
      background: #fdf3df;
      color: #7a4a05;
      border-left: 2px solid #c08b00;
    }
    &--external {
      background: #f4ecff;
      color: #5b21b6;
      border-left: 2px solid #7c3aed;
    }
  }

  &__head-tags {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
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
