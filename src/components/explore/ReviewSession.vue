<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useDuckDB } from '@/composables/useDuckDB';
import {
  useReviewStore,
  type ReviewTarget,
} from '@/composables/useReviewStore';
import { isActiveTier, REVIEW_FLAGS } from '@/types';
import CrfFieldPreview from './CrfFieldPreview.vue';
import type {
  DiseaseKey,
  ReviewClassification,
  ReviewFlag,
  CdeRow,
} from '@/types';

const props = defineProps<{
  targets: ReviewTarget[];
  disease: DiseaseKey;
  /** Long-form disease label, e.g. "Post-Traumatic Epilepsy". */
  diseaseLabel: string;
  /** Source label this session pulls from, e.g. "PTE Clinical CDEs". */
  sourceLabel: string;
}>();

const emit = defineEmits<{
  finish: [summary: SessionSummary];
  cancel: [];
}>();

const { query } = useDuckDB();
const { submitReview, findReview } = useReviewStore();

const idx = ref(0);
const submitting = ref(false);
const comment = ref('');
const flags = ref<Set<ReviewFlag>>(new Set());
const previousClassification = ref<ReviewClassification | null>(null);
// Currently-selected tier — picked by clicking a tier button or via 1–4
// keyboard. Submission only happens when the reviewer hits "Submit & next"
// (or Enter), so they can edit comment/flags after picking.
const selected = ref<ReviewClassification | null>(null);
const resolvedLoading = ref(false);

function toggleFlag(key: ReviewFlag) {
  const s = new Set(flags.value);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  flags.value = s;
}

export interface SessionSummary {
  classified: Record<ReviewClassification, number>;
  skipped: number;
  total: number;
}
const summary = ref<SessionSummary>({
  classified: {
    Core: 0,
    Recommended: 0,
    Supplemental: 0,
    'Not Applicable': 0,
  },
  skipped: 0,
  total: props.targets.length,
});

const current = computed<ReviewTarget | null>(() =>
  props.targets[idx.value] ?? null,
);

// ── Resolve the current target's detail data ────────────────────────────────
interface ResolvedCdeDetail {
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
  cde_domain: string | null;
  bundle_id: string | null;
  bundle_name: string | null;
  description?: string | null;
}

const resolvedCde = ref<ResolvedCdeDetail | null>(null);
const resolvedBundle = ref<{
  bundle_name: string;
  description: string | null;
  domain: string | null;
  subdomain: string | null;
  category: string | null;
  cdes: ResolvedCdeDetail[];
} | null>(null);

async function resolveCurrent() {
  resolvedCde.value = null;
  resolvedBundle.value = null;
  const t = current.value;
  if (!t) return;
  resolvedLoading.value = true;
  try {
    if (t.type === 'cde') {
      const rows = await query<ResolvedCdeDetail>(
        `SELECT cde_name, variable_name, cde_data_type, cde_definition,
                preferred_question_text, unit_of_measure, pv_labels, pv_codes,
                min_value, max_value,
                classification_agnostic, classification_neurotrauma,
                classification_tbi, classification_pte, classification_sci,
                cde_domain, bundle_id, bundle_name
         FROM cde_full WHERE cde_name = ? LIMIT 1`,
        [t.ref],
      );
      resolvedCde.value = rows[0] ?? null;
    } else {
      const bundleRows = await query<{
        bundle_name: string;
        description: string | null;
        domain: string | null;
        subdomain: string | null;
        category: string | null;
      }>(
        `SELECT bundle_name, description, domain, subdomain, category
         FROM bundle WHERE bundle_name = ? LIMIT 1`,
        [t.ref],
      );
      const cdeRows = await query<ResolvedCdeDetail>(
        `SELECT cde_name, variable_name, cde_data_type, cde_definition,
                preferred_question_text, unit_of_measure, pv_labels, pv_codes,
                min_value, max_value,
                classification_agnostic, classification_neurotrauma,
                classification_tbi, classification_pte, classification_sci,
                cde_domain, bundle_id, bundle_name
         FROM cde_full WHERE bundle_name = ? ORDER BY cde_name`,
        [t.ref],
      );
      const b = bundleRows[0];
      if (b) {
        resolvedBundle.value = { ...b, cdes: cdeRows };
      }
    }
    // Pre-fill from an existing review if the reviewer is amending — so the
    // re-review flow restores their earlier comment, flags, and shows what
    // they'd previously picked. Pre-selecting the prior tier means a reviewer
    // who only wants to amend the comment doesn't have to re-pick.
    const existing = findReview(t.type, t.ref, props.disease);
    comment.value = existing?.comment ?? '';
    flags.value = new Set(existing?.flags ?? []);
    previousClassification.value = existing?.classification ?? null;
    selected.value = existing?.classification ?? null;
  } finally {
    resolvedLoading.value = false;
  }
}

// Existing seeded classification signal for the chosen disease, when the
// reviewer wants to see what the source says today. Bundles surface the tier
// distribution of their members.
const seededBaseline = computed<string | null>(() => {
  const col = `classification_${props.disease}` as keyof ResolvedCdeDetail;
  if (resolvedCde.value) {
    return (resolvedCde.value[col] as string | null) ?? null;
  }
  if (resolvedBundle.value) {
    const counts: Record<string, number> = {};
    for (const c of resolvedBundle.value.cdes) {
      const v = (c[col] as string | null) ?? null;
      if (v) counts[v] = (counts[v] ?? 0) + 1;
    }
    if (!Object.keys(counts).length) return null;
    const ordered = ['Core', 'Recommended', 'Supplemental', 'Not Applicable'];
    return ordered
      .filter((t) => counts[t])
      .map((t) => `${t}·${counts[t]}`)
      .join(' · ');
  }
  return null;
});

// ── Actions ─────────────────────────────────────────────────────────────────
function selectTier(tier: ReviewClassification) {
  selected.value = tier;
}

async function submit() {
  const t = current.value;
  const tier = selected.value;
  if (!t || !tier || submitting.value) return;
  submitting.value = true;
  try {
    await submitReview({
      target_type: t.type,
      target_ref: t.ref,
      disease: props.disease,
      classification: tier,
      comment: comment.value.trim() || null,
      flags: [...flags.value],
    });
    summary.value.classified[tier]++;
    advance();
  } finally {
    submitting.value = false;
  }
}

function skip() {
  summary.value.skipped++;
  advance();
}

function advance() {
  comment.value = '';
  flags.value = new Set();
  previousClassification.value = null;
  selected.value = null;
  if (idx.value + 1 >= props.targets.length) {
    emit('finish', summary.value);
    return;
  }
  idx.value++;
  void resolveCurrent();
}

function previous() {
  if (idx.value === 0) return;
  // Going back doesn't undo the submitted review (it's upserted); just returns
  // to the previous card for amendment.
  idx.value--;
  void resolveCurrent();
}

// ── Keyboard shortcuts ──────────────────────────────────────────────────────
// 1–4 select a tier (no submit); Enter submits the current selection.
// Cmd/Ctrl+Enter inside the comment textarea also submits.
function onKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null;
  const inField = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT');
  // Allow Cmd/Ctrl+Enter as "submit" even from inside the comment box.
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void submit();
    return;
  }
  if (inField) return;
  if (e.key === '1') selectTier('Core');
  else if (e.key === '2') selectTier('Recommended');
  else if (e.key === '3') selectTier('Supplemental');
  else if (e.key === '4') selectTier('Not Applicable');
  else if (e.key === 'Enter') void submit();
  else if (e.key.toLowerCase() === 's') skip();
  else if (e.key === 'ArrowLeft') previous();
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  void resolveCurrent();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

const progressPct = computed(
  () => ((idx.value) / props.targets.length) * 100,
);
</script>

<template>
  <div class="review-session" v-if="current">
    <!-- Slim top strip: scope + progress + cancel. The instruction text used
         to live in its own panel; folded into a single subtle lede here so the
         item card below becomes the unambiguous focal point. -->
    <header class="session-top">
      <div class="session-top__progress">
        <div class="progress-bar">
          <div class="progress-bar__fill" :style="{ width: progressPct + '%' }" />
        </div>
        <div class="session-top__counter">{{ idx + 1 }} of {{ targets.length }}</div>
      </div>
      <el-button text @click="emit('cancel')">End session</el-button>
    </header>

    <!-- Metadata strip — supporting context only. Visually subordinate to
         the sheet below so the reviewer's eye lands on the form, not on the
         labels around it. -->
    <div class="review-meta">
      <span
        class="review-meta__kind"
        :class="current.type === 'bundle' ? 'review-meta__kind--bundle' : 'review-meta__kind--cde'"
      >{{ current.type === 'bundle' ? 'Bundle' : 'Standalone CDE' }}</span>
      <span class="disease-pill" :class="`disease-pill--${disease}`">
        {{ diseaseLabel }}
      </span>
      <template v-if="current.domain">
        <span class="review-meta__sep">·</span>
        <span class="review-meta__cell">{{ current.domain }}</span>
      </template>
      <template v-if="seededBaseline">
        <span class="review-meta__sep">·</span>
        <span class="review-meta__cell">
          Current tier: <strong>{{ seededBaseline }}</strong>
        </span>
      </template>
      <template v-if="previousClassification">
        <span class="review-meta__sep">·</span>
        <span class="review-meta__cell review-meta__cell--prior">
          Your prior: <strong>{{ previousClassification }}</strong>
        </span>
      </template>
    </div>

    <!-- Paper sheet — the form preview itself, styled like a printed CRF
         page so the reviewer immediately reads it as "this is what a data
         collector sees" rather than just another metadata block. -->
    <article class="crf-sheet" v-loading="resolvedLoading">
      <header class="crf-sheet__header">
        <div class="crf-sheet__header-rule" />
        <h2 class="crf-sheet__title">{{ sourceLabel }} — Review CRF</h2>
        <div class="crf-sheet__sublabel">
          Reviewing for <strong>{{ diseaseLabel }}</strong> ·
          {{ current.type === 'bundle' ? 'Bundle' : 'Standalone CDE' }} preview
        </div>
      </header>

      <div class="crf-sheet__body">
        <!-- CDE: single field. The CDE's own name surfaces as the field
             label inside CrfFieldPreview (preferred_question_text ||
             cde_name), so we don't restate it as a section heading. -->
        <CrfFieldPreview v-if="resolvedCde" :cde="resolvedCde" />

        <!-- Bundle: bundle name + optional description as a section
             heading, then each member CDE rendered as its own form field. -->
        <template v-else-if="resolvedBundle">
          <div class="crf-sheet__section-head">
            <h3 class="crf-sheet__section-title">{{ resolvedBundle.bundle_name }}</h3>
            <p v-if="resolvedBundle.description" class="crf-sheet__intro">
              {{ resolvedBundle.description }}
            </p>
          </div>
          <div class="crf-sheet__bundle">
            <CrfFieldPreview
              v-for="c in resolvedBundle.cdes"
              :key="c.cde_name"
              :cde="c"
              compact
            />
          </div>
        </template>
      </div>

      <footer class="crf-sheet__footer">
        <span class="crf-sheet__watermark">PREVIEW · not for data entry</span>
      </footer>
    </article>

    <!-- Decision panel: the reviewer's action. Visually quieter than the item
         card so the focus stays on the reviewed item until the reviewer is
         ready to act. The rank-prompt re-states the context immediately
         above the tier buttons — same CDE can be Core for one disease and
         Supplemental for another, so this priming line matters. -->
    <aside class="decision-panel">
      <div class="rank-prompt">
        Rank this
        <span class="rank-prompt__kind">{{ current.type === 'bundle' ? 'Bundle' : 'CDE' }}</span>
        for
        <span class="rank-prompt__disease">{{ diseaseLabel }}</span>
      </div>
      <div class="tier-buttons">
        <button
          class="tier-btn tier-btn--core"
          :class="{ 'tier-btn--selected': selected === 'Core' }"
          @click="selectTier('Core')"
        >
          <span class="tier-btn__key">1</span>
          <span class="tier-btn__label">Core</span>
        </button>
        <button
          class="tier-btn tier-btn--recommended"
          :class="{ 'tier-btn--selected': selected === 'Recommended' }"
          @click="selectTier('Recommended')"
        >
          <span class="tier-btn__key">2</span>
          <span class="tier-btn__label">Recommended</span>
        </button>
        <button
          class="tier-btn tier-btn--supplemental"
          :class="{ 'tier-btn--selected': selected === 'Supplemental' }"
          @click="selectTier('Supplemental')"
        >
          <span class="tier-btn__key">3</span>
          <span class="tier-btn__label">Supplemental</span>
        </button>
        <button
          class="tier-btn tier-btn--na"
          :class="{ 'tier-btn--selected': selected === 'Not Applicable' }"
          @click="selectTier('Not Applicable')"
        >
          <span class="tier-btn__key">4</span>
          <span class="tier-btn__label">Not Applicable</span>
        </button>
      </div>

      <!-- Flags as a chip strip directly under the tier buttons. No header —
           chips have hover tooltips. -->
      <div class="flag-strip">
        <el-tooltip
          v-for="f in REVIEW_FLAGS"
          :key="f.key"
          :content="f.description"
          placement="top"
          :show-after="200"
          effect="dark"
        >
          <button
            type="button"
            class="flag-chip"
            :class="{ 'flag-chip--active': flags.has(f.key) }"
            @click="toggleFlag(f.key)"
          >
            {{ f.label }}
          </button>
        </el-tooltip>
      </div>

      <el-input
        v-model="comment"
        type="textarea"
        :rows="2"
        placeholder="Add a note (optional) — rationale, caveats, or disagreement"
      />

      <footer class="decision-panel__footer">
        <el-button text @click="previous" :disabled="idx === 0">← Previous</el-button>
        <el-button @click="skip">Skip <span class="kbd">S</span></el-button>
        <el-button
          type="primary"
          :disabled="!selected || submitting"
          :loading="submitting"
          @click="submit"
        >
          Submit &amp; next <span class="kbd">⏎</span>
        </el-button>
        <div class="decision-panel__hint muted">1–4 pick · ⏎ submit · S skip · ← previous</div>
      </footer>
    </aside>
  </div>
</template>

<style lang="scss" scoped>
.review-session {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

// Slim top strip: scope eyebrow + progress + cancel. No panel chrome — keeps
// visual weight off so the item card below is unambiguously the focal point.
.session-top {
  display: flex;
  align-items: center;
  gap: 12px;

  &__progress {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  &__counter {
    flex: 0 0 auto;
    font-size: 11px;
    color: $gray_5;
    white-space: nowrap;
  }
}

.progress-bar {
  height: 6px;
  background: $gray_2;
  border-radius: 2px;
  overflow: hidden;

  &__fill {
    height: 100%;
    background: $es-primary-color;
    transition: width 200ms ease;
  }
}

// Disease badge palette — small color-coded pill indicating the disease
// the current session is scoped to. Same colors used elsewhere on /review.
.disease-pill {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 2px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;

  &--pte         { background: #e0e7ff; color: #3730a3; }
  &--tbi         { background: #fdebd5; color: #b45309; }
  &--sci         { background: #d8f5f3; color: #0e7d7b; }
  &--neurotrauma { background: #e3e8ee; color: #475569; }
  &--epilepsy    { background: #efe5ff; color: #6d28d9; }
  &--agnostic    { background: #e8eef7; color: #1f528f; }
}

// Metadata strip — supporting context only. Compact, low-contrast row that
// sits above the paper sheet so the reviewer reads it as labels, not as
// content. No background, no border — just text in a row.
.review-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: $gray_5;
  text-transform: uppercase;
  letter-spacing: 0.4px;

  &__sep {
    color: $gray_3;
  }

  &__kind {
    padding: 2px 8px;
    border-radius: 2px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.5px;

    &--bundle {
      background: #f0f6fc;
      color: $es-primary-color;
    }
    &--cde {
      background: $gray_1;
      color: $gray_6;
    }
  }

  &__progress {
    font-weight: 600;
    color: $gray_5;
  }

  &__cell {
    color: $gray_5;
    text-transform: none;
    letter-spacing: 0;
    font-size: 12px;

    strong {
      color: $gray_6;
      font-weight: 600;
    }

    &--prior {
      padding: 1px 8px;
      background: #fef7e6;
      border: 1px solid #f1d68a;
      border-radius: 2px;
      color: #7a4a05;

      strong { color: #5a3603; }
    }
  }
}

// Paper sheet — styled like a printed CRF page. White surface, soft drop
// shadow, faux header bar with a colored hairline rule. This is the focal
// element of the page; everything else is subordinate.
.crf-sheet {
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  margin: 0.5rem 0 1rem;
  overflow: hidden;

  &__header {
    padding: 22px 28px 18px;
    border-bottom: 1px solid $lineColor2;
    background: linear-gradient(180deg, #fafbfc 0%, $white 100%);
    position: relative;
  }

  &__header-rule {
    position: absolute;
    top: 0;
    left: 28px;
    width: 80px;
    height: 3px;
    background: $es-primary-color;
  }

  &__title {
    margin: 4px 0 4px;
    font-size: 22px;
    font-weight: 700;
    color: $gray_6;
    letter-spacing: -0.2px;
    line-height: 1.3;
  }

  &__sublabel {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: $gray_4;
    font-weight: 600;
  }

  &__body {
    padding: 22px 28px 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  &__section-head {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-bottom: 8px;
    border-bottom: 1px solid $lineColor2;
  }

  &__section-title {
    margin: 0;
    font-size: 14px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: $gray_6;
  }

  &__intro {
    margin: 0;
    font-size: 13px;
    color: $gray_5;
    line-height: 1.55;
  }

  &__bundle {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  &__footer {
    display: flex;
    justify-content: flex-end;
    padding: 10px 28px 14px;
    border-top: 1px dashed $lineColor2;
    background: #fafbfc;
  }

  &__watermark {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: $gray_4;
    font-weight: 600;
  }
}

// Decision panel — visually quieter than the item card. No accent stripe, no
// header/subhead. The four tier buttons are the action; everything else is
// secondary affordance below them.
.decision-panel {
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 2px;
  padding: 1.25rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;

  &__footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 0.25rem;
  }

  &__hint {
    margin-left: auto;
    font-size: 11px;
  }
}

// Persistent context line right above the tier buttons. Re-asserts WHAT is
// being classified and FOR WHICH disease — so the reviewer can't accidentally
// apply, say, an "obviously Core for TBI" reflex when the current scope is
// actually PTE.
.rank-prompt {
  font-size: 15px;
  color: $gray_5;
  font-weight: 500;

  &__kind {
    font-weight: 700;
    color: $gray_6;
  }

  &__disease {
    font-weight: 700;
    color: $es-primary-color;
  }
}

// Hero affordance: four big tier buttons.
.tier-buttons {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.tier-btn {
  padding: 16px 14px;
  border: 1px solid $lineColor2;
  border-left-width: 4px;
  background: $white;
  border-radius: 2px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  transition: border-color 80ms ease, background 80ms ease, transform 80ms ease;

  &:hover {
    background: $gray_1;
    transform: translateY(-1px);
  }

  &__key {
    display: inline-flex;
    width: 22px;
    height: 22px;
    align-items: center;
    justify-content: center;
    background: $gray_2;
    color: $gray_6;
    font-size: 11px;
    font-weight: 700;
    border-radius: 2px;
  }

  &__label {
    font-size: 14px;
    font-weight: 600;
    color: $gray_6;
  }

  &--core {
    border-left-color: #2d6b3a;
    &:hover { background: #e8f3ec; }
    &.tier-btn--selected {
      background: #e8f3ec;
      border-color: #2d6b3a;
      box-shadow: inset 0 0 0 1px #2d6b3a;
    }
  }
  &--recommended {
    border-left-color: #1f528f;
    &:hover { background: #eaf1fa; }
    &.tier-btn--selected {
      background: #eaf1fa;
      border-color: #1f528f;
      box-shadow: inset 0 0 0 1px #1f528f;
    }
  }
  &--supplemental {
    border-left-color: #7a4a05;
    &:hover { background: #fdf3df; }
    &.tier-btn--selected {
      background: #fdf3df;
      border-color: #7a4a05;
      box-shadow: inset 0 0 0 1px #7a4a05;
    }
  }
  &--na {
    border-left-color: $gray_4;
    &:hover { background: $gray_1; }
    &.tier-btn--selected {
      background: $gray_1;
      border-color: $gray_5;
      box-shadow: inset 0 0 0 1px $gray_5;
    }
  }

  // Selected state — common: lift the key chip slightly so it reads as "active"
  &--selected &__key {
    background: $white;
  }
}

// Flags as a chip strip directly under the tier buttons. No header — the
// chips speak for themselves and have hover tooltips for detail.
.flag-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.flag-chip {
  border: 1px solid $lineColor2;
  background: $white;
  color: $gray_5;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 500;
  border-radius: 2px;
  cursor: pointer;
  transition: background 80ms ease, border-color 80ms ease, color 80ms ease;

  &:hover {
    border-color: $gray_3;
    color: $gray_6;
  }

  &--active {
    background: #fef7e6;
    border-color: #c08b00;
    color: #7a4a05;

    &:hover {
      background: #fdf0d3;
      border-color: #c08b00;
      color: #7a4a05;
    }
  }
}

.kbd {
  display: inline-block;
  margin-left: 6px;
  padding: 0 5px;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 10px;
  background: $gray_1;
  border: 1px solid $lineColor1;
  border-bottom-width: 2px;
  border-radius: 3px;
  color: $gray_6;
  line-height: 1.5;
}

</style>
