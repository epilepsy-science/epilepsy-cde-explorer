<script setup lang="ts">
import type { CdeRow } from '@/types';

defineProps<{ row: CdeRow }>();
</script>

<template>
  <div class="scope">
    <span
      class="scope__tag"
      :class="{ active: row.disease_agnostic === 'Y' }"
      title="Disease-agnostic"
    >AGN</span>
    <span
      class="scope__tag"
      :class="{ active: row.disease_neurotrauma === 'Y' }"
      title="Neurotrauma (general)"
    >NT</span>
    <span
      class="scope__tag"
      :class="{ active: row.disease_tbi === 'Y' }"
      title="Traumatic Brain Injury"
    >TBI</span>
    <span
      class="scope__tag"
      :class="{ active: row.disease_pte === 'Y' }"
      title="Post-Traumatic Epilepsy"
    >PTE</span>
    <span
      class="scope__tag"
      :class="{ active: row.disease_sci === 'Y' }"
      title="Spinal Cord Injury"
    >SCI</span>
  </div>
</template>

<style lang="scss" scoped>
.scope {
  display: flex;
  gap: 3px;

  &__tag {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 5px;
    border-radius: 3px;
    background: $gray_0;
    color: $gray_3;
    letter-spacing: 0.5px;

    &.active {
      background: $es-primary-color;
      color: $white;
    }
  }
}
</style>
