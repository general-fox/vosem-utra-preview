import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { createPhpDevMiddleware } from './server/php-dev.mjs';
import { SITE_URL, transformPage, renderRobots, renderSitemap } from './server/seo.mjs';

export default defineConfig(({ mode, command }) => {
const env = loadEnv(mode, process.cwd(), '');
const production = mode === 'hosting';
const seed = JSON.parse(readFileSync(new URL('./public/data/menu.json', import.meta.url), 'utf8'));
return {
  base: './',
  server: {
    host: '127.0.0.1',
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/*.{key,cafebackup,sqlite,sqlite-wal,sqlite-shm,sqlite-journal}', '**/.git/**', '**/.data/**', '**/_archive/**', '**/vosem-utra-private/**', '**/server/**', '**/hosting/**', '**/dist-reg/**', '**/.php-preview/**', '**/orders-data/**'] },
    watch: { ignored: ['**/.data/**', '**/.php-preview/**', '**/dist-reg/**', '**/dist-hosting/**'] },
  },
  plugins: [{
    name: 'cafe-php-api',
    configureServer(server) {
      const php = createPhpDevMiddleware();
      server.middlewares.use(php.middleware);
      server.httpServer?.once('close', php.close);
    },
    configurePreviewServer(server) {
      const php = createPhpDevMiddleware();
      server.middlewares.use(php.middleware);
      server.httpServer?.once('close', php.close);
    },
  }, {
    name: 'cafe-seo',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        const savedMenu = new URL('./.data/php-runtime/admin-data/menu.json', import.meta.url);
        const items = command === 'serve' && existsSync(savedMenu) ? JSON.parse(readFileSync(savedMenu, 'utf8')).items : seed.items;
        return transformPage(html, {
          page: context.filename, production, items,
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
        ['index', 'registration', 'privacy', 'consent', 'admin', 'checkout', 'order-terms', 'staff', 'staff-demo'].map((page) => [
          page,
          fileURLToPath(new URL(`./${page}.html`, import.meta.url)),
        ]),
      ),
    },
  },
};
});
