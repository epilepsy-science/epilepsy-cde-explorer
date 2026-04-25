<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useDuckDB } from '@/composables/useDuckDB';
import { useCrfStore } from '@/composables/useCrfStore';
import type { CrfRecord } from '@/types';

const router = useRouter();
const { status, query } = useDuckDB();
const { crfs, ensureLoaded: ensureCrfsLoaded } = useCrfStore();

interface Stats {
  total: number;
  bundles: number;
  core: number;
  recommended: number;
  supplemental: number;
}

interface TopCde {
  cde_id: string;
  cde_name: string;
  preferred_question_text: string | null;
  bundle_domain: string | null;
  core_count: number;
}

interface DiseasePill {
  key: 'pte' | 'tbi' | 'sci' | 'neurotrauma' | 'agnostic';
  label: string;
  count: number;
}

const stats = ref<Stats>({ total: 0, bundles: 0, core: 0, recommended: 0, supplemental: 0 });
const topCdes = ref<TopCde[]>([]);
const diseaseCounts = ref<DiseasePill[]>([]);
const loading = ref(false);

const DISEASE_PILL_ORDER: Array<Pick<DiseasePill, 'key' | 'label'>> = [
  { key: 'pte', label: 'PTE' },
  { key: 'tbi', label: 'TBI' },
  { key: 'sci', label: 'SCI' },
  { key: 'neurotrauma', label: 'Neurotrauma' },
  { key: 'agnostic', label: 'Agnostic' },
];

// Aggregate tier: a CDE is "Core" if ANY of its classification_* columns is Core,
// else Recommended if any is Recommended, else Supplemental. Not Applicable is ignored.
const TIER_COLS = [
  'classification_agnostic',
  'classification_neurotrauma',
  'classification_tbi',
  'classification_pte',
  'classification_sci',
];
const tierList = `[${TIER_COLS.join(', ')}]`;

async function load() {
  if (status.value !== 'ready') return;
  loading.value = true;
  try {
    const coreSum = TIER_COLS
      .map((c) => `(CASE WHEN ${c} = 'Core' THEN 1 ELSE 0 END)`)
      .join(' + ');
    const [totals, tiers, topC, disease] = await Promise.all([
      query<{ n: number; b: number }>(
        `SELECT count(*) AS n, count(DISTINCT bundle_id) AS b FROM cde_full`,
      ),
      query<{ tier: string; n: number }>(`
        WITH t AS (
          SELECT cde_id,
            CASE
              WHEN list_contains(${tierList}, 'Core') THEN 'Core'
              WHEN list_contains(${tierList}, 'Recommended') THEN 'Recommended'
              WHEN list_contains(${tierList}, 'Supplemental') THEN 'Supplemental'
              ELSE NULL
            END AS tier
          FROM cde_full
        )
        SELECT tier, count(*) AS n FROM t WHERE tier IS NOT NULL GROUP BY tier
      `),
      query<TopCde>(`
        SELECT
          cde_id,
          cde_name,
          preferred_question_text,
          bundle_domain,
          (${coreSum}) AS core_count
        FROM cde_full
        WHERE (${coreSum}) > 0
        ORDER BY core_count DESC, cde_name
        LIMIT 8
      `),
      query<Record<string, number>>(`
        SELECT
          sum(CASE WHEN disease_pte = 'Y' THEN 1 ELSE 0 END) AS pte,
          sum(CASE WHEN disease_tbi = 'Y' THEN 1 ELSE 0 END) AS tbi,
          sum(CASE WHEN disease_sci = 'Y' THEN 1 ELSE 0 END) AS sci,
          sum(CASE WHEN disease_neurotrauma = 'Y' THEN 1 ELSE 0 END) AS neurotrauma,
          sum(CASE WHEN disease_agnostic = 'Y' THEN 1 ELSE 0 END) AS agnostic
        FROM cde_full
      `),
    ]);

    const tierMap: Record<string, number> = {};
    for (const t of tiers) tierMap[t.tier ?? ''] = Number(t.n);

    stats.value = {
      total: Number(totals[0]?.n ?? 0),
      bundles: Number(totals[0]?.b ?? 0),
      core: tierMap['Core'] ?? 0,
      recommended: tierMap['Recommended'] ?? 0,
      supplemental: tierMap['Supplemental'] ?? 0,
    };
    topCdes.value = topC.map((c) => ({ ...c, core_count: Number(c.core_count) }));
    const row = disease[0] ?? {};
    diseaseCounts.value = DISEASE_PILL_ORDER.map((d) => ({
      key: d.key,
      label: d.label,
      count: Number(row[d.key] ?? 0),
    }));
  } finally {
    loading.value = false;
  }
}

watch(status, load);
onMounted(() => {
  load();
  ensureCrfsLoaded();
});

const featuredCrfs = computed<CrfRecord[]>(() => crfs.value.slice(0, 8));

function crfCounts(c: CrfRecord) {
  let sections = 0;
  let cdes = 0;
  let bundles = 0;
  for (const it of c.items) {
    if (it.type === 'section') sections++;
    else if (it.type === 'cde') cdes++;
    else if (it.type === 'bundle') bundles++;
  }
  return { sections, cdes, bundles };
}

function goToCdes(params: Record<string, string | undefined>) {
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v) q[k] = v;
  router.push({ path: '/cdes', query: q });
}

function goToExplore(diseaseKey: string) {
  // The explore lens is a module-level ref in useDiseaseLens, so just navigating
  // is enough once the lens is set. But this page doesn't own the lens; consumers
  // expect to pick it themselves in /explore. For now, send them there and they
  // can switch the lens.
  router.push({ path: '/explore', query: { focus: diseaseKey } });
}

function pctOfTotal(n: number) {
  return stats.value.total ? Math.round((n / stats.value.total) * 100) : 0;
}
</script>

<template>
  <div class="home" v-loading="loading">
    <!-- Hero -->
    <section class="hero">
      <div class="hero__inner">
        <div class="hero__eyebrow">NT-PRECEDS · NINDS · CDE Library</div>
        <h1 class="hero__title">
          Curated Common Data Elements for
          <span class="hero__accent">Epilepsy, TBI &amp; PTE</span>
          research
        </h1>
        <p class="hero__lede">
          Make CDEs available in a meaningful, discoverable way — so
          prospective studies can adopt them from day one and produce data
          that combines cleanly across sites and cohorts.
        </p>
        <div class="hero__cta">
          <el-button type="primary" size="large" @click="router.push('/cdes')">
            Browse CDEs
          </el-button>
          <el-button size="large" @click="router.push('/explore')">
            Explore by disease
          </el-button>

        </div>
      </div>
    </section>

    <!-- How it works -->
    <section class="how">
      <header class="how__head">
        <h2>How it works</h2>
        <p class="subtle">From standardized questions to complete study forms.</p>
      </header>
      <ol class="how__steps">
        <li class="how-step">
          <div class="how-step__num">1</div>
          <h3 class="how-step__title">Pick CDEs</h3>
          <p class="how-step__body">
            A <strong>Common Data Element</strong> is a standardized question
            with a defined data type, permissible values, and code system.
            Each CDE captures one variable so data collected at different
            sites can be combined and compared.
          </p>
        </li>
        <li class="how-step">
          <div class="how-step__num">2</div>
          <h3 class="how-step__title">Group and qualify</h3>
          <p class="how-step__body">
            <strong>Bundles</strong> are CDEs that must always be captured
            together — an Age value alone is meaningless without its unit,
            so they ship as one.
            <strong>Classifications</strong> rank each CDE for a specific
            disease — <em>Core</em> (required), <em>Recommended</em>, or
            <em>Supplemental</em> — so the same element can be essential for
            one study and optional for another.
          </p>
        </li>
        <li class="how-step">
          <div class="how-step__num">3</div>
          <h3 class="how-step__title">Select or assemble a CRF</h3>
          <p class="how-step__body">
            A <strong>Case Report Form</strong> groups CDEs for a specific
            study event — enrollment, follow-up, outcome. Pick a ready-made
            CRF from the library, or compose your own from the CDEs you
            need. Sections, instructions, and the questions investigators
            actually answer in the clinic or at the bench.
          </p>
        </li>
        <li class="how-step">
          <div class="how-step__num">4</div>
          <h3 class="how-step__title">Run your study</h3>
          <p class="how-step__body">
            Drop CRFs into your own study to drive data collection —
            intake, follow-up, outcome. Because every site records the same
            variables with the same permissible values, your data is
            interoperable with other studies from day one, with no
            retro-mapping.
          </p>
        </li>
      </ol>
    </section>

    <!-- At-a-glance stats (project status) -->
    <section class="stats-band">
      <header class="stats-band__head">
        <h2>Project status</h2>
        <p class="subtle">Current coverage across the curated set.</p>
      </header>
      <div class="stat-grid">
        <div class="stat-card stat-card--lead">
          <div class="stat-card__value">{{ stats.total.toLocaleString() }}</div>
          <div class="stat-card__label">Total CDEs</div>
          <div class="stat-card__meta muted">across {{ stats.bundles }} bundles</div>
        </div>
        <div
          class="stat-card stat-card--tier tier-core"
          @click="goToCdes({ tier: 'Core' })"
        >
          <div class="stat-card__value">{{ stats.core.toLocaleString() }}</div>
          <div class="stat-card__label">Core <span class="muted">({{ pctOfTotal(stats.core) }}%)</span></div>
          <div class="stat-card__meta">Required in at least one disease</div>
        </div>
        <div
          class="stat-card stat-card--tier tier-recommended"
          @click="goToCdes({ tier: 'Recommended' })"
        >
          <div class="stat-card__value">{{ stats.recommended.toLocaleString() }}</div>
          <div class="stat-card__label">Recommended <span class="muted">({{ pctOfTotal(stats.recommended) }}%)</span></div>
          <div class="stat-card__meta">Strongly encouraged</div>
        </div>
        <div
          class="stat-card stat-card--tier tier-supplemental"
          @click="goToCdes({ tier: 'Supplemental' })"
        >
          <div class="stat-card__value">{{ stats.supplemental.toLocaleString() }}</div>
          <div class="stat-card__label">Supplemental <span class="muted">({{ pctOfTotal(stats.supplemental) }}%)</span></div>
          <div class="stat-card__meta">Domain- or study-specific</div>
        </div>
      </div>
    </section>

    <!-- Browse the library (CRFs + Featured CDEs) -->
    <section class="library">
      <header class="library__head">
        <h2>Browse the library</h2>
        <p class="subtle">
          Pre-assembled forms and individual data elements you can adopt
          today — or use as scaffolding for your own.
        </p>
      </header>

    <!-- Case Report Forms gallery -->
    <section class="panel library__panel">
      <header class="panel__head panel__head--row">
        <div>
          <h3>Case Report Forms</h3>
          <p class="subtle">
            Pre-assembled forms composed of CDEs, Bundles, and instructions.
          </p>
        </div>
        <router-link class="panel__link" to="/crfs">Browse all CRFs →</router-link>
      </header>
      <div v-if="featuredCrfs.length === 0" class="subtle empty">
        No CRFs loaded yet.
      </div>
      <div v-else class="gallery">
        <article
          v-for="c in featuredCrfs"
          :key="c.id"
          class="crf-card"
          @click="router.push(`/crfs/${c.id}`)"
        >
          <header class="crf-card__head">
            <span
              class="crf-card__source"
              :class="c.source === 'seeded' ? 'crf-card__source--seeded' : 'crf-card__source--custom'"
            >
              {{ c.source === 'seeded' ? 'Seeded' : 'Custom' }}
            </span>
            <span v-if="c.disease_scope" class="crf-card__scope">{{ c.disease_scope }}</span>
          </header>
          <h3 class="crf-card__title">{{ c.title }}</h3>
          <p v-if="c.description" class="crf-card__desc">{{ c.description }}</p>
          <footer class="crf-card__meta">
            <span v-if="crfCounts(c).sections" class="crf-card__stat">
              {{ crfCounts(c).sections }} sections
            </span>
            <span v-if="crfCounts(c).cdes" class="crf-card__stat">
              {{ crfCounts(c).cdes }} cdes
            </span>
            <span v-if="crfCounts(c).bundles" class="crf-card__stat">
              {{ crfCounts(c).bundles }} bundles
            </span>
            <span v-if="c.estimated_duration_minutes" class="crf-card__stat muted">
              · ~{{ c.estimated_duration_minutes }} min
            </span>
          </footer>
        </article>
      </div>
    </section>

    <!-- Featured individual CDEs -->
    <section class="panel library__panel">
      <header class="panel__head panel__head--row">
        <div>
          <h3>Featured CDEs</h3>
          <p class="subtle">
            Individual elements marked Core across the most diseases.
          </p>
        </div>
        <router-link class="panel__link" to="/cdes">Browse all CDEs →</router-link>
      </header>
      <div v-if="topCdes.length === 0" class="subtle empty">
        No CDEs available.
      </div>
      <div v-else class="gallery">
        <article
          v-for="c in topCdes"
          :key="c.cde_id"
          class="cde-card"
          @click="goToCdes({ q: c.cde_name })"
        >
          <header class="cde-card__head">
            <span class="cde-card__core">Core × {{ c.core_count }}</span>
            <span v-if="c.bundle_domain" class="cde-card__domain">{{ c.bundle_domain }}</span>
          </header>
          <h3 class="cde-card__title">{{ c.cde_name }}</h3>
          <p v-if="c.preferred_question_text" class="cde-card__q">
            {{ c.preferred_question_text }}
          </p>
        </article>
      </div>
    </section>

    </section>

    <!-- Coverage teaser — pill strip linking to Explore -->
    <section class="coverage-teaser">
      <div class="coverage-teaser__text">
        <h2>Coverage by disease</h2>
        <p class="subtle">
          Curated CDEs applicable to each research focus. Pick one to see
          its tier breakdown in Explore.
        </p>
      </div>
      <div class="coverage-teaser__pills">
        <button
          v-for="d in diseaseCounts"
          :key="d.key"
          type="button"
          class="cov-pill"
          @click="goToExplore(d.key)"
        >
          <span class="cov-pill__label">{{ d.label }}</span>
          <span class="cov-pill__count">{{ d.count }}</span>
        </button>
        <button
          type="button"
          class="cov-pill cov-pill--cta"
          @click="router.push('/explore')"
        >
          Open Explore →
        </button>
      </div>
    </section>
  </div>
</template>

<style lang="scss" scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 2.75rem;
}

// Escape the app-main's 1.5rem padding so the hero reaches full width.
.hero {
  margin: -1.5rem -1.5rem 0;
  padding: 3.5rem 1.5rem 3rem;
  background:
    radial-gradient(circle at 85% 20%, rgba($es-primary-color, 0.12), transparent 55%),
    linear-gradient(180deg, lighten($es-primary-color, 55%) 0%, $white 100%);
  border-bottom: 1px solid $lineColor2;

  &__inner {
    max-width: 960px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  &__eyebrow {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: $purple_3;
  }

  &__title {
    margin: 0;
    font-size: clamp(28px, 4vw, 42px);
    font-weight: 700;
    line-height: 1.15;
    color: $gray_6;
    letter-spacing: -0.5px;
    max-width: 820px;
  }

  &__accent {
    color: $es-highlight;
    white-space: nowrap;
  }

  &__lede {
    margin: 0;
    font-size: 16px;
    line-height: 1.55;
    color: $gray_5;
    max-width: 680px;
  }

  &__cta {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 0.5rem;
  }
}

.how {
  &__head {
    text-align: center;
    margin-bottom: 1.25rem;

    h2 {
      margin: 0 0 0.25rem;
    }
    p {
      margin: 0;
    }
  }

  &__steps {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 1rem;
  }
}

.how-step {
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 2px;
  padding: 1.25rem 1.25rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: relative;

  &__num {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: $es-primary-color;
    color: $white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 14px;
  }

  &__title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: $gray_6;
  }

  &__body {
    margin: 0;
    font-size: 13px;
    line-height: 1.55;
    color: $gray_5;
  }
}

.stats-band {
  &__head {
    @extend %section-head;
  }
}

.coverage {
  border: 1px solid $lineColor2;
  border-radius: 2px;
  background: $white;

  &[open] {
    .coverage__summary {
      border-bottom: 1px solid $lineColor2;
    }
  }

  &__summary {
    list-style: none;
    cursor: pointer;
    padding: 0.85rem 1.25rem;
    display: flex;
    align-items: center;
    gap: 10px;
    user-select: none;

    &::-webkit-details-marker {
      display: none;
    }

    &::before {
      content: '▸';
      color: $gray_4;
      font-size: 10px;
      transition: transform 120ms ease;
    }
  }

  &[open] &__summary::before {
    transform: rotate(90deg);
  }

  &__title {
    font-weight: 600;
    color: $gray_6;
    font-size: 14px;
  }

  &__hint {
    font-size: 12px;
  }

  &__panel {
    border: none;
    border-radius: 0;
  }

  &__lede {
    margin: 0 0 1rem;
  }
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.stat-card {
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 2px;
  padding: 16px;
  cursor: pointer;
  transition: transform 80ms ease, box-shadow 80ms ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
  }

  &--lead {
    background: $purple_3;
    color: $white;
    cursor: default;
    border-color: $purple_3;

    &:hover {
      transform: none;
      box-shadow: none;
    }

    .muted {
      color: rgba(255, 255, 255, 0.7);
    }
  }

  &__value {
    font-size: 28px;
    font-weight: 700;
    line-height: 1.1;
  }

  &__label {
    font-size: 13px;
    font-weight: 600;
    margin-top: 4px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  &__meta {
    font-size: 11px;
    margin-top: 4px;
  }

  &.tier-core {
    border-left: 4px solid #2d6b3a;
  }
  &.tier-recommended {
    border-left: 4px solid #1f528f;
  }
  &.tier-supplemental {
    border-left: 4px solid #7a4a05;
  }
}

.panel {
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 2px;
  padding: 1.25rem;

  &__head {
    margin-bottom: 1rem;

    h2 {
      margin-bottom: 0.25rem;
    }
    p {
      margin: 0;
    }

    &--row {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }
  }

  &__link {
    font-size: 13px;
    color: $es-primary-color;
    text-decoration: none;
    font-weight: 500;

    &:hover {
      text-decoration: underline;
    }
  }
}

.empty {
  padding: 1rem 0;
}

// Shared section-header style used across top-level landing sections
// (Project status, Browse the library, Coverage by disease).
%section-head {
  margin-bottom: 0.75rem;

  h2 {
    margin: 0 0 0.25rem;
    font-size: 18px;
    font-weight: 600;
    color: $gray_6;
  }
  p {
    margin: 0;
  }
}

.library {
  display: flex;
  flex-direction: column;
  gap: 1rem;

  &__head {
    @extend %section-head;
  }

  &__panel h3 {
    margin: 0 0 0.2rem;
    font-size: 15px;
    font-weight: 600;
    color: $gray_6;
  }
}

.coverage-teaser {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem 1.75rem;
  background: linear-gradient(135deg, lighten($es-primary-color, 52%) 0%, $white 100%);
  border: 1px solid $lineColor2;
  border-radius: 2px;

  &__text {
    @extend %section-head;
    margin-bottom: 0;
  }

  &__pills {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
}

.cov-pill {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 6px 14px;
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 500;
  color: $gray_6;
  cursor: pointer;
  text-decoration: none;
  transition: border-color 80ms ease, background 80ms ease, color 80ms ease;

  &:hover {
    border-color: $es-primary-color;
    color: $es-primary-color;
  }

  &__label {
    font-weight: 600;
  }

  &__count {
    font-size: 12px;
    color: $gray_5;
    font-variant-numeric: tabular-nums;
  }

  &--cta {
    background: $es-primary-color;
    color: $white;
    border-color: $es-primary-color;

    &:hover {
      background: darken($es-primary-color, 8%);
      color: $white;
      border-color: darken($es-primary-color, 8%);
    }
  }
}

.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

.crf-card,
.cde-card {
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 2px;
  padding: 14px 16px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: transform 80ms ease, box-shadow 80ms ease, border-color 80ms ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
    border-color: $es-primary-color;
  }
}

.crf-card {
  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  &__source {
    display: inline-block;
    padding: 1px 7px;
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

  &__scope {
    font-size: 11px;
    color: $gray_4;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }

  &__title {
    font-size: 15px;
    font-weight: 600;
    color: $gray_6;
    margin: 0;
    line-height: 1.3;
  }

  &__desc {
    font-size: 12px;
    color: $gray_5;
    margin: 0;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  &__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 11px;
    color: $gray_5;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  &__stat {
    font-weight: 600;

    &.muted {
      font-weight: 400;
    }
  }
}

.cde-card {
  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  &__core {
    display: inline-block;
    padding: 1px 7px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    border-radius: 2px;
    background: #e6f2ea;
    color: #2d6b3a;
    border-left: 2px solid #2d6b3a;
  }

  &__domain {
    font-size: 11px;
    color: $gray_4;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }

  &__title {
    font-size: 14px;
    font-weight: 600;
    color: $gray_6;
    margin: 0;
    line-height: 1.3;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-word;
  }

  &__q {
    font-size: 12px;
    color: $gray_5;
    margin: 0;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
}
</style>
