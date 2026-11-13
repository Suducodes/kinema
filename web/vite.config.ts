import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

// the commit the build came from, stamped into exported research files
let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD').toString().trim() + (execSync('git status --porcelain').toString().trim() ? '+dirty' : ''); } catch { /* not a git checkout */ }

// Relative base so the build works from any GitHub Pages sub-path.
export default defineConfig({
  base: './',
  define: { __APP_COMMIT__: JSON.stringify(commit), __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0') },
  server: { port: 5193 },
  preview: { port: 5194 },
  build: {
    target: 'es2022', chunkSizeWarningLimit: 900,
    rollupOptions: { input: { main: 'index.html', knee: 'knee.html', live: 'live.html' } },
  },
});
