import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createMenuMiddleware } from './server/menu-api.mjs';
import { createOrdersDevMiddleware } from './server/orders-dev.mjs';
import { SITE_URL, transformPage, renderRobots, renderSitemap } from './server/seo.mjs';

export default defineConfig(({ mode }) => {
const env = loadEnv(mode, process.cwd(), '');
const production = mode === 'hosting';
const menuApi = createMenuMiddleware({ production: false, username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, encryptionKey: env.AUTH_ENCRYPTION_KEY, publicOrigin: undefined });
const seed = JSON.parse(readFileSync(new URL('./public/data/menu.json', import.meta.url), 'utf8'));
return {
  base: './',
  server: {
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.data/**', '**/server/**', '**/hosting/**', '**/dist-reg/**', '**/.php-preview/**', '**/orders-data/**'] },
    watch: { ignored: ['**/.data/**', '**/.php-preview/**', '**/dist-reg/**', '**/dist-hosting/**'] },
  },
  plugins: [{
    name: 'cafe-orders-api',
    configureServer(server) {
      const orders = createOrdersDevMiddleware();
      server.middlewares.use(orders.middleware);
      server.httpServer?.once('close', orders.close);
    },
    configurePreviewServer(server) {
      const orders = createOrdersDevMiddleware();
      server.middlewares.use(orders.middleware);
      server.httpServer?.once('close', orders.close);
    },
  }, {
    name: 'cafe-menu-api',
    configureServer(server) { server.middlewares.use(menuApi); },
    configurePreviewServer(server) { server.middlewares.use(menuApi); },
  }, {
    name: 'cafe-seo',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        return transformPage(html, {
          page: context.filename, production, items: seed.items,
          googleVerification: env.GOOGLE_SITE_VERIFICATION,
          yandexVerification: env.YANDEX_VERIFICATION,
        });
      },
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries({
        'robots.txt': renderRobots({ production }),
        'sitemap.xml': renderSitemap({ production }),
        'site-build.json': JSON.stringify({ production, siteUrl: SITE_URL }),
      })) this.emitFile({ type: 'asset', fileName, source });
    },
  }, {
    name: 'include-font-license',
    generateBundle() {
      for (const name of ['Lato-OFL.txt', 'Lato-WOFF2.txt']) {
        this.emitFile({ type: 'asset', fileName: `assets/${name}`, source: readFileSync(new URL(`./assets/${name}`, import.meta.url), 'utf8') });
      }
    },
  }],
  build: {
    outDir: production ? 'dist-hosting' : 'dist',
    rolldownOptions: {
      input: Object.fromEntries(
        ['index', 'registration', 'privacy', 'consent', 'admin', 'checkout', 'order-terms'].map((page) => [
          page,
          fileURLToPath(new URL(`./${page}.html`, import.meta.url)),
        ]),
      ),
    },
  },
};
});
