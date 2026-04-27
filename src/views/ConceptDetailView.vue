<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDuckDB } from '@/composables/useDuckDB';
import {
  useConcepts,
  conceptLabel,
  type ConceptListRow,
  type CdeForConcept,
} from '@/composables/useConcepts';

const route = useRoute();
const router = useRouter();
const { status } = useDuckDB();
const { getConcept, getCdesForConcept } = useConcepts();

const concept = ref<ConceptListRow | null>(null);
const cdes = ref<CdeForConcept[]>([]);
const loading = ref(false);
const notFound = ref(false);

async function load() {
  if (status.value !== 'ready') return;
  loading.value = true;
  try {
    const id = String(route.params.id);
    concept.value = await getConcept(id);
    if (!concept.value) {
      notFound.value = true;
      cdes.value = [];
      return;
    }
    notFound.value = false;
    cdes.value = await getCdesForConcept(id);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => route.params.id, load);
watch(status, load);

// Group CDEs by their role (primary vs unit/qualifier/other) so the page
// shows what the concept's "main" CDEs are vs supporting metadata.
function roleSection(role: 'primary' | 'unit' | 'qualifier' | 'other') {
  return cdes.value.filter((c) => c.role === role);
}

function goToCde(c: CdeForConcept) {
  router.push({ path: '/cdes', query: { q: c.cde_name } });
}
</script>

<template>
  <div class="concept-detail" v-loading="loading">
    <nav class="concept-detail__breadcrumbs">
      <router-link to="/concepts">← All concepts</router-link>
    </nav>

    <div v-if="notFound" class="concept-detail__missing subtle">
      No concept found with id <code>{{ route.params.id }}</code>.
    </div>

    <template v-else-if="concept">
      <header class="concept-detail__head">
        <div class="concept-detail__topline">
          <span class="concept-detail__source">{{ concept.source }}</span>
          <span v-if="concept.cui" class="concept-detail__cui mono">CUI {{ concept.cui }}</span>
        </div>
        <h1>{{ conceptLabel(concept) }}</h1>
        <p v-if="concept.definition" class="concept-detail__def">
          {{ concept.definition }}
        </p>
      </header>

      <aside class="concept-detail__meta">
        <div class="meta-block">
          <div class="meta-block__label">Source</div>
          <div class="meta-block__value">{{ concept.source }}</div>
        </div>
        <div class="meta-block">
          <div class="meta-block__label">Identifier</div>
          <div class="meta-block__value mono">{{ concept.identifier }}</div>
        </div>
        <div v-if="concept.cui" class="meta-block">
          <div class="meta-block__label">UMLS CUI</div>
          <div class="meta-block__value mono">{{ concept.cui }}</div>
        </div>
        <div v-if="concept.alt_labels" class="meta-block meta-block--wide">
          <div class="meta-block__label">Alternative labels</div>
          <div class="meta-block__value">
            {{ concept.alt_labels.split('|').join(' · ') }}
          </div>
        </div>
        <div class="meta-block">
          <div class="meta-block__label">CDE count</div>
          <div class="meta-block__value">{{ concept.cde_count }}</div>
        </div>
      </aside>

      <section class="concept-detail__cdes" v-if="cdes.length">
        <h2>Implemented by</h2>
        <p class="subtle">
          CDEs in the library that point at this concept. Roles
          (primary / unit / qualifier) are seeded as <em>primary</em> for
          everything today; later releases let admins refine for
          supporting elements like <em>age-unit</em>.
        </p>

        <template
          v-for="role in ['primary', 'unit', 'qualifier', 'other'] as const"
          :key="role"
        >
          <div v-if="roleSection(role).length" class="role-block">
            <h3 class="role-block__title">{{ role }}</h3>
            <ul class="cde-list">
              <li
                v-for="c in roleSection(role)"
                :key="c.cde_id"
                class="cde-list__item"
                @click="goToCde(c)"
              >
                <span class="cde-list__name">{{ c.cde_name }}</span>
                <span v-if="c.variable_name" class="mono muted">
                  {{ c.variable_name }}
                </span>
                <span v-if="c.cde_data_type" class="cde-list__type">
                  {{ c.cde_data_type }}
                </span>
                <span v-if="c.bundle_name" class="cde-list__bundle muted">
                  · {{ c.bundle_name }}
                </span>
              </li>
            </ul>
          </div>
        </template>
      </section>
      <section v-else class="concept-detail__empty subtle">
        No CDEs currently link to this concept.
      </section>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.concept-detail {
  display: flex;
  flex-direction: column;
  gap: 1rem;

  &__breadcrumbs a {
    font-size: 12px;
    color: $gray_5;
    text-decoration: none;

    &:hover {
      color: $es-primary-color;
    }
  }

  &__missing {
    padding: 2rem;
    text-align: center;
  }

  &__head {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-left: 3px solid $purple_3;
    padding-left: 1rem;

    h1 {
      margin: 0;
      font-size: 26px;
      line-height: 1.2;
      color: $gray_6;
    }
  }

  &__topline {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  &__source {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: $purple_3;
    font-weight: 700;
  }

  &__cui {
    font-size: 11px;
    color: $gray_5;
    background: $gray_1;
    padding: 2px 8px;
    border-radius: 2px;
  }

  &__def {
    margin: 0;
    color: $gray_5;
    font-size: 14px;
    max-width: 720px;
  }

  &__meta {
    background: $white;
    border: 1px solid $lineColor2;
    border-radius: 2px;
    padding: 1rem 1.25rem;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 14px 24px;
  }

  &__cdes {
    background: $white;
    border: 1px solid $lineColor2;
    border-radius: 2px;
    padding: 1.25rem;

    h2 {
      margin: 0 0 0.25rem;
    }
    p.subtle {
      margin: 0 0 0.75rem;
    }
  }

  &__empty {
    padding: 2rem;
    text-align: center;
  }
}

.meta-block {
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
    margin-top: 2px;
    overflow-wrap: anywhere;
  }

  &--wide {
    grid-column: 1 / -1;
  }
}

.role-block {
  & + & {
    margin-top: 1rem;
  }

  &__title {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: $gray_5;
  }
}

.cde-list {
  list-style: none;
  margin: 0;
  padding: 0;

  &__item {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 8px 10px;
    border-bottom: 1px solid $lineColor2;
    cursor: pointer;
    font-size: 13px;
    flex-wrap: wrap;

    &:hover {
      background: $gray_1;
    }
  }

  &__name {
    font-weight: 600;
    color: $gray_6;
  }

  &__type {
    font-size: 11px;
    color: $gray_5;
    background: $gray_1;
    padding: 1px 6px;
    border-radius: 2px;
  }

  &__bundle {
    font-size: 12px;
  }
}
</style>
