import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));

// design-system.html (the living style guide) is a dev/reference page that links css/*.css relatively. It is NOT a Rollup
// input (a second HTML entry makes Vite split the shared CSS and load the view styles before components.css, which breaks
// the cascade of the app). Instead it is copied verbatim, together with css/, so /design-system.html also works in production.
const copyDesignSystem = () => ({
  name: 'copy-design-system',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'design-system.html', source: readFileSync(here('design-system.html')) });
    for (const f of readdirSync(here('css')).filter(n => n.endsWith('.css'))) {
      this.emitFile({ type: 'asset', fileName: `css/${f}`, source: readFileSync(here(`css/${f}`)) });
    }
  }
});

// base '/' because the app is served from the root of its own (Cloudflare Worker static assets) origin; the manifest,
// service worker and icons in public/ are copied to dist/ root as they are.
export default defineConfig({
  base: '/',
  plugins: [vue(), copyDesignSystem()],
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        // Long-lived vendor chunks so app changes don't invalidate the cached framework code.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/firebase/') || id.includes('/@firebase/')) return 'vendor-firebase';
          if (id.includes('/vue/') || id.includes('/@vue/')) return 'vendor-vue';
          return undefined;
        }
      }
    }
  }
});
