<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { CdeRow } from '@/types';
import { splitPipe, splitSemi } from '@/types';
import ClassificationPill from './ClassificationPill.vue';
import DiseaseScopeCell from './DiseaseScopeCell.vue';
import AddToCrfButton from './AddToCrfButton.vue';
import CdeOriginDiff from './CdeOriginDiff.vue';
import { useConcepts, conceptLabel, type ConceptForCde } from '@/composables/useConcepts';
import { DISEASE_OPTIONS } from '@/composables/useDiseaseLens';

// Per-disease classification rows for the right-hand grid. Derived from
// DISEASE_OPTIONS so adding a new disease (e.g. classification_epilepsy) flows
// in automatically. Excludes 'all' which has no classification column.
const CLASSIFICATION_ROWS = DISEASE_OPTIONS
  .filter((o) => o.column !== null)
  .map((o) => ({
    key: o.key,
    label: o.label,
    column: `classification_${o.key}` as keyof CdeRow,
  }));

const props = defineProps<{
  modelValue: boolean;
  cde: CdeRow | null;
}>();

defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const permissibleValues = computed(() => {
  if (!props.cde) return [];
  const labels = splitPipe(props.cde.pv_labels);
  const codes = splitPipe(props.cde.pv_codes);
  const defs = splitPipe(props.cde.pv_definitions);
  const codeSys = splitPipe(props.cde.pv_code_systems);
  const concepts = splitPipe(props.cde.pv_concept_identifiers);
  const termSrcs = splitPipe(props.cde.pv_terminology_sources);
  return labels.map((label, i) => ({
    label,
    code: codes[i] ?? null,
    definition: defs[i] ?? null,
    code_system: codeSys[i] ?? null,
    concept: concepts[i] ?? null,
    terminology: termSrcs[i] ?? null,
  }));
});

const referenceList = computed(() => splitSemi(props.cde?.refs));
const sourceList = computed(() => splitSemi(props.cde?.cde_source));
const aliasList = computed(() => splitPipe(props.cde?.aliases));
const keywordList = computed(() => splitPipe(props.cde?.keywords));

// Any of the NLM/source-attribution fields present? Drives the
// "Source metadata" section's visibility so we don't render an empty header.
const hasSourceMeta = computed(() => {
  const c = props.cde;
  if (!c) return false;
  return Boolean(c.steward_org || c.registration_status || c.cde_origin || c.population);
});

// CDEs that belong to a bundle should only ever enter a CRF as part of that
// bundle — they're collected together by definition. So when this CDE is
// bundled, we redirect the Add-to-CRF action to add the parent bundle, and
// surface the change in the button label so the user understands why.
const isBundled = computed(() => Boolean(props.cde?.bundle_name));

// Concept layer — surface the semantic anchors this CDE points at, if any.
// Phase 1 just renders source + identifier; Phase 4 (UTS cache) will fill
// preferred_label so the chips can show real concept names.
const { getConceptsForCde } = useConcepts();
const concepts = ref<ConceptForCde[]>([]);
watch(
  () => props.cde?.cde_id,
  async (id) => {
    if (!id) {
      concepts.value = [];
      return;
    }
    try {
      concepts.value = await getConceptsForCde(id);
    } catch {
      concepts.value = [];
    }
  },
  { immediate: true },
);
const addKind = computed<'cde' | 'bundle'>(() => (isBundled.value ? 'bundle' : 'cde'));
const addRef = computed<string | null>(() =>
  isBundled.value ? (props.cde?.bundle_name ?? null) : (props.cde?.cde_name ?? null),
);
const addLabel = computed<string>(() =>
  isBundled.value ? 'Add bundle to CRF' : 'Add to CRF',
);
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    :title="cde?.cde_name ?? ''"
    direction="rtl"
    size="58%"
    destroy-on-close
  >
    <div v-if="cde" class="cde-detail">
      <header class="cde-detail__head">
        <div class="cde-detail__title-row">
          <h2>{{ cde.cde_name }}</h2>
          <el-tooltip
            v-if="isBundled"
            placement="bottom"
            effect="dark"
            content="This CDE is part of a bundle. CDEs in a bundle are always collected together, so the whole bundle gets added — not just this single CDE."
          >
            <span>
              <AddToCrfButton
                :kind="addKind"
                :target-ref="addRef"
                :label="addLabel"
                size="small"
              />
            </span>
          </el-tooltip>
          <AddToCrfButton
            v-else
            :kind="addKind"
            :target-ref="addRef"
            :label="addLabel"
            size="small"
          />
        </div>
        <div class="cde-detail__meta">
          <span class="mono muted" v-if="cde.variable_name">{{ cde.variable_name }}</span>
          <el-tag size="small" type="info">{{ cde.cde_data_type }}</el-tag>
          <el-tag v-if="cde.cde_type" size="small">{{ cde.cde_type }}</el-tag>
          <el-tag v-if="cde.unit_of_measure" size="small" type="warning">
            unit: {{ cde.unit_of_measure }}
          </el-tag>
        </div>
      </header>

      <!-- Concept(s) this CDE represents. Each chip routes to the concept
           detail page; until UMLS enrichment lands the label is just
           "<source>:<identifier>". When the CDE has no concept mapping
           (NINDS / demo records, or NLM rows without dec_identifier) we
           hide the section entirely. -->
      <section v-if="concepts.length">
        <h3>Concept{{ concepts.length === 1 ? '' : 's' }}</h3>
        <div class="concept-chips">
          <router-link
            v-for="c in concepts"
            :key="c.id"
            :to="`/concepts/${c.id}`"
            class="concept-chip"
          >
            <span class="concept-chip__source">{{ c.source }}</span>
            <span class="concept-chip__label">{{ conceptLabel(c) }}</span>
            <span v-if="c.role !== 'primary'" class="concept-chip__role">
              · {{ c.role }}
            </span>
          </router-link>
        </div>
      </section>

      <section>
        <h3>Definition</h3>
        <p>{{ cde.cde_definition }}</p>
        <p v-if="cde.preferred_question_text" class="subtle">
          <strong>Preferred question:</strong> {{ cde.preferred_question_text }}
        </p>
      </section>

      <section v-if="aliasList.length">
        <h3>Also known as</h3>
        <div class="tags">
          <el-tag
            v-for="a in aliasList"
            :key="a"
            size="small"
            type="info"
            effect="plain"
          >{{ a }}</el-tag>
        </div>
      </section>

      <section v-if="hasSourceMeta || keywordList.length">
        <h3>Source metadata</h3>
        <table v-if="hasSourceMeta" class="kv">
          <tbody>
            <tr v-if="cde.steward_org">
              <td>Steward</td>
              <td>{{ cde.steward_org }}</td>
            </tr>
            <tr v-if="cde.registration_status">
              <td>Status</td>
              <td>
                <el-tag size="small" :type="cde.registration_status === 'Standard' || cde.registration_status === 'Qualified' ? 'success' : 'info'">
                  {{ cde.registration_status }}
                </el-tag>
              </td>
            </tr>
            <tr v-if="cde.cde_origin">
              <td>Origin</td>
              <td>{{ cde.cde_origin }}</td>
            </tr>
            <tr v-if="cde.population">
              <td>Population</td>
              <td>{{ cde.population }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="keywordList.length" class="keyword-row">
          <span class="muted">Keywords:</span>
          <div class="tags">
            <el-tag
              v-for="k in keywordList"
              :key="k"
              size="small"
              effect="plain"
            >{{ k }}</el-tag>
          </div>
        </div>
      </section>

      <section v-if="cde.bundle_name">
        <h3>Bundle</h3>
        <div class="breadcrumb">
          <span>{{ cde.bundle_domain }}</span>
          <span class="sep">›</span>
          <span>{{ cde.bundle_subdomain }}</span>
          <span class="sep">›</span>
          <span>{{ cde.bundle_category }}</span>
          <span class="sep">›</span>
          <router-link :to="`/bundles/${cde.bundle_id}`">{{ cde.bundle_name }}</router-link>
        </div>
        <div class="subtle" v-if="cde.bundle_working_group">
          Working group: {{ cde.bundle_working_group }}
        </div>
      </section>

      <section class="grid-2">
        <div>
          <h3>Disease scope</h3>
          <DiseaseScopeCell :row="cde" />
        </div>
        <div>
          <h3>Classification</h3>
          <div class="classification-grid">
            <template v-for="row in CLASSIFICATION_ROWS" :key="row.key">
              <span class="muted">{{ row.label }}</span>
              <ClassificationPill
                :value="(cde[row.column] as string | null)"
                show-placeholder
              />
            </template>
          </div>
        </div>
      </section>

      <section v-if="permissibleValues.length">
        <h3>Permissible values</h3>
        <el-table :data="permissibleValues" size="small" border>
          <el-table-column prop="code" label="Code" width="80" />
          <el-table-column prop="label" label="Label" min-width="140" />
          <el-table-column prop="definition" label="Definition" min-width="220" show-overflow-tooltip />
          <el-table-column prop="code_system" label="Code system" width="120" />
          <el-table-column prop="concept" label="Concept ID" width="110" />
          <el-table-column prop="terminology" label="Term. source" width="110" />
        </el-table>
      </section>

      <section v-if="cde.min_value !== null || cde.max_value !== null">
        <h3>Range</h3>
        <p>
          <span v-if="cde.min_value !== null">min: <strong>{{ cde.min_value }}</strong></span>
          <span v-if="cde.max_value !== null" style="margin-left: 1em">
            max: <strong>{{ cde.max_value }}</strong>
          </span>
          <span v-if="cde.unit_of_measure" style="margin-left: 1em" class="muted">
            ({{ cde.unit_of_measure }})
          </span>
        </p>
      </section>

      <section class="grid-2">
        <div v-if="cde.cdisc_variable_name">
          <h3>CDISC mapping</h3>
          <table class="kv">
            <tbody>
              <tr><td>Domain</td><td>{{ cde.cdisc_domain ?? '—' }}</td></tr>
              <tr><td>Variable</td><td class="mono">{{ cde.cdisc_variable_name }}</td></tr>
              <tr><td>Label</td><td>{{ cde.cdisc_variable_label ?? '—' }}</td></tr>
            </tbody>
          </table>
        </div>
        <div>
          <h3>Identifiers</h3>
          <table class="kv">
            <tbody>
              <tr v-if="cde.nlm_identifier">
                <td>NLM</td>
                <td class="mono">{{ cde.nlm_identifier }}</td>
              </tr>
              <tr v-if="cde.dec_identifier">
                <td>DEC</td>
                <td>
                  <span class="mono">{{ cde.dec_identifier }}</span>
                  <span v-if="cde.dec_terminology_source" class="muted">
                    ({{ cde.dec_terminology_source }})
                  </span>
                </td>
              </tr>
              <tr v-if="cde.other_identifiers">
                <td>Other</td>
                <td class="mono">{{ cde.other_identifiers }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="sourceList.length || cde.origins">
        <h3>Origin</h3>
        <div v-if="cde.origins" class="subtle origins">
          {{ cde.origins }}<span v-if="(cde.origin_count ?? 1) > 1"> — reconciled from {{ cde.origin_count }} sources</span>
        </div>
        <div v-if="sourceList.length" class="tags" style="margin-top: 6px">
          <el-tag v-for="s in sourceList" :key="s" size="small">{{ s }}</el-tag>
        </div>
      </section>

      <CdeOriginDiff
        v-if="(cde.origin_count ?? 1) > 1"
        :canonical-key="cde.canonical_key"
      />

      <section v-if="referenceList.length">
        <h3>References</h3>
        <ul class="refs">
          <li v-for="r in referenceList" :key="r">
            <a v-if="r.startsWith('http')" :href="r" target="_blank" rel="noopener">{{ r }}</a>
            <span v-else>{{ r }}</span>
          </li>
        </ul>
      </section>

      <section v-if="cde.classification_notes || cde.additional_instructions">
        <h3>Notes</h3>
        <p v-if="cde.classification_notes">{{ cde.classification_notes }}</p>
        <p v-if="cde.additional_instructions">
          <strong>Instructions:</strong> {{ cde.additional_instructions }}
        </p>
      </section>
    </div>
  </el-drawer>
</template>

<style lang="scss" scoped>
.cde-detail {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;

  &__head {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid $lineColor2;
  }

  &__title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;

    h2 {
      margin: 0;
    }
  }

  &__meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
}

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2rem;
}

.breadcrumb {
  font-size: 13px;
  color: $gray_5;

  .sep {
    margin: 0 6px;
    color: $gray_3;
  }
}

.classification-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  font-size: 12px;
  align-items: center;
}

.kv {
  font-size: 13px;
  td {
    padding: 4px 8px 4px 0;
    vertical-align: top;
    &:first-child {
      color: $neutralGrey;
      white-space: nowrap;
    }
  }
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.keyword-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  margin-top: 4px;

  .muted {
    flex: 0 0 auto;
    padding-top: 3px;
  }
}

.refs {
  padding-left: 1.25rem;
  margin: 0;
  font-size: 13px;

  li {
    margin-bottom: 2px;
    word-break: break-all;
  }
}

.concept-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.concept-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid $lineColor2;
  border-left: 3px solid $purple_3;
  border-radius: 2px;
  background: $white;
  font-size: 12px;
  text-decoration: none;
  color: $gray_6;
  transition: background 80ms ease, transform 80ms ease;

  &:hover {
    background: $gray_1;
    transform: translateY(-1px);
  }

  &__source {
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: $purple_3;
    font-size: 10px;
  }

  &__label {
    color: $gray_6;
  }

  &__role {
    color: $gray_4;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
}
</style>
