import { defineConfig, type Plugin } from 'vite';

// The client lives in client/ and builds into public/, which server.mjs serves
// (and which is committed, so `npm start` needs no install). public/ also holds
// the optimised 3D assets and fonts; those are never copied or emptied by Vite.

/** Where `vite` dev mode finds a running server (for example `PORT=4790 npm run demo`). */
const DEV_API = process.env.SWITCHBOARD_DEV_API ?? 'http://127.0.0.1:4790';
const DEV_ORIGINS = new Set(['http://127.0.0.1:5180', 'http://localhost:5180']);

/**
 * Dev only: borrow the running server's per-start token so the dev page gets live
 * data through the proxy. The token never leaves this machine; a server that isn't
 * running just leaves the page without data.
 */
function devToken(): Plugin {
  return {
    name: 'switchboard-dev-token',
    apply: 'serve',
    async transformIndexHtml(html) {
      try {
        const page = await (await fetch(`${DEV_API}/`)).text();
        const token = /name="switchboard-token" content="([^"]+)"/.exec(page)?.[1];
        return token ? html.replace('__SWITCHBOARD_TOKEN__', token) : html;
      } catch {
        return html;
      }
    },
  };
}

export default defineConfig({
  root: 'client',
  base: '/',
  // In `vite` dev mode, /assets and /fonts come straight from public/.
  publicDir: '../public',
  plugins: [devToken()],
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
    proxy: {
      '/api': {
        target: DEV_API,
        changeOrigin: true,
        // The server only accepts its own Origin; vouch for the dev page, and nothing else.
        configure: (proxy) =>
          proxy.on('proxyReq', (req, incoming) => {
            const origin = incoming.headers.origin;
            if (origin && DEV_ORIGINS.has(origin)) req.setHeader('origin', DEV_API);
          }),
      },
    },
  },
});
