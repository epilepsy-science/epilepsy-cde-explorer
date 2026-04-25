<script setup lang="ts">
import { ref } from 'vue';
import { useDiseaseLens, DISEASE_OPTIONS, type DiseaseKey } from '@/composables/useDiseaseLens';
import { useStudyType, type StudyTypeFilter } from '@/composables/useStudyType';
import ExploreOverviewTab from '@/components/explore/ExploreOverviewTab.vue';
import ExploreTreeTab from '@/components/explore/ExploreTreeTab.vue';
import ExploreTreemapTab from '@/components/explore/ExploreTreemapTab.vue';

const { lens, option } = useDiseaseLens();
const { filter: studyTypeFilter } = useStudyType();
const tab = ref<'overview' | 'tree' | 'treemap'>('overview');

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
          @update:model-value="(v) => setLens(v as DiseaseKey)"
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
          @update:model-value="(v) => setStudyType(v as StudyTypeFilter)"
          size="default"
        >
          <el-radio-button value="all">All</el-radio-button>
          <el-radio-button value="Clinical">Clinical</el-radio-button>
          <el-radio-button value="Preclinical">Preclinical</el-radio-button>
        </el-radio-group>
      </div>
    </header>

    <el-tabs v-model="tab" type="card" class="explore__tabs">
      <el-tab-pane label="Overview" name="overview">
        <ExploreOverviewTab v-if="tab === 'overview'" />
      </el-tab-pane>
      <el-tab-pane label="Tree" name="tree">
        <ExploreTreeTab v-if="tab === 'tree'" />
      </el-tab-pane>
      <el-tab-pane label="Bundle treemap" name="treemap">
        <ExploreTreemapTab v-if="tab === 'treemap'" />
      </el-tab-pane>
    </el-tabs>
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

  &__tabs {
    :deep(.el-tabs__content) {
      padding-top: 0.5rem;
    }
  }
}
</style>
