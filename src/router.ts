import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('./views/HomeView.vue'),
  },
  {
    path: '/explore',
    name: 'explore',
    component: () => import('./views/ExploreView.vue'),
  },
  {
    path: '/cdes',
    name: 'cdes',
    component: () => import('./views/CdesView.vue'),
  },
  {
    path: '/bundles/:id',
    name: 'bundle-detail',
    component: () => import('./views/BundleDetailView.vue'),
    props: true,
  },
  {
    path: '/concepts',
    name: 'concepts',
    component: () => import('./views/ConceptsView.vue'),
  },
  {
    path: '/concepts/:id',
    name: 'concept-detail',
    component: () => import('./views/ConceptDetailView.vue'),
    props: true,
  },
  {
    path: '/crfs',
    name: 'crfs',
    component: () => import('./views/CrfsView.vue'),
  },
  {
    path: '/crfs/:id',
    name: 'crf-detail',
    component: () => import('./views/CrfDetailView.vue'),
    props: true,
  },
  {
    path: '/review',
    name: 'review',
    component: () => import('./views/ReviewView.vue'),
  },
  {
    path: '/privacy',
    name: 'privacy',
    component: () => import('./views/PrivacyView.vue'),
  },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
