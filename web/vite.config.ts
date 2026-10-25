import { defineConfig } from 'vite';

// Relative base so the build works from any GitHub Pages sub-path.
export default defineConfig({
  base: './',
  server: { port: 5193 },
  preview: { port: 5194 },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
