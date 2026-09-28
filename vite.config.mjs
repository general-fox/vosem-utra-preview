import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createMenuMiddleware } from './server/menu-api.mjs';

export default defineConfig(({ mode }) => {
const env = loadEnv(mode, process.cwd(), '');
const menuApi = createMenuMiddleware({ password: env.ADMIN_PASSWORD, publicOrigin: env.PUBLIC_ORIGIN || undefined });
return {
  base: './',
  server: { fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.data/**', '**/server/**'] } },
  plugins: [{
    name: 'cafe-menu-api',
    configureServer(server) { server.middlewares.use(menuApi); },
    configurePreviewServer(server) { server.middlewares.use(menuApi); },
  }, {
    name: 'include-font-license',
    generateBundle() {
      for (const name of ['Lato-OFL.txt', 'Lato-WOFF2.txt']) {
        this.emitFile({ type: 'asset', fileName: `assets/${name}`, source: readFileSync(new URL(`./assets/${name}`, import.meta.url), 'utf8') });
      }
    },
  }],
  build: {
    rolldownOptions: {
      input: Object.fromEntries(
        ['index', 'registration', 'privacy', 'consent', 'admin'].map((page) => [
          page,
          fileURLToPath(new URL(`./${page}.html`, import.meta.url)),
        ]),
      ),
    },
  },
};
});
