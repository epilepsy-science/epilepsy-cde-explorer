<script setup lang="ts">
import { computed } from 'vue';

interface Segment {
  label: string;
  count: number;
  color: string;
}

const props = defineProps<{
  title: string;
  segments: Segment[];
  // Center label under the total (e.g. "CDEs"). Optional.
  centerLabel?: string;
  // Max segments before grouping the tail into "Other". Default 6.
  maxSegments?: number;
  // Color used for the synthesized "Other" bucket.
  otherColor?: string;
}>();

const RADIUS = 40;
const STROKE = 14;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const MAX_DEFAULT = 6;
const OTHER_DEFAULT = '#c4c8cc';

interface Arc {
  label: string;
  count: number;
  color: string;
  length: number;
  offset: number;
  pct: number;
}

const groupedSegments = computed<Segment[]>(() => {
  const max = props.maxSegments ?? MAX_DEFAULT;
  const sorted = [...props.segments]
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count);
  if (sorted.length <= max) return sorted;
  const head = sorted.slice(0, max - 1);
  const tail = sorted.slice(max - 1);
  const otherCount = tail.reduce((sum, s) => sum + s.count, 0);
  return [
    ...head,
    {
      label: 'Other',
      count: otherCount,
      color: props.otherColor ?? OTHER_DEFAULT,
    },
  ];
});

const total = computed(() =>
  groupedSegments.value.reduce((sum, s) => sum + s.count, 0),
);

const arcs = computed<Arc[]>(() => {
  const t = total.value;
  if (t <= 0) return [];
  let cumulative = 0;
  return groupedSegments.value.map((s) => {
    const frac = s.count / t;
    const length = frac * CIRCUMFERENCE;
    const offset = cumulative;
    cumulative += length;
    return {
      label: s.label,
      count: s.count,
      color: s.color,
      length,
      offset,
      pct: Math.round(frac * 100),
    };
  });
});
</script>

<template>
  <div class="donut">
    <h3 class="donut__title">{{ title }}</h3>
    <div class="donut__body">
      <svg viewBox="0 0 100 100" class="donut__svg" role="img" :aria-label="title">
        <!-- Track ring under all arcs so a partially-empty donut still reads as a circle. -->
        <circle cx="50" cy="50" :r="RADIUS" fill="none" stroke="#e8eaed" :stroke-width="STROKE" />
        <circle
          v-for="a in arcs"
          :key="a.label"
          cx="50"
          cy="50"
          :r="RADIUS"
          fill="none"
          :stroke="a.color"
          :stroke-width="STROKE"
          :stroke-dasharray="`${a.length} ${CIRCUMFERENCE - a.length}`"
          :stroke-dashoffset="-a.offset"
          transform="rotate(-90 50 50)"
        >
          <title>{{ a.label }}: {{ a.count.toLocaleString() }} ({{ a.pct }}%)</title>
        </circle>
        <text x="50" y="48" text-anchor="middle" class="donut__total">
          {{ total.toLocaleString() }}
        </text>
        <text v-if="centerLabel" x="50" y="60" text-anchor="middle" class="donut__total-sub">
          {{ centerLabel }}
        </text>
      </svg>
      <ul class="donut__legend">
        <li v-for="a in arcs" :key="a.label" class="legend-row">
          <span class="legend-row__swatch" :style="{ background: a.color }" />
          <span class="legend-row__label" :title="a.label">{{ a.label }}</span>
          <span class="legend-row__count">{{ a.count.toLocaleString() }}</span>
          <span class="legend-row__pct muted">{{ a.pct }}%</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.donut {
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 2px;
  padding: 14px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;

  &__title {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: $gray_5;
  }

  &__body {
    display: grid;
    grid-template-columns: 130px 1fr;
    gap: 12px;
    align-items: center;
  }

  &__svg {
    width: 130px;
    height: 130px;
    display: block;
  }

  &__total {
    font-size: 18px;
    font-weight: 700;
    fill: $gray_6;
  }

  &__total-sub {
    font-size: 7px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    fill: $gray_4;
    font-weight: 600;
  }

  &__legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    min-width: 0;
  }
}

.legend-row {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 6px;
  line-height: 1.3;

  &__swatch {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  &__label {
    color: $gray_6;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__count {
    font-variant-numeric: tabular-nums;
    color: $gray_6;
    font-weight: 600;
  }

  &__pct {
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    min-width: 28px;
    text-align: right;
  }
}
</style>
