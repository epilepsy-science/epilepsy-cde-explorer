<script setup lang="ts">
// Reads only the disease_* flags which exist with identical shape on both
// CdeRow (per-context) and CdeCanonicalRow (aggregated). Take a minimal
// pick-type so the cell works for either shape without coupling to either
// concrete row type.
interface DiseaseScopeRow {
  disease_agnostic: 'Y' | 'N' | null;
  disease_neurotrauma: 'Y' | 'N' | null;
  disease_tbi: 'Y' | 'N' | null;
  disease_pte: 'Y' | 'N' | null;
  disease_sci: 'Y' | 'N' | null;
}

defineProps<{ row: DiseaseScopeRow }>();
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
