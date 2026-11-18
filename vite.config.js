import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));

// Unique id per build (commit + timestamp). It is baked into the bundle as __APP_BUILD__ and published as /version.json;
// the running app polls that file and offers a reload when the id on the server differs from its own.
const gitHash = (() => { try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { return 'nogit'; } })();
const BUILD_ID = `${gitHash}-${Date.now().toString(36)}`;
const emitVersion = () => ({
  name: 'emit-version',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID, builtAt: new Date().toISOString() }) });
  }
});

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
  define: { __APP_BUILD__: JSON.stringify(BUILD_ID) },
  plugins: [vue(), copyDesignSystem(), emitVersion()],
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
