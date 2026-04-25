<script setup lang="ts">
import { computed } from 'vue';
import { classificationPillClass, isActiveTier } from '@/types';

const props = withDefaults(
  defineProps<{
    value: string | null;
    prefix?: string;
    /** When true, render a muted "—" placeholder instead of nothing for null/N-A. */
    showPlaceholder?: boolean;
  }>(),
  { showPlaceholder: false },
);

const active = computed(() => isActiveTier(props.value));
const cls = computed(() => classificationPillClass(props.value));
const label = computed(() => {
  if (!props.value || !active.value) return '—';
  return props.prefix ? `${props.prefix}: ${props.value}` : props.value;
});
</script>

<template>
  <span
    v-if="active"
    :class="cls"
    :title="value ?? undefined"
  >{{ label }}</span>
  <span
    v-else-if="showPlaceholder"
    class="muted"
    :title="value ?? 'not classified'"
  >—</span>
</template>

<style lang="scss" scoped>
.pill {
  font-size: 11px;
  padding: 1px 8px;
}
</style>
