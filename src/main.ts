import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import App from './App.vue';
import { router } from './router';
import { installAnalytics, trackPageView } from './api/analytics';
import './assets/base.scss';

const app = createApp(App);

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

app.use(ElementPlus);
app.use(router);

// Analytics — install before the first navigation fires so the first
// page_view is captured. No-op when VITE_GA_MEASUREMENT_ID is unset, so
// dev/preview builds don't ping production.
installAnalytics();
router.afterEach((to) => {
  // Use route.fullPath so hash-routed views (/explore?focus=tbi, etc.)
  // register as distinct pages instead of collapsing to '/'.
  trackPageView(to.fullPath);
});

app.mount('#app');
