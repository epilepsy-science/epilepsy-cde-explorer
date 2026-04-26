<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useDuckDB } from '@/composables/useDuckDB';
import {
  useReviewStore,
  type ReviewTarget,
} from '@/composables/useReviewStore';
import { isActiveTier, splitPipe, REVIEW_FLAGS } from '@/types';
import type {
  DiseaseKey,
  ReviewClassification,
  ReviewFlag,
  CdeRow,
} from '@/types';

const props = defineProps<{
  targets: ReviewTarget[];
  disease: DiseaseKey;
  diseaseLabel: string;
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
    // they'd previously picked.
    const existing = findReview(t.type, t.ref, props.disease);
    comment.value = existing?.comment ?? '';
    flags.value = new Set(existing?.flags ?? []);
    previousClassification.value = existing?.classification ?? null;
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

// Permissible values for a single CDE.
function pvsForCde(c: ResolvedCdeDetail) {
  const labels = splitPipe(c.pv_labels);
  const codes = splitPipe(c.pv_codes);
  return labels.map((label, i) => ({ label, code: codes[i] ?? null }));
}

// ── Actions ─────────────────────────────────────────────────────────────────
async function classify(tier: ReviewClassification) {
  const t = current.value;
  if (!t || submitting.value) return;
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
function onKeydown(e: KeyboardEvent) {
  // Ignore when the comment box has focus.
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) {
    return;
  }
  if (e.key === '1') classify('Core');
  else if (e.key === '2') classify('Recommended');
  else if (e.key === '3') classify('Supplemental');
  else if (e.key === '4') classify('Not Applicable');
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
      <div class="session-top__scope">
        <span class="session-top__eyebrow">Reviewing for</span>
        <span class="session-top__disease">{{ diseaseLabel }}</span>
        <el-tooltip
          placement="top"
          effect="dark"
          :content="`Pick the tier that best reflects how essential this is for ${diseaseLabel} studies. Bundles are reviewed as a unit — all CDEs inside are governed by your tier. Add a comment if your pick differs from the current NT-PRECEDS classification.`"
        >
          <el-icon class="session-top__help"><InfoFilled /></el-icon>
        </el-tooltip>
      </div>
      <div class="session-top__progress">
        <div class="progress-bar">
          <div class="progress-bar__fill" :style="{ width: progressPct + '%' }" />
        </div>
        <div class="session-top__counter">{{ idx + 1 }} of {{ targets.length }}</div>
      </div>
      <el-button text @click="emit('cancel')">End session</el-button>
    </header>

    <!-- THE thing being reviewed — visually elevated so the eye can't miss it. -->
    <article class="item-card" v-loading="resolvedLoading">
      <div class="item-card__topline">
        <span class="item-card__eyebrow">
          <span
            class="item-card__kind"
            :class="current.type === 'bundle' ? 'item-card__kind--bundle' : 'item-card__kind--cde'"
          >{{ current.type === 'bundle' ? 'Bundle' : 'Standalone CDE' }}</span>
          <span class="item-card__sep">·</span>
          Reviewing item {{ idx + 1 }} of {{ targets.length }}
        </span>
        <span v-if="previousClassification" class="item-card__prior">
          Your prior: <strong>{{ previousClassification }}</strong>
        </span>
      </div>

      <h2 class="item-card__title">{{ current.title }}</h2>
      <div v-if="current.domain" class="item-card__domain">{{ current.domain }}</div>

      <!-- CDE body -->
      <section v-if="resolvedCde" class="card-body">
        <div class="field-preview">
          <div class="field-preview__label">
            {{ resolvedCde.preferred_question_text || resolvedCde.cde_name }}
            <span class="field-preview__type">{{ resolvedCde.cde_data_type }}</span>
          </div>
          <div v-if="resolvedCde.cde_definition" class="field-preview__def">
            {{ resolvedCde.cde_definition }}
          </div>
          <div
            v-if="pvsForCde(resolvedCde).length"
            class="field-preview__pvs"
          >
            <span class="field-preview__pvs-label">Values:</span>
            <span
              v-for="pv in pvsForCde(resolvedCde)"
              :key="pv.label"
              class="pv-pill"
            >
              <span v-if="pv.code" class="pv-pill__code">{{ pv.code }}</span>
              {{ pv.label }}
            </span>
          </div>
          <div v-if="resolvedCde.unit_of_measure" class="field-preview__unit muted">
            Unit: {{ resolvedCde.unit_of_measure }}
          </div>
        </div>
      </section>

      <!-- Bundle body -->
      <section v-else-if="resolvedBundle" class="card-body">
        <p v-if="resolvedBundle.description" class="card-desc">
          {{ resolvedBundle.description }}
        </p>
        <ul class="bundle-cdes">
          <li v-for="c in resolvedBundle.cdes" :key="c.cde_name" class="bundle-cde">
            <div class="bundle-cde__row">
              <span class="bundle-cde__name">
                {{ c.preferred_question_text || c.cde_name }}
              </span>
              <span class="bundle-cde__type muted">{{ c.cde_data_type }}</span>
              <span v-if="c.unit_of_measure" class="muted">
                {{ c.unit_of_measure }}
              </span>
            </div>
            <div
              v-if="pvsForCde(c).length"
              class="bundle-cde__pvs"
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
      </section>

      <!-- Context — current published tier (if any) -->
      <section class="card-context" v-if="seededBaseline">
        <span class="card-context__label">Current NT-PRECEDS tier for {{ diseaseLabel }}:</span>
        <span class="card-context__value">{{ seededBaseline }}</span>
      </section>
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
        <button class="tier-btn tier-btn--core" @click="classify('Core')">
          <span class="tier-btn__key">1</span>
          <span class="tier-btn__label">Core</span>
        </button>
        <button class="tier-btn tier-btn--recommended" @click="classify('Recommended')">
          <span class="tier-btn__key">2</span>
          <span class="tier-btn__label">Recommended</span>
        </button>
        <button class="tier-btn tier-btn--supplemental" @click="classify('Supplemental')">
          <span class="tier-btn__key">3</span>
          <span class="tier-btn__label">Supplemental</span>
        </button>
        <button class="tier-btn tier-btn--na" @click="classify('Not Applicable')">
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
        <div class="decision-panel__hint muted">← previous · S skip</div>
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
  gap: 1.25rem;

  &__scope {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    padding-left: 12px;
    border-left: 3px solid $es-primary-color;
  }

  &__eyebrow {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: $gray_4;
    font-weight: 600;
  }

  &__disease {
    font-size: 17px;
    font-weight: 700;
    color: $gray_6;
    letter-spacing: -0.1px;
  }

  &__help {
    font-size: 14px;
    color: $gray_4;
    cursor: help;
    align-self: center;
  }

  &__progress {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  &__counter {
    font-size: 11px;
    color: $gray_5;
    text-align: right;
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

// Item card — the hero of the screen. The only surface that carries the green
// accent and a soft drop shadow, so the eye lands here without ambiguity.
.item-card {
  background: $white;
  border: 1px solid $lineColor2;
  border-left: 3px solid $es-primary-color;
  border-radius: 2px;
  padding: 1.5rem 1.75rem 1.75rem;
  margin: 0.5rem 0;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.05);
  display: flex;
  flex-direction: column;
  gap: 1rem;

  &__topline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  &__eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: $gray_4;
    font-weight: 600;
  }

  &__sep {
    color: $gray_3;
  }

  &__kind {
    padding: 2px 7px;
    border-radius: 2px;
    font-size: 10px;
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

  // Prior classification surfaces here as a small pill — about the *item*, not
  // the action, so it lives near the title rather than buried in the panel.
  &__prior {
    font-size: 12px;
    color: #7a4a05;
    background: #fef7e6;
    border: 1px solid #f1d68a;
    padding: 3px 10px;
    border-radius: 12px;

    strong {
      font-weight: 700;
      color: #5a3603;
    }
  }

  &__title {
    margin: 0;
    font-size: 24px;
    font-weight: 700;
    color: $gray_6;
    line-height: 1.25;
    letter-spacing: -0.2px;
  }

  &__domain {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: $gray_4;
    margin-top: -2px;
  }
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.card-desc {
  margin: 0;
  font-size: 13px;
  color: $gray_5;
  line-height: 1.5;
}

.field-preview {
  border: 1px solid $lineColor2;
  border-left: 2px solid $es-primary-color;
  border-radius: 2px;
  padding: 12px 14px;
  background: $gray_1;
  display: flex;
  flex-direction: column;
  gap: 6px;

  &__label {
    font-weight: 600;
    font-size: 15px;
    color: $gray_6;
    display: flex;
    align-items: baseline;
    gap: 10px;
    justify-content: space-between;
  }

  &__type {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: $gray_4;
  }

  &__def {
    font-size: 13px;
    color: $gray_5;
    line-height: 1.5;
  }

  &__pvs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }

  &__pvs-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: $gray_4;
    font-weight: 600;
    margin-right: 4px;
  }

  &__unit {
    font-size: 11px;
  }
}

.bundle-cdes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bundle-cde {
  padding: 6px 10px;
  border-left: 1px solid $lineColor2;
  background: $gray_1;
  border-radius: 2px;

  &__row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 13px;
  }

  &__name {
    font-weight: 500;
    color: $gray_6;
  }

  &__type {
    font-size: 11px;
  }

  &__pvs {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    margin-top: 2px;
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

.card-context {
  font-size: 12px;
  color: $gray_5;
  display: flex;
  gap: 6px;
  align-items: baseline;

  &__label {
    text-transform: uppercase;
    letter-spacing: 0.4px;
    font-weight: 600;
    font-size: 10px;
    color: $gray_4;
  }

  &__value {
    color: $gray_6;
    font-weight: 500;
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
  }
  &--recommended {
    border-left-color: #1f528f;
    &:hover { background: #eaf1fa; }
  }
  &--supplemental {
    border-left-color: #7a4a05;
    &:hover { background: #fdf3df; }
  }
  &--na {
    border-left-color: $gray_4;
    &:hover { background: $gray_1; }
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
  border-radius: 12px;
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
