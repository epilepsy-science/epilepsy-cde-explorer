<script setup lang="ts">
// Render a single CDE the way it'd show up on a real CRF — same widget
// choices the PDF export makes (radios for short value lists, dropdown for
// long, split fields for datetime, format-hinted text inputs for date/time/
// number/text). Read-only by design; the reviewer sees the data-collector
// experience without being able to fill anything in.

import { computed } from 'vue';
import { splitPipe } from '@/types';

interface CdeShape {
  cde_name: string;
  cde_data_type: string;
  cde_definition?: string | null;
  preferred_question_text?: string | null;
  variable_name?: string | null;
  unit_of_measure?: string | null;
  pv_labels?: string | null;
  pv_codes?: string | null;
  min_value?: number | null;
  max_value?: number | null;
}

const props = defineProps<{ cde: CdeShape; compact?: boolean }>();

const dt = computed(() => (props.cde.cde_data_type ?? '').toLowerCase());
const labels = computed(() => splitPipe(props.cde.pv_labels));
const codes = computed(() => splitPipe(props.cde.pv_codes));
const isValueList = computed(() => dt.value === 'value list' && labels.value.length > 0);

// Review-context rules differ from the PDF: every value list renders as a
// full radio list so reviewers can see every permissible value at a glance.
// (The PDF still collapses long lists to a dropdown to save page space.)
const valueListMode = computed<'checkbox' | 'radio' | null>(() => {
  if (!isValueList.value) return null;
  return labels.value.length === 1 ? 'checkbox' : 'radio';
});

const questionText = computed(
  () => props.cde.preferred_question_text || props.cde.cde_name,
);

// Always show the definition when present — the reviewer needs full context
// even when it overlaps with the question text. The PDF dedups this; the
// review preview deliberately doesn't.
const showDefinition = computed(() => Boolean(props.cde.cde_definition));

const inputHint = computed<string | null>(() => {
  switch (dt.value) {
    case 'date': return 'YYYY-MM-DD';
    case 'time': return 'HH:MM (24-hour)';
    case 'number': return 'Number';
    case 'file/uri/url': return 'URL or file path';
    case 'geolocation': return 'lat, lon (decimal degrees)';
    default: return null;
  }
});

const numericRange = computed<string | null>(() => {
  const lo = props.cde.min_value;
  const hi = props.cde.max_value;
  if (lo == null && hi == null) return null;
  return `${lo ?? '−∞'} to ${hi ?? '∞'}`;
});

function pairLabel(i: number): string {
  // Match the PDF rule: drop redundant "Code: Label" when they're the same.
  const code = codes.value[i];
  const label = labels.value[i];
  if (!code || code === label) return label;
  return `${code} · ${label}`;
}
</script>

<template>
  <div class="crf-field" :class="{ 'crf-field--compact': compact }">
    <div class="crf-field__label">
      {{ questionText }}
      <span class="crf-field__type">{{ cde.cde_data_type }}</span>
    </div>
    <div v-if="showDefinition" class="crf-field__def">
      {{ cde.cde_definition }}
    </div>

    <!-- Single-option value list → checkbox toggle -->
    <label v-if="valueListMode === 'checkbox'" class="crf-input crf-input--check">
      <input type="checkbox" disabled />
      <span>{{ labels[0] }}</span>
    </label>

    <!-- Value list → full radio list, regardless of length. Reviewers
         need to see every permissible value to evaluate the CDE. -->
    <div v-else-if="valueListMode === 'radio'" class="crf-input crf-input--radios">
      <label v-for="(_, i) in labels" :key="i" class="crf-radio">
        <input type="radio" :name="cde.cde_name" disabled />
        <span>{{ pairLabel(i) }}</span>
      </label>
    </div>

    <!-- Datetime → side-by-side date + time -->
    <div v-else-if="dt === 'datetime'" class="crf-input crf-input--datetime">
      <div class="crf-datetime__col">
        <input type="text" disabled placeholder="YYYY-MM-DD" />
        <span class="crf-input__hint">Date</span>
      </div>
      <div class="crf-datetime__col">
        <input type="text" disabled placeholder="HH:MM" />
        <span class="crf-input__hint">Time (24-hour)</span>
      </div>
    </div>

    <!-- Anything else → text input -->
    <div v-else class="crf-input crf-input--text">
      <input type="text" disabled :placeholder="inputHint ?? 'Free text'" />
    </div>

    <!-- Hint footer: format / unit / range — only for non-value-list types
         where the input itself doesn't carry the choices. -->
    <div
      v-if="!isValueList && (cde.unit_of_measure || numericRange)"
      class="crf-field__hints"
    >
      <span v-if="cde.unit_of_measure">unit: {{ cde.unit_of_measure }}</span>
      <span v-if="numericRange">range: {{ numericRange }}</span>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.crf-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  background: $white;
  border: 1px solid $lineColor2;
  border-left: 3px solid $es-primary-color;
  border-radius: 3px;

  &--compact {
    padding: 10px 12px;
    border-left-width: 2px;
  }

  &__label {
    font-size: 13px;
    font-weight: 600;
    color: $gray_6;
    line-height: 1.35;
  }

  &__type {
    margin-left: 8px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: $gray_4;
    background: $gray_1;
    padding: 1px 6px;
    border-radius: 2px;
    vertical-align: middle;
  }

  &__def {
    font-size: 12px;
    color: $gray_5;
    line-height: 1.45;
  }

  &__hints {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    font-size: 11px;
    color: $gray_5;
    margin-top: 2px;
  }
}

.crf-input {
  margin-top: 4px;

  input,
  select {
    font-family: inherit;
    font-size: 13px;
    color: $gray_6;
    padding: 6px 10px;
    border: 1px solid $lineColor2;
    border-radius: 3px;
    background: $gray_0;
    cursor: not-allowed;
  }

  &--text input,
  &--select {
    width: 100%;
  }

  &--check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: $gray_6;
    cursor: not-allowed;

    input {
      width: 14px;
      height: 14px;
      padding: 0;
    }
  }

  &--radios {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  &--datetime {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;

    input {
      width: 100%;
    }
  }

  &__hint {
    display: block;
    margin-top: 3px;
    font-size: 11px;
    color: $gray_5;
  }
}

.crf-radio {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: $gray_6;
  cursor: not-allowed;

  input {
    width: 14px;
    height: 14px;
    padding: 0;
  }
}

.crf-datetime__col {
  display: flex;
  flex-direction: column;
}
</style>
