<script setup lang="ts">
import { computed } from 'vue';
import type { CdeRow } from '@/types';
import { splitPipe, splitSemi } from '@/types';
import ClassificationPill from './ClassificationPill.vue';
import DiseaseScopeCell from './DiseaseScopeCell.vue';
import AddToCrfButton from './AddToCrfButton.vue';
import CdeOriginDiff from './CdeOriginDiff.vue';

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
          <AddToCrfButton kind="cde" :ref="cde.cde_name" size="small" />
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

      <section>
        <h3>Definition</h3>
        <p>{{ cde.cde_definition }}</p>
        <p v-if="cde.preferred_question_text" class="subtle">
          <strong>Preferred question:</strong> {{ cde.preferred_question_text }}
        </p>
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
            <div><span class="muted">Agnostic</span><ClassificationPill :value="cde.classification_agnostic" show-placeholder /></div>
            <div><span class="muted">Neurotrauma</span><ClassificationPill :value="cde.classification_neurotrauma" /></div>
            <div><span class="muted">TBI</span><ClassificationPill :value="cde.classification_tbi" /></div>
            <div><span class="muted">PTE</span><ClassificationPill :value="cde.classification_pte" /></div>
            <div><span class="muted">SCI</span><ClassificationPill :value="cde.classification_sci" /></div>
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

.refs {
  padding-left: 1.25rem;
  margin: 0;
  font-size: 13px;

  li {
    margin-bottom: 2px;
    word-break: break-all;
  }
}
</style>
