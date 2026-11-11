import { defineConfig } from 'vite';

// base './' keeps the build relocatable (GitHub Pages project sites, any static host).
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 900, modulePreload: { polyfill: false } },
});
