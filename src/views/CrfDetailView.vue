<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useCrfStore } from '@/composables/useCrfStore';
import { useDuckDB } from '@/composables/useDuckDB';
import ClassificationPill from '@/components/ClassificationPill.vue';
import CdeDetailDrawer from '@/components/CdeDetailDrawer.vue';
import { isActiveTier, splitPipe, type CdeRow, type CrfItem, type CrfRecord } from '@/types';
import {
  buildRedcapCsv,
  downloadRedcapCsv,
  type RedcapCdeInput,
  type RedcapBundleInput,
} from '@/utils/redcapExport';
import { ElMessage, ElNotification } from 'element-plus';

const route = useRoute();
const { ensureLoaded, getCrf, loaded } = useCrfStore();
const { query, status } = useDuckDB();

const crf = ref<CrfRecord | null>(null);
const loading = ref(true);

// Resolved lookup tables: ref (cde_name / bundle_name) → row.
interface ResolvedCde {
  cde_id: string;
  cde_name: string;
  variable_name: string | null;
  cde_data_type: string;
  cde_definition: string;
  preferred_question_text: string | null;
  unit_of_measure: string | null;
  pv_labels: string | null;
  pv_codes: string | null;
  min_value: number | null;
  max_value: number | null;
  classification_agnostic: string | null;
  classification_neurotrauma: string | null;
  classification_tbi: string | null;
  classification_pte: string | null;
  classification_sci: string | null;
  bundle_id: string | null;
  bundle_name: string | null;
}
interface ResolvedBundle {
  id: string;
  bundle_name: string;
  display_name?: string | null;
  description?: string | null;
  domain: string | null;
  subdomain: string | null;
  category: string | null;
  cdes: ResolvedCde[];
}

const cdeByName = ref<Map<string, ResolvedCde>>(new Map());
const bundleByName = ref<Map<string, ResolvedBundle>>(new Map());

async function loadCrf() {
  await ensureLoaded();
  const id = String(route.params.id);
  const found = getCrf(id);
  crf.value = found ?? null;
}

async function resolveRefs() {
  if (!crf.value || status.value !== 'ready') return;
  const cdeRefs = new Set<string>();
  const bundleRefs = new Set<string>();
  for (const it of crf.value.items) {
    if (it.type === 'cde' && it.ref) cdeRefs.add(it.ref);
    if (it.type === 'bundle' && it.ref) bundleRefs.add(it.ref);
  }

  const tasks: Promise<unknown>[] = [];

  if (cdeRefs.size) {
    const placeholders = [...cdeRefs].map(() => '?').join(',');
    tasks.push(
      query<ResolvedCde>(
        `SELECT * FROM cde_full WHERE cde_name IN (${placeholders})`,
        [...cdeRefs],
      ).then((rows) => {
        const m = new Map<string, ResolvedCde>();
        for (const r of rows) m.set(r.cde_name, r);
        cdeByName.value = m;
      }),
    );
  } else {
    cdeByName.value = new Map();
  }

  if (bundleRefs.size) {
    const placeholders = [...bundleRefs].map(() => '?').join(',');
    tasks.push(
      query<{
        id: string;
        bundle_name: string;
        display_name: string | null;
        description: string | null;
        domain: string | null;
        subdomain: string | null;
        category: string | null;
      }>(
        `SELECT id, bundle_name, display_name, description, domain, subdomain, category
         FROM bundle WHERE bundle_name IN (${placeholders})`,
        [...bundleRefs],
      ).then(async (bundles) => {
        // Now resolve member CDEs for each bundle via the relationships graph.
        const byId = new Map<string, ResolvedBundle>();
        for (const b of bundles) {
          byId.set(b.id, { ...b, cdes: [] });
        }
        if (bundles.length) {
          const idPlaceholders = bundles.map(() => '?').join(',');
          const members = await query<ResolvedCde & { _bundle_id: string }>(
            `SELECT cde_name, variable_name, cde_data_type, cde_definition,
                    preferred_question_text, unit_of_measure, pv_labels, pv_codes,
                    min_value, max_value,
                    classification_agnostic, classification_neurotrauma,
                    classification_tbi, classification_pte, classification_sci,
                    bundle_id AS _bundle_id, bundle_name
             FROM cde_full WHERE bundle_id IN (${idPlaceholders})
             ORDER BY cde_name`,
            bundles.map((b) => b.id),
          );
          for (const m of members) {
            const b = byId.get(m._bundle_id);
            if (b) {
              const { _bundle_id, ...cde } = m;
              b.cdes.push(cde as ResolvedCde);
            }
          }
        }
        const byName = new Map<string, ResolvedBundle>();
        for (const b of byId.values()) byName.set(b.bundle_name, b);
        bundleByName.value = byName;
      }),
    );
  } else {
    bundleByName.value = new Map();
  }

  await Promise.all(tasks);
}

async function load() {
  loading.value = true;
  try {
    await loadCrf();
    if (crf.value) await resolveRefs();
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => route.params.id, load);
watch(loaded, (v) => {
  if (v && !crf.value) loadCrf();
});

// Tiny markdown → HTML shim: headings (##, ###), bold (**), line breaks, lists (- ).
// Seeded instructions only — user-authored instructions will need sanitization.
function renderMarkdown(md: string | null): string {
  if (!md) return '';
  const esc = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const lines = esc.split('\n');
  const out: string[] = [];
  let inList = false;
  let inParagraph = false;
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };
  const closeParagraph = () => {
    if (inParagraph) {
      out.push('</p>');
      inParagraph = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) {
      closeList();
      closeParagraph();
      continue;
    }
    if (line.startsWith('### ')) {
      closeList();
      closeParagraph();
      out.push(`<h5>${line.slice(4)}</h5>`);
      continue;
    }
    if (line.startsWith('## ')) {
      closeList();
      closeParagraph();
      out.push(`<h4>${line.slice(3)}</h4>`);
      continue;
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      closeParagraph();
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inlineFormat(line.slice(2))}</li>`);
      continue;
    }
    closeList();
    if (!inParagraph) {
      out.push('<p>');
      inParagraph = true;
    } else {
      out.push('<br>');
    }
    out.push(inlineFormat(line));
  }
  closeList();
  closeParagraph();
  return out.join('');
}
function inlineFormat(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

// Render helpers for tiers.
const TIER_COLS: Array<{ col: keyof ResolvedCde; prefix: string }> = [
  { col: 'classification_agnostic', prefix: 'AGN' },
  { col: 'classification_neurotrauma', prefix: 'NT' },
  { col: 'classification_tbi', prefix: 'TBI' },
  { col: 'classification_pte', prefix: 'PTE' },
  { col: 'classification_sci', prefix: 'SCI' },
];

function tiersForCde(c: ResolvedCde) {
  return TIER_COLS.flatMap(({ col, prefix }) => {
    const v = c[col] as string | null;
    return isActiveTier(v) ? [{ prefix, value: v as string }] : [];
  });
}

interface PermissibleValue {
  label: string;
  code: string | null;
}

function pvsForCde(c: ResolvedCde): PermissibleValue[] {
  const labels = splitPipe(c.pv_labels);
  const codes = splitPipe(c.pv_codes);
  return labels.map((label, i) => ({
    label,
    code: codes[i] ?? null,
  }));
}

interface RenderedItem extends CrfItem {
  idx: number;
  resolved?: ResolvedCde | ResolvedBundle | null;
}

const renderedItems = computed<RenderedItem[]>(() => {
  if (!crf.value) return [];
  return crf.value.items.map((it, idx) => {
    let resolved: ResolvedCde | ResolvedBundle | null | undefined;
    if (it.type === 'cde' && it.ref) resolved = cdeByName.value.get(it.ref);
    else if (it.type === 'bundle' && it.ref)
      resolved = bundleByName.value.get(it.ref);
    return { ...it, idx, resolved };
  });
});

const selectedCde = ref<CdeRow | null>(null);
const cdeDrawerOpen = ref(false);

function openCdeDrawer(cde: ResolvedCde) {
  selectedCde.value = cde as unknown as CdeRow;
  cdeDrawerOpen.value = true;
}

const canExport = computed(() => {
  if (!crf.value) return false;
  return crf.value.items.some((it) => it.type === 'cde' || it.type === 'bundle');
});

function exportToRedcap() {
  if (!crf.value) return;
  // The resolved maps already match the util's input shapes — ResolvedCde
  // carries every field RedcapCdeInput needs, and ResolvedBundle exposes
  // `{bundle_name, cdes}`.
  const cdesByRef = cdeByName.value as unknown as Map<string, RedcapCdeInput>;
  const bundlesByRef = bundleByName.value as unknown as Map<string, RedcapBundleInput>;
  const { csv, fieldCount, missingRefs } = buildRedcapCsv(
    crf.value,
    cdesByRef,
    bundlesByRef,
  );
  if (fieldCount === 0) {
    ElMessage.warning('Nothing to export — this CRF has no resolvable fields.');
    return;
  }
  downloadRedcapCsv(crf.value, csv);
  if (missingRefs.length) {
    ElNotification({
      type: 'warning',
      title: 'Exported with missing refs',
      message: `Skipped ${missingRefs.length} unresolved item(s). First: ${missingRefs[0]}`,
      duration: 6000,
    });
  } else {
    ElMessage.success(`Exported ${fieldCount} fields to CSV.`);
  }
}
</script>

<template>
  <div class="crf-detail" v-loading="loading">
    <nav class="crf-detail__breadcrumbs">
      <router-link to="/crfs">← All CRFs</router-link>
    </nav>

    <template v-if="crf">
      <header class="crf-detail__head">
        <div class="crf-detail__title-row">
          <div class="crf-detail__title-lead">
            <span
              class="source-tag"
              :class="crf.source === 'seeded' ? 'source-tag--seeded' : 'source-tag--custom'"
            >
              {{ crf.source === 'seeded' ? 'Validated' : 'Custom' }}
            </span>
            <h1>{{ crf.title }}</h1>
          </div>
          <div class="crf-detail__actions">
            <el-button
              v-if="crf.external_url"
              tag="a"
              :href="crf.external_url"
              target="_blank"
              rel="noopener"
            >
              <el-icon style="margin-right: 4px"><Link /></el-icon>
              Official form
            </el-button>
            <el-button
              type="primary"
              :disabled="!canExport"
              @click="exportToRedcap"
            >
              <el-icon style="margin-right: 4px"><Download /></el-icon>
              Download REDCap CSV
            </el-button>
          </div>
        </div>
        <p v-if="crf.description" class="crf-detail__desc">{{ crf.description }}</p>
      </header>

      <div class="crf-detail__body">
        <aside class="crf-detail__meta">
          <div class="meta-block">
            <div class="meta-block__label">Version</div>
            <div class="meta-block__value">{{ crf.version }}</div>
          </div>
          <div v-if="crf.disease_scope" class="meta-block">
            <div class="meta-block__label">Disease scope</div>
            <div class="meta-block__value">{{ crf.disease_scope }}</div>
          </div>
          <div v-if="crf.collection_frequency" class="meta-block">
            <div class="meta-block__label">Collection frequency</div>
            <div class="meta-block__value">{{ crf.collection_frequency }}</div>
          </div>
          <div v-if="crf.estimated_duration_minutes" class="meta-block">
            <div class="meta-block__label">Estimated duration</div>
            <div class="meta-block__value">{{ crf.estimated_duration_minutes }} min</div>
          </div>
          <div class="meta-block">
            <div class="meta-block__label">Variable name</div>
            <div class="meta-block__value mono">{{ crf.crf_name }}</div>
          </div>
        </aside>

        <main class="crf-detail__form">
          <section
            v-if="crf.instructions"
            class="crf-detail__instructions"
          >
            <h3>Instructions for data collectors</h3>
            <div class="markdown" v-html="renderMarkdown(crf.instructions)" />
          </section>

          <section class="crf-detail__items">
            <h3>Form items</h3>
            <div
              v-for="item in renderedItems"
              :key="item.idx"
              class="form-item"
              :class="`form-item--${item.type}`"
            >
              <template v-if="item.type === 'section'">
                <div class="section-break">
                  <div class="section-break__rule" />
                  <div class="section-break__label">
                    {{ item.label ?? 'Section' }}
                  </div>
                </div>
                <div
                  v-if="item.instructions"
                  class="section-break__instructions markdown"
                  v-html="renderMarkdown(item.instructions)"
                />
              </template>

              <template v-else-if="item.type === 'cde' && item.resolved">
                <div class="field">
                  <div class="field__head">
                    <span class="field__label">
                      {{ (item.resolved as ResolvedCde).preferred_question_text
                         || (item.resolved as ResolvedCde).cde_name }}
                    </span>
                    <span class="field__type">{{ (item.resolved as ResolvedCde).cde_data_type }}</span>
                  </div>
                  <div class="field__meta">
                    <span
                      v-if="(item.resolved as ResolvedCde).variable_name"
                      class="mono muted"
                    >{{ (item.resolved as ResolvedCde).variable_name }}</span>
                    <span
                      v-if="(item.resolved as ResolvedCde).unit_of_measure"
                      class="field__unit muted"
                    >{{ (item.resolved as ResolvedCde).unit_of_measure }}</span>
                    <span class="field__tiers">
                      <ClassificationPill
                        v-for="t in tiersForCde(item.resolved as ResolvedCde)"
                        :key="t.prefix"
                        :value="t.value"
                        :prefix="t.prefix"
                      />
                    </span>
                    <button
                      class="field__open"
                      @click="openCdeDrawer(item.resolved as ResolvedCde)"
                    >Open →</button>
                  </div>
                  <div
                    v-if="(item.resolved as ResolvedCde).cde_definition"
                    class="field__def"
                  >{{ (item.resolved as ResolvedCde).cde_definition }}</div>
                  <div
                    v-if="pvsForCde(item.resolved as ResolvedCde).length"
                    class="field__values"
                  >
                    <span class="field__values-label">Values:</span>
                    <span
                      v-for="pv in pvsForCde(item.resolved as ResolvedCde)"
                      :key="pv.label"
                      class="pv-pill"
                    >
                      <span v-if="pv.code" class="pv-pill__code">{{ pv.code }}</span>
                      {{ pv.label }}
                    </span>
                  </div>
                </div>
              </template>

              <template v-else-if="item.type === 'bundle' && item.resolved">
                <div class="bundle">
                  <div class="bundle__head">
                    <span class="bundle__kind">Bundle</span>
                    <router-link
                      :to="`/bundles/${(item.resolved as ResolvedBundle).id}`"
                      class="bundle__name"
                    >
                      {{ (item.resolved as ResolvedBundle).bundle_name }}
                    </router-link>
                    <span class="bundle__count">
                      {{ (item.resolved as ResolvedBundle).cdes.length }} CDEs
                    </span>
                  </div>
                  <div
                    v-if="(item.resolved as ResolvedBundle).description"
                    class="bundle__desc muted"
                  >{{ (item.resolved as ResolvedBundle).description }}</div>
                  <ul class="bundle__cdes">
                    <li
                      v-for="c in (item.resolved as ResolvedBundle).cdes"
                      :key="c.cde_name"
                      class="bundle__cde"
                    >
                      <div class="bundle__cde-row">
                        <span class="bundle__cde-name">
                          {{ c.preferred_question_text || c.cde_name }}
                        </span>
                        <span class="bundle__cde-type muted">{{ c.cde_data_type }}</span>
                        <span v-if="c.unit_of_measure" class="muted">
                          {{ c.unit_of_measure }}
                        </span>
                      </div>
                      <div
                        v-if="pvsForCde(c).length"
                        class="bundle__cde-values"
                      >
                        <span
                          v-for="pv in pvsForCde(c)"
                          :key="pv.label"
                          class="pv-pill pv-pill--compact"
                        >
                          <span v-if="pv.code" class="pv-pill__code">{{ pv.code }}</span>
                          {{ pv.label }}
                        </span>
                      </div>
                    </li>
                  </ul>
                </div>
              </template>

              <template v-else>
                <div class="missing-ref">
                  Missing reference for {{ item.type }}: <code>{{ item.ref }}</code>
                </div>
              </template>
            </div>
          </section>
        </main>
      </div>
    </template>

    <template v-else-if="!loading">
      <div class="crf-detail__not-found">
        <p>No CRF with id <code>{{ route.params.id }}</code>.</p>
        <router-link to="/crfs">← Back to CRFs</router-link>
      </div>
    </template>

    <CdeDetailDrawer v-model="cdeDrawerOpen" :cde="selectedCde" />
  </div>
</template>

<style lang="scss" scoped>
.crf-detail {
  display: flex;
  flex-direction: column;
  gap: 1rem;

  &__breadcrumbs {
    font-size: 12px;

    a {
      color: $gray_5;
      text-decoration: none;

      &:hover {
        color: $es-primary-color;
      }
    }
  }

  &__head {
    padding-bottom: 0.75rem;
    border-bottom: 1px solid $lineColor2;
  }

  &__title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;

    h1 {
      margin: 0;
    }
  }

  &__title-lead {
    display: flex;
    align-items: baseline;
    gap: 12px;
    min-width: 0;
  }

  &__actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  &__desc {
    margin-top: 0.5rem;
    color: $gray_5;
    max-width: 780px;
  }

  &__body {
    display: grid;
    grid-template-columns: 240px 1fr;
    gap: 1.5rem;

    @media (max-width: 860px) {
      grid-template-columns: 1fr;
    }
  }

  &__meta {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px;
    background: $white;
    border: 1px solid $lineColor2;
    border-radius: 2px;
    align-self: flex-start;
    position: sticky;
    top: 1rem;
  }

  &__form {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  &__instructions,
  &__items {
    background: $white;
    border: 1px solid $lineColor2;
    border-radius: 2px;
    padding: 1.25rem;

    h3 {
      margin-bottom: 0.75rem;
    }
  }

  &__not-found {
    padding: 2rem;
    text-align: center;
  }
}

.source-tag {
  display: inline-block;
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  border-radius: 2px;

  &--seeded {
    background: #eaf1fa;
    color: #1f528f;
    border-left: 2px solid #1f528f;
  }
  &--custom {
    background: #fdf3df;
    color: #7a4a05;
    border-left: 2px solid #c08b00;
  }
}

.meta-block {
  display: flex;
  flex-direction: column;
  gap: 2px;

  &__label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: $gray_4;
    font-weight: 600;
  }

  &__value {
    font-size: 13px;
    color: $gray_6;
  }
}

.markdown {
  font-size: 13px;
  line-height: 1.5;
  color: $gray_5;

  :deep(h4) {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: $gray_6;
    margin: 10px 0 4px;
  }
  :deep(h5) {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: $gray_6;
    margin: 8px 0 4px;
  }
  :deep(p) {
    margin: 0 0 6px;
  }
  :deep(ul) {
    margin: 0 0 6px;
    padding-left: 1.25rem;
  }
}

.form-item {
  & + & {
    margin-top: 10px;
  }
}

.section-break {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 1.25rem;
  margin-bottom: 0.25rem;

  &__rule {
    height: 1px;
    width: 24px;
    background: $es-primary-color;
  }

  &__label {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: $es-primary-color;
  }

  &__instructions {
    margin-bottom: 0.5rem;
    font-size: 12px;
  }
}

.field {
  border: 1px solid $lineColor2;
  border-left: 2px solid $lineColor1;
  border-radius: 2px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: $gray_1;

  &__head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    justify-content: space-between;
  }

  &__label {
    font-weight: 600;
    font-size: 14px;
    color: $gray_6;
  }

  &__type {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: $gray_4;
    white-space: nowrap;
  }

  &__meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 11px;
  }

  &__tiers {
    display: inline-flex;
    gap: 3px;
    flex-wrap: wrap;
    margin-left: auto;
  }

  &__open {
    background: none;
    border: none;
    padding: 0;
    color: $es-primary-color;
    font-size: 11px;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    font-weight: 600;

    &:hover {
      text-decoration: underline;
    }
  }

  &__def {
    font-size: 12px;
    color: $gray_5;
    line-height: 1.4;
  }

  &__unit {
    font-size: 11px;
  }

  &__values {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    margin-top: 2px;
  }

  &__values-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: $gray_4;
    font-weight: 600;
    margin-right: 4px;
  }
}

.pv-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 2px;
  font-size: 11px;
  color: $gray_6;

  &--compact {
    padding: 0 5px;
    font-size: 10px;
  }

  &__code {
    font-family: 'SF Mono', Menlo, Consolas, monospace;
    font-size: 10px;
    color: $es-primary-color;
    font-weight: 600;
  }
}

.bundle {
  border: 1px solid $lineColor2;
  border-left: 2px solid $es-primary-color;
  border-radius: 2px;
  padding: 10px 12px;
  background: $white;
  display: flex;
  flex-direction: column;
  gap: 6px;

  &__head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }

  &__kind {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-weight: 700;
    color: $es-primary-color;
  }

  &__name {
    font-weight: 600;
    font-size: 14px;
    color: $gray_6;
    text-decoration: none;

    &:hover {
      color: $es-primary-color;
      text-decoration: underline;
    }
  }

  &__count {
    font-size: 11px;
    background: $gray_2;
    color: $gray_6;
    padding: 0 6px;
    border-radius: 2px;
    font-weight: 600;
  }

  &__desc {
    font-size: 12px;
  }

  &__cdes {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  &__cde {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 3px 0 3px 12px;
    border-left: 1px solid $lineColor2;
    font-size: 12px;
  }

  &__cde-row {
    display: flex;
    gap: 10px;
    align-items: baseline;
  }

  &__cde-name {
    font-weight: 500;
    color: $gray_6;
  }

  &__cde-type {
    font-size: 11px;
  }

  &__cde-values {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }
}

.missing-ref {
  padding: 8px 10px;
  font-size: 12px;
  color: $danger;
  background: #fdecea;
  border-radius: 2px;
}
</style>
