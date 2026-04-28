import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
        additionalData: '@use "@/assets/scss/_variables.scss" as *;',
      },
    },
  },
  server: {
    fs: {
      allow: ['..'],
    },
    // Proxy API requests through the dev server so the browser sees them as
    // same-origin and CORS is bypassed. The production API only allows-list
    // https://cde.epilepsy.science as an origin, so without this proxy,
    // login from localhost:5173 fails the preflight.
    //
    // For this to apply, the API client must make requests to relative
    // paths (e.g. `/v1/...`) — set VITE_API_BASE_URL='' in .env.local.
    proxy: {
      '/v1': {
        target: 'https://api.cde.epilepsy.science',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
});
