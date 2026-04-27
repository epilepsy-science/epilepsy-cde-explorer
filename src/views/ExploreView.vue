<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDiseaseLens, DISEASE_OPTIONS, type DiseaseKey } from '@/composables/useDiseaseLens';
import { useStudyType, type StudyTypeFilter } from '@/composables/useStudyType';
import ExploreOverviewTab from '@/components/explore/ExploreOverviewTab.vue';
import ExploreTreeTab from '@/components/explore/ExploreTreeTab.vue';
import ExploreTreemapTab from '@/components/explore/ExploreTreemapTab.vue';

const { lens, option } = useDiseaseLens();
const { filter: studyTypeFilter } = useStudyType();
type ExploreTab = 'overview' | 'tree' | 'treemap';
const tab = ref<ExploreTab>('overview');

const route = useRoute();
const router = useRouter();

// ── URL ↔ filter sync ────────────────────────────────────────────────────────
// Deep-linkable params: ?focus=<DiseaseKey>&studyType=<all|Clinical|Preclinical>
// &tab=<overview|tree|treemap>. Mount-time read seeds the controls; subsequent
// changes push back to the URL via router.replace so the back button isn't
// flooded with intermediate states. Composable state is shared across views,
// so reading once on enter is sufficient.

const VALID_DISEASE_KEYS = new Set(DISEASE_OPTIONS.map((o) => o.key));
const VALID_STUDY_TYPES = new Set(['all', 'Clinical', 'Preclinical']);
const VALID_TABS: readonly ExploreTab[] = ['overview', 'tree', 'treemap'];

function readQueryString(name: string): string | null {
  const v = route.query[name];
  if (typeof v !== 'string') return null;
  return v;
}

onMounted(() => {
  const focus = readQueryString('focus');
  if (focus && VALID_DISEASE_KEYS.has(focus as DiseaseKey)) {
    lens.value = focus as DiseaseKey;
  }
  const st = readQueryString('studyType');
  if (st && VALID_STUDY_TYPES.has(st)) {
    studyTypeFilter.value = st as StudyTypeFilter;
  }
  const t = readQueryString('tab');
  if (t && VALID_TABS.includes(t as ExploreTab)) {
    tab.value = t as ExploreTab;
  }
});

watch([lens, studyTypeFilter, tab], ([newLens, newSt, newTab]) => {
  // Only carry params that differ from the defaults — keeps the URL clean
  // and matches what the user actually picked.
  const next: Record<string, string> = { ...(route.query as Record<string, string>) };
  if (newLens && newLens !== 'all') next.focus = newLens;
  else delete next.focus;
  if (newSt && newSt !== 'all') next.studyType = newSt;
  else delete next.studyType;
  if (newTab && newTab !== 'overview') next.tab = newTab;
  else delete next.tab;
  // Avoid redundant navigation when the URL already matches.
  const cur = route.query as Record<string, string>;
  const sameKeys =
    Object.keys(next).length === Object.keys(cur).length &&
    Object.keys(next).every((k) => cur[k] === next[k]);
  if (sameKeys) return;
  router.replace({ path: route.path, query: next });
});

function setLens(v: DiseaseKey) {
  lens.value = v;
}
function setStudyType(v: StudyTypeFilter) {
  studyTypeFilter.value = v;
}
</script>

<template>
  <div class="explore">
    <header class="explore__head page-header">
      <div class="explore__intro">
        <h1>Explore CDEs</h1>
        <p class="lede">
          Are you planning a new study in
          <strong>{{ option(lens).longLabel }}</strong>?
          Use these views to find the Common Data Elements recommended for this
          research focus, review their classification tiers, and assemble them
          into a Case Report Form. Switch the <strong>Research focus</strong>
          on the right to pivot every view to a different disease.
        </p>
      </div>
      <div class="explore__lens">
        <div class="lens-label subtle">Research focus</div>
        <el-radio-group
          :model-value="lens"
          @update:model-value="(v: string | number | boolean | undefined) => setLens(v as DiseaseKey)"
          size="default"
        >
          <el-radio-button
            v-for="o in DISEASE_OPTIONS"
            :key="o.key"
            :value="o.key"
          >
            {{ o.label }}
          </el-radio-button>
        </el-radio-group>
        <div class="lens-label subtle explore__lens-sub">Study type</div>
        <el-radio-group
          :model-value="studyTypeFilter"
          @update:model-value="(v: string | number | boolean | undefined) => setStudyType(v as StudyTypeFilter)"
          size="default"
        >
          <el-radio-button value="all">All</el-radio-button>
          <el-radio-button value="Clinical">Clinical</el-radio-button>
          <el-radio-button value="Preclinical">Preclinical</el-radio-button>
        </el-radio-group>
      </div>
    </header>

    <!-- View picker — three lenses on the same filtered CDE set. Classic
         underline-tab styling: single bolded label per tab, active tab gets
         a colored underline. Lighter chrome than the prior segmented control
         while still reading unambiguously as tabs. -->
    <nav class="view-tabs" role="tablist" aria-label="Explore views">
      <button
        class="view-tabs__tab"
        :class="{ 'view-tabs__tab--active': tab === 'overview' }"
        role="tab"
        :aria-selected="tab === 'overview'"
        @click="tab = 'overview'"
      >
        Overview
      </button>
      <button
        class="view-tabs__tab"
        :class="{ 'view-tabs__tab--active': tab === 'tree' }"
        role="tab"
        :aria-selected="tab === 'tree'"
        @click="tab = 'tree'"
      >
        Tree
      </button>
      <button
        class="view-tabs__tab"
        :class="{ 'view-tabs__tab--active': tab === 'treemap' }"
        role="tab"
        :aria-selected="tab === 'treemap'"
        @click="tab = 'treemap'"
      >
        Treemap
      </button>
    </nav>

    <div class="explore__tab-body">
      <ExploreOverviewTab v-if="tab === 'overview'" />
      <ExploreTreeTab v-else-if="tab === 'tree'" />
      <ExploreTreemapTab v-else-if="tab === 'treemap'" />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.explore {
  display: flex;
  flex-direction: column;
  gap: 1rem;

  &__head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 2rem;
    flex-wrap: wrap;
  }

  &__intro {
    flex: 1 1 400px;
  }

  &__lens {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-end;
  }

  &__lens-sub {
    margin-top: 6px;
  }

  .lens-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .lede {
    color: $gray_5;
    margin-top: 0.25rem;
    max-width: 680px;
  }

  &__tab-body {
    padding-top: 0.25rem;
  }
}

// Classic underline-tab strip. A horizontal rule under the row gives the
// inactive tabs a baseline; the active tab paints a thicker green stripe
// over its segment of that baseline. Single bold word per tab.
//
// Sizing intentionally generous: 16px text + 12px vertical padding so the
// strip reads as primary navigation, not meta-chrome. Inactive labels at
// $gray_5 (closer to body text) — the contrast between gray and green is
// what signals "tabs", not the strip itself.
.view-tabs {
  display: flex;
  gap: 2rem;
  border-bottom: 1px solid $lineColor2;
  margin-bottom: 0.5rem;

  &__tab {
    background: transparent;
    border: none;
    padding: 12px 4px;
    margin-bottom: -1px; // overlap the row's bottom border so active underline replaces it
    cursor: pointer;
    font-family: inherit;
    font-size: 16px;
    font-weight: 600;
    color: $gray_5;
    border-bottom: 3px solid transparent;
    transition: color 80ms ease, border-color 80ms ease;

    &:hover {
      color: $gray_6;
    }

    &--active {
      color: $es-primary-color;
      border-bottom-color: $es-primary-color;
    }
  }
}

</style>
