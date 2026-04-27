<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, RouterView } from 'vue-router';
import { useDuckDB } from '@/composables/useDuckDB';
import AppFooter from '@/components/AppFooter.vue';

const route = useRoute();
const { status, error } = useDuckDB();

const activeNav = computed(() => {
  if (route.name === 'home') return 'home';
  if (route.name === 'explore') return 'explore';
  // Bundle detail pages are reached from within the CDE grouped view, so keep
  // the CDE tab highlighted when looking at a bundle.
  if (route.name === 'bundle-detail') return 'cdes';
  if (route.name === 'crfs' || route.name === 'crf-detail') return 'crfs';
  if (route.name === 'review') return 'review';
  return 'cdes';
});
</script>

<template>
  <div id="cde-app">
    <header class="app-header">
      <div class="app-header__brand">
        <span class="app-header__title">CDE Explorer</span>
        <span class="app-header__subtitle">Neurotrauma &amp; Epilepsy</span>
      </div>
      <nav class="app-header__nav">
        <router-link to="/" :class="{ active: activeNav === 'home' }">Home</router-link>
        <router-link to="/explore" :class="{ active: activeNav === 'explore' }">Explore</router-link>
        <router-link to="/cdes" :class="{ active: activeNav === 'cdes' }">CDEs</router-link>
        <router-link to="/crfs" :class="{ active: activeNav === 'crfs' }">CRFs</router-link>
        <router-link to="/review" :class="{ active: activeNav === 'review' }">Review</router-link>
      </nav>
      <div class="app-header__status">
        <el-tag v-if="status === 'loading'" type="info" size="small">
          <el-icon class="is-loading"><Loading /></el-icon>&nbsp;Loading
        </el-tag>
        <el-tag v-else-if="status === 'error'" type="danger" size="small">Data load error</el-tag>
      </div>
    </header>

    <main class="app-main">
      <el-alert
        v-if="status === 'error'"
        type="error"
        :closable="false"
        show-icon
        :title="'Failed to load CDE data: ' + (error ?? 'unknown')"
      />
      <router-view v-else />
    </main>
    <AppFooter />
  </div>
</template>

<style lang="scss" scoped>
#cde-app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.app-header {
  display: flex;
  align-items: center;
  gap: 2rem;
  padding: 0 1.5rem;
  height: 60px;
  background: $white;
  border-bottom: 1px solid $lineColor1;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);

  &__brand {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
  }

  &__title {
    font-weight: 700;
    font-size: 16px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: $purple_3;
  }

  &__subtitle {
    font-size: 13px;
    color: $neutralGrey;
  }

  &__nav {
    display: flex;
    gap: 1.5rem;
    margin-left: 1rem;

    a {
      color: $gray_5;
      font-weight: 500;
      font-size: 14px;
      padding: 4px 2px;
      border-bottom: 2px solid transparent;
      text-decoration: none;

      &.active {
        color: $es-primary-color;
        border-bottom-color: $es-primary-color;
      }

      &:hover {
        color: $es-primary-color;
      }
    }
  }

  &__status {
    margin-left: auto;
  }
}

.app-main {
  flex: 1;
  padding: 1.5rem;
  min-height: 0;
}
</style>
