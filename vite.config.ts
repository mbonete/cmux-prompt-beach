import { defineConfig } from 'vite';

// The client lives in client/ and builds into public/, which server.mjs serves
// (and which is committed, so `npm start` needs no install). public/ also holds
// the optimised 3D assets and fonts; those are never copied or emptied by Vite.
export default defineConfig({
  root: 'client',
  base: '/',
  // In `vite` dev mode, /assets and /fonts come straight from public/.
  publicDir: '../public',
  build: {
    outDir: '../public',
    emptyOutDir: false,
    copyPublicDir: false,
    assetsDir: 'build',
    // Never inline assets as data: URIs; fonts in particular must stay files for the CSP.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    target: 'es2023',
    chunkSizeWarningLimit: 4000,
  },
  server: {
    port: 5180,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4790', changeOrigin: true } },
  },
});
