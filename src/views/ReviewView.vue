<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElNotification } from 'element-plus';
import { useDuckDB } from '@/composables/useDuckDB';
import {
  useReviewStore,
  type ReviewTarget,
  type ReviewableSource,
} from '@/composables/useReviewStore';
import { DISEASE_OPTIONS, useDiseaseLens } from '@/composables/useDiseaseLens';
import { ApiError, api, apiToken, setToken, unwrap } from '@/api/client';
import { getRecaptchaToken } from '@/api/recaptcha';
import ReviewSession, { type SessionSummary } from '@/components/explore/ReviewSession.vue';
import type { DiseaseKey } from '@/types';

const { status } = useDuckDB();
const {
  reviewer,
  saveReviewer,
  ensureLoaded,
  logout,
  selectSessionTargets,
  coverageFor,
  reviewableSources,
  myReviews,
} = useReviewStore();
const { lens } = useDiseaseLens();

// ── Auth gate ───────────────────────────────────────────────────────────────
// The Review page is the ONE place in the dashboard that requires auth. CDE
// and CRF browse stays public. Two states this view can land in when the
// page first opens:
//   1. No JWT in localStorage → show email-input → code-input flow.
//   2. JWT present → fetch /v1/me; if 404, fall through to profile setup;
//      otherwise jump straight to the reviewer landing.
type AuthStep = 'email' | 'code' | 'authed';
const authStep = ref<AuthStep>(apiToken.value ? 'authed' : 'email');
const authLoading = ref(false);
const authEmail = ref('');
const authCode = ref('');
const authError = ref<string | null>(null);

watch(apiToken, (t) => {
  authStep.value = t ? 'authed' : 'email';
  if (!t) {
    authEmail.value = '';
    authCode.value = '';
    authError.value = null;
  }
});

async function requestCode() {
  authError.value = null;
  const email = authEmail.value.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    authError.value = 'Please enter a valid email address.';
    return;
  }
  authLoading.value = true;
  try {
    const recaptcha_token = await getRecaptchaToken('request_code');
    await unwrap(api.POST('/v1/auth/request-code', { body: { email, recaptcha_token } }));
    authStep.value = 'code';
  } catch (e) {
    authError.value = (e as ApiError).message ?? 'Could not send code.';
  } finally {
    authLoading.value = false;
  }
}

async function verifyCode() {
  authError.value = null;
  const email = authEmail.value.trim().toLowerCase();
  const code = authCode.value.trim();
  if (!/^\d{6}$/.test(code)) {
    authError.value = 'Code must be 6 digits.';
    return;
  }
  authLoading.value = true;
  try {
    const result = await unwrap(
      api.POST('/v1/auth/verify-code', { body: { email, code } }),
    );
    setToken(result.token);
    // Token watch in useReviewStore wipes cache, so ensureLoaded refetches.
    await ensureLoaded();
    authStep.value = 'authed';
    if (reviewer.value?.primary_diseases?.length) {
      lens.value = reviewer.value.primary_diseases[0];
    }
  } catch (e) {
    if (e instanceof ApiError) {
      authError.value =
        e.code === 'invalid_code'
          ? 'Code is incorrect or expired. Try again or request a new one.'
          : e.message;
    } else {
      authError.value = 'Verification failed. Please try again.';
    }
  } finally {
    authLoading.value = false;
  }
}

function backToEmail() {
  authStep.value = 'email';
  authCode.value = '';
  authError.value = null;
}

// ── Profile setup ───────────────────────────────────────────────────────────

type StudyTypePref = 'Clinical' | 'Preclinical' | null;
const editing = ref(false);
const form = ref({
  name: '',
  linkedin_url: '',
  primary_diseases: [] as DiseaseKey[],
  primary_study_type: null as StudyTypePref,
});

onMounted(async () => {
  // If we landed with a token, sync from server. ensureLoaded is safe to
  // call even if the user isn't auth'd — it no-ops without a token.
  await ensureLoaded();
  if (reviewer.value) {
    form.value = {
      name: reviewer.value.name,
      linkedin_url: reviewer.value.linkedin_url ?? '',
      primary_diseases: [...reviewer.value.primary_diseases],
      primary_study_type: reviewer.value.primary_study_type,
    };
  }
});

function startEditing() {
  if (reviewer.value) {
    form.value = {
      name: reviewer.value.name,
      linkedin_url: reviewer.value.linkedin_url ?? '',
      primary_diseases: [...reviewer.value.primary_diseases],
      primary_study_type: reviewer.value.primary_study_type,
    };
  }
  editing.value = true;
}

async function saveProfile() {
  const name = form.value.name.trim();
  if (!name) {
    ElNotification({ type: 'warning', title: 'Name is required' });
    return;
  }
  if (!form.value.primary_diseases.length) {
    ElNotification({ type: 'warning', title: 'Pick at least one disease' });
    return;
  }
  try {
    await saveReviewer({
      name,
      linkedin_url: form.value.linkedin_url.trim() || null,
      primary_diseases: form.value.primary_diseases,
      primary_study_type: form.value.primary_study_type,
    });
    editing.value = false;
    lens.value = form.value.primary_diseases[0];
  } catch (e) {
    ElNotification({
      type: 'error',
      title: 'Could not save profile',
      message: e instanceof ApiError ? e.message : 'Unexpected error',
    });
  }
}

// ── Session launch ──────────────────────────────────────────────────────────

// The dashboard config drives which sources are currently open for review.
// Each session targets ONE source; a "Next source" button cycles through
// the list when more than one is active so a reviewer can do a few sessions
// per source over time.
const sources = ref<ReviewableSource[]>([]);
const activeSourceIdx = ref(0);

async function refreshSources() {
  if (status.value !== 'ready') return;
  sources.value = await reviewableSources();
  if (activeSourceIdx.value >= visibleSources.value.length) activeSourceIdx.value = 0;
}

// Filter the (source, disease) pairs to the diseases the active reviewer
// has indicated as their expertise. Visitors who aren't authed see every
// pair (informational only). Admins see all.
const visibleSources = computed<ReviewableSource[]>(() => {
  if (!reviewer.value || reviewer.value.role === 'admin') return sources.value;
  const expertise = new Set<string>(reviewer.value.primary_diseases ?? []);
  if (!expertise.size) return [];
  return sources.value.filter((s) => expertise.has(s.disease));
});

const activeSource = computed<ReviewableSource | null>(() => {
  if (!visibleSources.value.length) return null;
  return visibleSources.value[activeSourceIdx.value % visibleSources.value.length];
});

function nextSource() {
  if (visibleSources.value.length < 2) return;
  activeSourceIdx.value =
    (activeSourceIdx.value + 1) % visibleSources.value.length;
}

const sessionForm = ref({
  limit: 20,
  includeReviewed: false,
});
const sessionTargets = ref<ReviewTarget[] | null>(null);
const loadingSession = ref(false);
const completedSummary = ref<SessionSummary | null>(null);

async function startSession() {
  if (!reviewer.value || !activeSource.value) return;
  loadingSession.value = true;
  completedSummary.value = null;
  try {
    const targets = await selectSessionTargets({
      source: activeSource.value.key,
      disease: activeSource.value.disease,
      limit: sessionForm.value.limit,
      includeReviewed: sessionForm.value.includeReviewed,
    });
    if (targets.length === 0) {
      ElNotification({
        type: 'info',
        title: 'Nothing to review',
        message:
          'No remaining items in this source match the current scope. Try the next source.',
      });
      return;
    }
    sessionTargets.value = targets;
  } finally {
    loadingSession.value = false;
  }
}

function onFinish(summary: SessionSummary) {
  completedSummary.value = summary;
  sessionTargets.value = null;
  void refreshCoverage();
}

function onCancel() {
  sessionTargets.value = null;
}

// ── Coverage chip ───────────────────────────────────────────────────────────

interface CoverageBlock {
  reviewed: number;
  total: number;
}
const coverage = ref<CoverageBlock>({ reviewed: 0, total: 0 });

async function refreshCoverage() {
  if (!reviewer.value || status.value !== 'ready' || !activeSource.value) {
    coverage.value = { reviewed: 0, total: 0 };
    return;
  }
  coverage.value = await coverageFor(
    activeSource.value.key,
    activeSource.value.disease,
  );
}

watch(
  [reviewer, activeSource, status, myReviews],
  () => {
    void refreshCoverage();
  },
  { immediate: true },
);

watch(
  [reviewer, status],
  () => {
    void refreshSources();
  },
  { immediate: true },
);

const coveragePct = computed(() =>
  coverage.value.total
    ? Math.round((coverage.value.reviewed / coverage.value.total) * 100)
    : 0,
);
const remaining = computed(() => Math.max(0, coverage.value.total - coverage.value.reviewed));

const sourceLabel = computed(() => activeSource.value?.label ?? 'No source under review');
const activeDiseaseKey = computed<DiseaseKey>(
  () => activeSource.value?.disease ?? 'agnostic',
);
const activeDiseaseLongLabel = computed(
  () =>
    DISEASE_OPTIONS.find((o) => o.key === activeDiseaseKey.value)?.longLabel ??
    activeDiseaseKey.value,
);

function diseaseShortLabel(key: DiseaseKey | undefined): string {
  if (!key) return '';
  return DISEASE_OPTIONS.find((o) => o.key === key)?.label ?? String(key);
}

const selectableDiseases = DISEASE_OPTIONS.filter((o) => o.key !== 'all');
</script>

<template>
  <div class="review">
    <!-- Active session takes over the page -->
    <ReviewSession
      v-if="sessionTargets"
      :targets="sessionTargets"
      :disease="activeDiseaseKey"
      :disease-label="activeDiseaseLongLabel"
      :source-label="sourceLabel"
      @finish="onFinish"
      @cancel="onCancel"
    />

    <template v-else>
      <!-- Page header: matches CDEs/CRFs/Home treatment -->
      <header class="review__header page-header">
        <div>
          <h1>Review</h1>
          <p class="lede">
            Provide expert feedback on <strong>non-validated CDEs</strong>.
            Many elements in the library are still draft or unclassified for
            specific diseases. Your domain expertise helps us tier them as
            <strong>Core</strong>, <strong>Recommended</strong>, or
            <strong>Supplemental</strong> — the next published baseline of
            recommendations is assembled from your reviews.
          </p>
        </div>
      </header>

      <!-- Reviewer identity strip — only shown when authed. Sits at the top
           of the page (above the sources banner) so the user-context lives
           where users expect it, instead of being awkwardly tucked between
           the source picker and the session launcher below. -->
      <section
        v-if="authStep === 'authed' && reviewer"
        class="reviewer-bar"
      >
        <div class="reviewer-bar__avatar" :title="reviewer.name">
          {{ reviewer.name.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '·' }}
        </div>
        <div class="reviewer-bar__identity">
          <div class="reviewer-bar__name">
            {{ reviewer.name }}
            <a
              v-if="reviewer.linkedin_url"
              :href="reviewer.linkedin_url"
              target="_blank"
              rel="noopener noreferrer"
              class="reviewer-bar__linkedin"
              :title="reviewer.linkedin_url"
            >LinkedIn ↗</a>
          </div>
          <div class="reviewer-bar__scope subtle">
            <span
              v-for="dk in reviewer?.primary_diseases ?? []"
              :key="dk"
              class="reviewer-bar__disease-chip"
            >{{ DISEASE_OPTIONS.find((o) => o.key === dk)?.label ?? dk }}</span>
            <span class="reviewer-bar__sep">·</span>
            <span>{{ reviewer?.primary_study_type ?? 'Clinical & preclinical' }}</span>
          </div>
        </div>
        <div class="reviewer-bar__actions">
          <el-button text size="small" @click="startEditing">Edit profile</el-button>
          <el-button text size="small" @click="logout">Sign out</el-button>
        </div>
      </section>

      <!-- Progress stat band — at-a-glance for the active source. Sits
           between the reviewer identity strip and the source picker so the
           page reads top-down: who you are → how you're doing → what's
           available → what to do next. -->
      <section
        v-if="authStep === 'authed' && reviewer && activeSource"
        class="progress-band"
      >
        <div class="progress-card progress-card--lead">
          <div class="progress-card__value">{{ coveragePct }}%</div>
          <div class="progress-card__label">Reviewed in scope</div>
          <div class="progress-card__meta">{{ sourceLabel }}</div>
        </div>
        <div class="progress-card">
          <div class="progress-card__value">{{ coverage.reviewed.toLocaleString() }}</div>
          <div class="progress-card__label">Items you've reviewed</div>
          <div class="progress-card__meta muted">across all sessions</div>
        </div>
        <div class="progress-card">
          <div class="progress-card__value">{{ remaining.toLocaleString() }}</div>
          <div class="progress-card__label">Items remaining</div>
          <div class="progress-card__meta muted">in current scope</div>
        </div>
        <div class="progress-card progress-card--bar">
          <div class="progress-card__label">Coverage</div>
          <div class="coverage-bar">
            <div class="coverage-bar__fill" :style="{ width: coveragePct + '%' }" />
          </div>
          <div class="progress-card__meta muted">
            {{ coverage.reviewed }} / {{ coverage.total }}
          </div>
        </div>
      </section>

      <!-- "Currently under review" banner — visible at every auth step
           (signed-out, code-entry, profile-setup, reviewer-landing) so
           visitors can see which datasets are open for review before they
           commit to signing in. The chip is interactive only for
           authenticated reviewers (it sets the active source for the
           session launcher); pre-auth it's purely informational. -->
      <section v-if="sources.length" class="sources-banner">
        <div class="sources-banner__head">
          <h2 v-if="authStep === 'authed' && reviewer">
            Available for your expertise
          </h2>
          <h2 v-else>Currently under review</h2>
          <p class="subtle">
            <template v-if="authStep === 'authed' && reviewer && visibleSources.length">
              These (dataset · disease) pairs match the disease expertise
              you set in your profile. Pick one to start a session —
              sessions are scoped to a single disease so tier decisions
              don't blur across them.
            </template>
            <template v-else-if="authStep === 'authed' && reviewer && !visibleSources.length">
              Nothing matches your disease expertise right now. Update your
              profile to add another disease, or check back as new sources
              open up.
            </template>
            <template v-else>
              These datasets are open for community review, scoped per
              disease. <strong>Sign in below</strong> to start a session —
              we'll filter to the diseases you're an expert in.
            </template>
          </p>
        </div>
        <div class="sources-banner__grid">
          <!-- Authenticated reviewer view: only chips matching their
               primary_diseases, fully interactive. -->
          <template v-if="authStep === 'authed' && reviewer">
            <button
              v-for="(s, i) in visibleSources"
              :key="s.id"
              type="button"
              class="source-chip"
              :class="[
                { 'source-chip--active': i === activeSourceIdx },
                `source-chip--disease-${s.disease}`,
              ]"
              @click="activeSourceIdx = i"
            >
              <div class="source-chip__label">{{ s.label }}</div>
              <div class="source-chip__badges">
                <span
                  class="source-chip__disease"
                  :class="`disease-pill disease-pill--${s.disease}`"
                >{{ diseaseShortLabel(s.disease) }}</span>
                <span v-if="s.study_type" class="source-chip__study">{{ s.study_type }}</span>
              </div>
              <div class="source-chip__count">
                {{ s.target_count }} item{{ s.target_count === 1 ? '' : 's' }}
              </div>
            </button>
          </template>

          <!-- Pre-auth informational view: every (source, disease) pair,
               read-only, so visitors can see the full reviewable scope. -->
          <template v-else>
            <div
              v-for="s in sources"
              :key="s.id"
              class="source-chip source-chip--readonly"
              :class="`source-chip--disease-${s.disease}`"
            >
              <div class="source-chip__label">{{ s.label }}</div>
              <div class="source-chip__badges">
                <span
                  class="source-chip__disease"
                  :class="`disease-pill disease-pill--${s.disease}`"
                >{{ diseaseShortLabel(s.disease) }}</span>
                <span v-if="s.study_type" class="source-chip__study">{{ s.study_type }}</span>
              </div>
              <div class="source-chip__count">
                {{ s.target_count }} item{{ s.target_count === 1 ? '' : 's' }}
              </div>
            </div>
          </template>
        </div>
      </section>

      <!-- Auth gate (only the Review page requires it; CDE/CRF browse stays public) -->
      <section v-if="authStep === 'email'" class="card card--setup">
        <header class="card__head">
          <h2>Sign in</h2>
          <p class="subtle">
            Enter your email and we'll send you a 6-digit verification code.
            Anyone with relevant expertise is welcome to review — no invitation
            needed.
          </p>
        </header>
        <div class="auth-row">
          <el-input
            v-model="authEmail"
            type="email"
            placeholder="you@example.org"
            size="large"
            class="auth-row__input"
            :disabled="authLoading"
            @keyup.enter="requestCode"
          />
          <el-button
            type="primary"
            size="large"
            :loading="authLoading"
            @click="requestCode"
          >
            Send code
          </el-button>
        </div>
        <div v-if="authError" class="auth-error">{{ authError }}</div>
      </section>

      <section v-else-if="authStep === 'code'" class="card card--setup">
        <header class="card__head">
          <h2>Enter your code</h2>
          <p class="subtle">
            We sent a 6-digit code to <strong>{{ authEmail }}</strong>. It's good
            for 10 minutes. Check your spam folder if it doesn't arrive.
          </p>
        </header>
        <div class="auth-row">
          <el-input
            v-model="authCode"
            placeholder="123456"
            size="large"
            maxlength="6"
            class="auth-row__input auth-row__input--code"
            :disabled="authLoading"
            @keyup.enter="verifyCode"
          />
          <el-button
            type="primary"
            size="large"
            :loading="authLoading"
            @click="verifyCode"
          >
            Verify
          </el-button>
        </div>
        <div v-if="authError" class="auth-error">{{ authError }}</div>
        <div class="auth-row__back">
          <el-button text size="small" @click="backToEmail">← Different email</el-button>
        </div>
      </section>

      <!-- Empty state: no reviewer profile yet OR editing (only after auth) -->
      <section
        v-else-if="authStep === 'authed' && (!reviewer || editing)"
        class="card card--setup"
      >
        <header class="card__head">
          <h2>{{ reviewer ? 'Edit your reviewer profile' : 'Get started' }}</h2>
          <p class="subtle">
            {{ reviewer
              ? 'Update your focus or display name.'
              : 'Tell us who you are and what you focus on. Reviews are stored locally for now; a token-based login is planned for the production rollout.' }}
          </p>
        </header>

        <!-- Two rows × three columns. Row 1: name + LinkedIn (span-2 because
             the URL is long). Row 2: disease expertise (span-2) + study
             context (1 col) so the related "scope" controls share a line. -->
        <div class="form-grid">
          <label>
            <span class="form-grid__label">Your name</span>
            <el-input v-model="form.name" placeholder="e.g. Dr. Jane Doe" />
          </label>
          <label class="form-grid__span-2">
            <span class="form-grid__label">
              LinkedIn profile
              <span class="form-grid__label-hint">— optional</span>
            </span>
            <el-input
              v-model="form.linkedin_url"
              placeholder="https://www.linkedin.com/in/your-handle"
              maxlength="500"
              type="url"
            />
          </label>
          <label class="form-grid__span-2">
            <span class="form-grid__label">
              Disease expertise
              <span class="form-grid__label-hint">— select all that apply</span>
            </span>
            <el-select
              v-model="form.primary_diseases"
              multiple
              collapse-tags
              collapse-tags-tooltip
              placeholder="Select all that apply (e.g. Epilepsy, PTE, TBI)"
              style="width: 100%"
            >
              <el-option
                v-for="d in selectableDiseases"
                :key="d.key"
                :value="d.key"
                :label="d.longLabel"
              />
            </el-select>
            <span class="form-grid__hint subtle">
              Sessions cycle through these one at a time — pick everything you're qualified to weigh in on.
            </span>
          </label>
          <label>
            <span class="form-grid__label">Study context</span>
            <el-select
              v-model="form.primary_study_type"
              placeholder="Both clinical & preclinical"
              clearable
              style="width: 100%"
            >
              <el-option label="Clinical" value="Clinical" />
              <el-option label="Preclinical" value="Preclinical" />
            </el-select>
          </label>
        </div>
        <div class="form-grid__actions">
          <el-button v-if="editing && reviewer" @click="editing = false">Cancel</el-button>
          <el-button type="primary" size="large" @click="saveProfile">
            {{ reviewer ? 'Save changes' : 'Save profile' }}
          </el-button>
        </div>
      </section>

      <!-- Reviewer landing -->
      <template v-else-if="authStep === 'authed' && reviewer">


        <!-- Session launcher card -->
        <section class="card">
          <header class="card__head">
            <h2>Start a review session</h2>
            <p class="subtle">
              Each session pulls up to 20 items from the
              <strong>{{ sourceLabel }}</strong> dataset you've selected
              above. Sessions are kept short on purpose so they fit between
              other tasks; come back as often as you like and we'll pick up
              where you left off, skipping items you've already classified.
            </p>
            <p class="subtle subtle--keys">
              Each item is a Bundle (reviewed as a unit) or a standalone CDE.
              <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd>/<kbd>4</kbd> classify,
              <kbd>S</kbd> skips.
            </p>
          </header>

          <!-- Scope preview — reflects back to the reviewer exactly what
               they're about to review so they can confirm before starting. -->
          <div class="scope-preview">
            <div class="scope-preview__row">
              <span class="scope-preview__label">Source</span>
              <span class="scope-preview__value scope-preview__value--accent">
                {{ sourceLabel }}
              </span>
              <span
                v-if="activeSource"
                class="disease-pill"
                :class="`disease-pill--${activeSource.disease}`"
              >
                {{ activeDiseaseLongLabel }}
              </span>
              <el-button
                v-if="visibleSources.length > 1"
                text
                size="small"
                class="scope-preview__switch"
                @click="nextSource"
              >
                Next →
              </el-button>
            </div>
            <div v-if="activeSource" class="scope-preview__row">
              <span class="scope-preview__label">Context</span>
              <span class="scope-preview__value">
                {{ activeSource.study_type ?? 'Mixed' }}
                · Reviewing for {{ activeDiseaseLongLabel }} tier
              </span>
            </div>
            <div class="scope-preview__row">
              <span class="scope-preview__label">This session</span>
              <span class="scope-preview__value">
                {{ Math.min(20, remaining).toLocaleString() }}
                of {{ remaining.toLocaleString() }} remaining items
              </span>
            </div>
          </div>

          <div class="card__cta">
            <el-button
              type="primary"
              size="large"
              :loading="loadingSession"
              :disabled="remaining === 0"
              @click="startSession"
            >
              {{ remaining === 0 ? 'Nothing left to review' : 'Start review session' }}
            </el-button>
          </div>
        </section>

        <!-- Last completed session summary -->
        <section v-if="completedSummary" class="card">
          <header class="card__head">
            <h2>Last session complete</h2>
            <p class="subtle">Summary of your most recent batch.</p>
          </header>
          <div class="summary-row">
            <div class="summary-stat tier-core">
              <div class="summary-stat__value">{{ completedSummary.classified.Core }}</div>
              <div class="summary-stat__label">Core</div>
            </div>
            <div class="summary-stat tier-recommended">
              <div class="summary-stat__value">{{ completedSummary.classified.Recommended }}</div>
              <div class="summary-stat__label">Recommended</div>
            </div>
            <div class="summary-stat tier-supplemental">
              <div class="summary-stat__value">{{ completedSummary.classified.Supplemental }}</div>
              <div class="summary-stat__label">Supplemental</div>
            </div>
            <div class="summary-stat tier-na">
              <div class="summary-stat__value">{{ completedSummary.classified['Not Applicable'] }}</div>
              <div class="summary-stat__label">Not Applicable</div>
            </div>
            <div class="summary-stat muted">
              <div class="summary-stat__value">{{ completedSummary.skipped }}</div>
              <div class="summary-stat__label">Skipped</div>
            </div>
          </div>
          <div class="card__cta">
            <el-button type="primary" @click="startSession">Review another batch</el-button>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.review {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;

  &__header {
    .lede {
      max-width: 720px;
    }
  }
}

// Generic content card — matches the neutral, white-island treatment used on
// CDEs/CRFs detail pages.
.card {
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 2px;
  padding: 1.25rem 1.5rem 1.5rem;

  &__head {
    margin-bottom: 1rem;

    h2 {
      margin: 0 0 0.25rem;
      font-size: 16px;
      font-weight: 600;
      color: $gray_6;
    }
    p {
      margin: 0;
      line-height: 1.55;

      & + p {
        margin-top: 0.5rem;
      }
    }
    .subtle--keys {
      font-size: 12px;
    }
  }

  &__cta {
    display: flex;
    justify-content: flex-end;
    margin-top: 1.25rem;
  }

  &--setup {
    // First-time setup card — give it a subtle accent stripe so it stands out
    // when the rest of the page is empty.
    border-left: 3px solid $es-primary-color;
  }
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;

  @media (max-width: 720px) {
    grid-template-columns: 1fr;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  &__label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: $gray_5;
    font-weight: 600;
  }

  // Inline secondary cue beside a field label — for cardinality affordances
  // ("select all that apply") that need to stay visible after the field's
  // placeholder disappears.
  &__label-hint {
    font-weight: 500;
    color: $gray_4;
    text-transform: none;
    letter-spacing: 0.2px;
    margin-left: 6px;
  }

  &__hint {
    font-size: 11px;
    margin-top: 4px;
  }

  &__span-2 {
    grid-column: span 2;

    @media (max-width: 720px) {
      grid-column: auto;
    }
  }

  &__actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 1.25rem;
  }
}

// Identity bar — compact, profile chip + edit button.
// Auth gate (email + code steps). Sits inside .card--setup so the layout
// matches the profile-setup card the reviewer sees right after.
.auth-row {
  display: flex;
  gap: 10px;
  align-items: stretch;

  &__input {
    flex: 1;

    &--code :deep(input) {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 18px;
      letter-spacing: 6px;
      text-align: center;
    }
  }

  &__back {
    margin-top: 10px;
  }
}

.auth-error {
  margin-top: 10px;
  padding: 8px 12px;
  background: #fdf3f0;
  border: 1px solid #f3c0b3;
  color: #a13a17;
  border-radius: 2px;
  font-size: 13px;
}

.reviewer-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 2px;

  &__avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: $purple_3;
    color: $white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 13px;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }

  &__identity {
    flex: 1;
    min-width: 0;
  }

  &__name {
    font-weight: 600;
    font-size: 14px;
    color: $gray_6;
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }

  &__linkedin {
    font-size: 11px;
    font-weight: 500;
    color: $gray_5;
    text-decoration: none;
    border-bottom: 1px dashed transparent;

    &:hover {
      color: $es-primary-color;
      border-bottom-color: $es-primary-color;
    }
  }

  &__scope {
    font-size: 12px;
    margin-top: 1px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
  }

  &__disease-chip {
    display: inline-block;
    padding: 1px 8px;
    background: $gray_1;
    border: 1px solid $lineColor2;
    border-radius: 2px;
    font-size: 11px;
    font-weight: 600;
    color: $gray_6;
  }

  &__sep {
    color: $gray_3;
    margin: 0 2px;
  }
}

// "Currently under review" banner — one tappable chip per source. Active
// chip gets a colored border + raised affordance so the reviewer always
// knows which dataset a "Start session" click will pull from.
.sources-banner {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px 16px;
  background: $white;
  border: 1px solid $lineColor2;
  border-left: 3px solid $es-primary-color;
  border-radius: 4px;

  &__head {
    h2 {
      margin: 0 0 4px;
      font-size: 15px;
      font-weight: 700;
    }
    p {
      margin: 0;
      font-size: 12px;
      line-height: 1.5;
    }
  }

  &__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 8px;
  }
}

.source-chip {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: $gray_0;
  border: 1px solid $lineColor2;
  border-left: 3px solid transparent;
  border-radius: 3px;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition: transform 80ms ease, box-shadow 80ms ease, border-color 80ms ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);
    border-color: $gray_3;
  }

  &--active {
    background: $white;
    border-color: $es-primary-color;
    border-left-color: $es-primary-color;
    box-shadow: 0 2px 6px rgba(31, 82, 143, 0.12);
  }

  &--readonly {
    cursor: default;
    opacity: 0.85;

    &:hover {
      transform: none;
      box-shadow: none;
      border-color: $lineColor2;
    }
  }

  &__label {
    font-size: 13px;
    font-weight: 600;
    color: $gray_6;
  }

  &__badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }

  &__study {
    font-size: 10px;
    color: $gray_5;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    font-weight: 600;
  }

  &__count {
    font-size: 11px;
    color: $gray_5;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }

  &__disease {
    flex: 0 0 auto;
  }
}

// Disease badge palette — small color-coded pill that matches the PDF
// accent palette. Used on source chips and the active-source meta strip.
.disease-pill {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 2px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;

  &--pte         { background: #fde2ee; color: #be185d; }
  &--tbi         { background: #fdebd5; color: #b45309; }
  &--sci         { background: #d8f5f3; color: #0e7d7b; }
  &--neurotrauma { background: #e3e8ee; color: #475569; }
  &--epilepsy    { background: #efe5ff; color: #6d28d9; }
  &--agnostic    { background: #e8eef7; color: #1f528f; }
}

// Progress stat band — small, scannable. Same hierarchy as Home stats.
.progress-band {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.progress-card {
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 2px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;

  &__value {
    font-size: 24px;
    font-weight: 700;
    line-height: 1.1;
    color: $gray_6;
  }

  &__label {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: $gray_5;
  }

  &__meta {
    font-size: 11px;
    color: $gray_5;
    margin-top: 2px;
  }

  &--lead {
    background: $purple_3;
    color: $white;
    border-color: $purple_3;

    .progress-card__value,
    .progress-card__label {
      color: $white;
    }
    .progress-card__meta {
      color: rgba(255, 255, 255, 0.78);
    }
  }
}

// Scope preview — confirms what the reviewer is about to review before they
// click Start. Read like a definition list: small label, prominent value.
.scope-preview {
  background: $gray_1;
  border: 1px solid $lineColor2;
  border-left: 3px solid $es-primary-color;
  border-radius: 2px;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;

  &__row {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }

  &__label {
    flex: 0 0 110px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: $gray_5;
  }

  &__value {
    font-size: 14px;
    font-weight: 600;
    color: $gray_6;

    &--accent {
      color: $es-primary-color;
    }
  }

  &__switch {
    margin-left: auto;
  }
}

.coverage-bar {
  height: 8px;
  background: $gray_2;
  border-radius: 4px;
  overflow: hidden;
  margin: 6px 0 4px;

  &__fill {
    height: 100%;
    background: $es-primary-color;
    transition: width 240ms ease;
  }
}

.rereview {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  background: $gray_1;
  border: 1px solid $lineColor2;
  border-radius: 2px;
  margin-top: 1rem;

  &__title {
    font-size: 13px;
    font-weight: 600;
    color: $gray_6;
    margin-bottom: 2px;
  }
}

kbd {
  display: inline-block;
  padding: 0 5px;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 11px;
  background: $gray_1;
  border: 1px solid $lineColor1;
  border-bottom-width: 2px;
  border-radius: 3px;
  color: $gray_6;
  line-height: 1.6;
}

.summary-row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px;
  margin-bottom: 0.5rem;

  @media (max-width: 720px) {
    grid-template-columns: repeat(2, 1fr);
  }
}

.summary-stat {
  padding: 12px 14px;
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 2px;
  border-left: 3px solid $gray_3;

  &__value {
    font-size: 22px;
    font-weight: 700;
    color: $gray_6;
  }

  &__label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: $gray_5;
    font-weight: 600;
    margin-top: 2px;
  }

  &.tier-core { border-left-color: #2d6b3a; }
  &.tier-recommended { border-left-color: #1f528f; }
  &.tier-supplemental { border-left-color: #7a4a05; }
  &.tier-na { border-left-color: $neutralGrey; }

  &.muted {
    background: $gray_1;
  }
}
</style>
