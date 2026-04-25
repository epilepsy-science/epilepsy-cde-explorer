<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useDuckDB } from '@/composables/useDuckDB';

const props = defineProps<{
  /** Canonical key from cde_full — keys all source variants for this CDE. */
  canonicalKey: string | null;
}>();

const { query, status } = useDuckDB();

interface Variant {
  source_key: string;
  source_label: string;
  cde_name: string | null;
  cde_definition: string | null;
  cde_data_type: string | null;
  pv_labels: string | null;
  references: string | null;
  nlm_identifier: string | null;
  dec_identifier: string | null;
  other_identifiers: string | null;
  preferred_question_text: string | null;
}

const variants = ref<Variant[]>([]);
const loading = ref(false);

async function load() {
  variants.value = [];
  if (!props.canonicalKey || status.value !== 'ready') return;
  loading.value = true;
  try {
    variants.value = await query<Variant>(
      `SELECT
         k._source_key  AS source_key,
         COALESCE(sl.label, k._source_key) AS source_label,
         k.cde_name,
         k.cde_definition,
         k.cde_data_type,
         k.pv_labels,
         k.references,
         k.nlm_identifier,
         k.dec_identifier,
         k.other_identifiers,
         k.preferred_question_text
       FROM cde_keyed k
       LEFT JOIN source_labels sl ON sl.source_key = k._source_key
       WHERE k.canonical_key = ?
       ORDER BY k._source_order`,
      [props.canonicalKey],
    );
  } finally {
    loading.value = false;
  }
}

watch(() => [props.canonicalKey, status.value] as const, load, { immediate: true });

/**
 * Field rows for the diff table — `key` is the column on Variant; `label`
 * is the display name. We hide rows where every variant has the same value.
 */
const FIELDS: Array<{ key: keyof Variant; label: string; mono?: boolean }> = [
  { key: 'cde_name', label: 'Name' },
  { key: 'cde_data_type', label: 'Data type' },
  { key: 'cde_definition', label: 'Definition' },
  { key: 'pv_labels', label: 'Permissible values' },
  { key: 'preferred_question_text', label: 'Question text' },
  { key: 'references', label: 'References' },
  { key: 'nlm_identifier', label: 'CDE code', mono: true },
  { key: 'dec_identifier', label: 'DEC concept', mono: true },
  { key: 'other_identifiers', label: 'Other IDs', mono: true },
];

const rows = computed(() => {
  if (variants.value.length < 2) return [];
  return FIELDS.map((f) => {
    const values = variants.value.map((v) => v[f.key] ?? null);
    const distinct = new Set(values.map((v) => (v ?? '').trim())).size;
    return { ...f, values, differs: distinct > 1 };
  }).filter((r) => r.differs);
});
</script>

<template>
  <section v-if="variants.length > 1" class="origin-diff">
    <h3>
      Differences across sources
      <span class="muted">— same CDE, different content</span>
    </h3>
    <div v-if="loading" class="muted">Loading…</div>
    <div v-else-if="!rows.length" class="muted">
      All {{ variants.length }} sources agree on every field.
    </div>
    <table v-else class="diff-table">
      <thead>
        <tr>
          <th class="diff-table__field">Field</th>
          <th
            v-for="v in variants"
            :key="v.source_key"
            class="diff-table__source"
          >{{ v.source_label }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.key">
          <th class="diff-table__field">{{ r.label }}</th>
          <td
            v-for="(val, i) in r.values"
            :key="i"
            :class="{ 'diff-table__cell': true, mono: r.mono, 'is-empty': !val }"
          >
            {{ val ?? '—' }}
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style lang="scss" scoped>
.origin-diff {
  h3 .muted {
    font-weight: 400;
    font-size: 13px;
  }
}

.diff-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  table-layout: fixed;

  th, td {
    border: 1px solid $lineColor2;
    padding: 8px 10px;
    vertical-align: top;
    line-height: 1.4;
    word-break: break-word;
  }

  thead th {
    background: $gray_1;
    font-weight: 600;
    text-align: left;
  }

  &__field {
    width: 140px;
    background: $gray_1;
    text-align: left;
    color: $gray_6;
    font-weight: 600;
  }

  &__source {
    color: $gray_6;
  }

  &__cell {
    background: $white;

    &.is-empty {
      color: $neutralGrey;
      font-style: italic;
    }
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 11px;
  }
}
</style>
