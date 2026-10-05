import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { createPhpDevMiddleware } from './server/php-dev.mjs';
import { SITE_URL, transformPage, renderRobots, renderSitemap } from './server/seo.mjs';
import { deliveryPages, profileHtml } from './scripts/site-profile.mjs';

export default defineConfig(({ mode, command }) => {
const env = loadEnv(mode, process.cwd(), '');
const delivery = mode.endsWith('-delivery');
const production = mode === 'hosting' || mode === 'hosting-delivery';
const staging = mode === 'hosting-test' || mode === 'hosting-test-delivery';
const seed = JSON.parse(readFileSync(new URL('./public/data/menu.json', import.meta.url), 'utf8'));
return {
  base: './',
  server: {
    host: '127.0.0.1',
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/*.{key,cafebackup,sqlite,sqlite-wal,sqlite-shm,sqlite-journal}', '**/.git/**', '**/.data/**', '**/_archive/**', '**/vosem-utra-private/**', '**/server/**', '**/hosting/**', '**/dist-reg/**', '**/dist-reg-test/**', '**/.php-preview/**', '**/orders-data/**', '**/kds-data/**', '**/kds-config.{json,php}'] },
    watch: { ignored: ['**/.data/**', '**/.php-preview/**', '**/dist-reg/**', '**/dist-reg-test/**', '**/dist-hosting/**', '**/dist-hosting-test/**'] },
  },
  plugins: [{
    name: 'cafe-module-profile',
    transformIndexHtml: { order: 'pre', handler: html => profileHtml(html, delivery) },
    configureServer(server) {
      if (!delivery) server.middlewares.use((req, res, next) => {
        if (/^\/(?:checkout|order-terms|staff|staff-demo)\.html(?:[?#]|$)/.test(req.url || '')) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Страница не найдена.');
        } else next();
      });
    },
  }, {
    name: 'cafe-php-api',
    configureServer(server) {
      const php = createPhpDevMiddleware({ deliveryEnabled: delivery });
      server.middlewares.use(php.middleware);
      server.httpServer?.once('close', php.close);
    },
    configurePreviewServer(server) {
      const php = createPhpDevMiddleware({ deliveryEnabled: delivery });
      server.middlewares.use(php.middleware);
      server.httpServer?.once('close', php.close);
    },
  }, {
    name: 'cafe-seo',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        const savedMenu = new URL('./.data/php-runtime/admin-data/menu.json', import.meta.url);
        const menu = command === 'serve' && existsSync(savedMenu) ? JSON.parse(readFileSync(savedMenu, 'utf8')) : seed;
        return transformPage(html, {
          page: context.filename, production, delivery, items:menu.items, categories:menu.categories,
          sourceCategories:menu.sourceCategories, categoryMappings:menu.categoryMappings,
          googleVerification: env.GOOGLE_SITE_VERIFICATION,
          yandexVerification: env.YANDEX_VERIFICATION,
        });
      },
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries({
        'robots.txt': renderRobots({ production }),
        'sitemap.xml': renderSitemap({ production }),
        'site-build.json': JSON.stringify({ production, delivery, siteUrl: SITE_URL }),
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
    outDir: staging ? 'dist-hosting-test' : production ? 'dist-hosting' : 'dist',
    rolldownOptions: {
      input: Object.fromEntries(
        ['index', 'registration', 'privacy', 'consent', 'admin', ...(delivery ? deliveryPages.filter(page => !staging || !page.startsWith('staff')) : [])].map((page) => [
          page,
          fileURLToPath(new URL(`./${page}.html`, import.meta.url)),
        ]),
      ),
    },
  },
};
});
