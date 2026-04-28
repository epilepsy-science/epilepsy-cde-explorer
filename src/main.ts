import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import App from './App.vue';
import { router } from './router';
import { trackPageView } from './api/analytics';
import './assets/base.scss';

const app = createApp(App);

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

app.use(ElementPlus);
app.use(router);

// Analytics — gtag.js is loaded by index.html before this bundle parses, so
// window.gtag is already installed by the time the first navigation fires.
// trackPageView is a no-op when window.gtag is undefined (dev / preview /
// blocked-by-extension), so no guard needed here.
router.afterEach((to) => {
  // Use route.fullPath so hash-routed views (/explore?focus=tbi, etc.)
  // register as distinct pages instead of collapsing to '/'.
  trackPageView(to.fullPath);
});

app.mount('#app');
