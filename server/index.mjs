import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMenuMiddleware, validateItems } from './menu-api.mjs';
import { SITE_URL, transformPage, renderRobots, renderSitemap } from './seo.mjs';
import { securityHeaders, secureHtml } from './http-security.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

export async function createSiteServer(options = {}) {
  const projectRoot = options.projectRoot ?? ROOT;
  const production = options.production ?? process.env.NODE_ENV !== 'development';
  const distRoot = await realpath(options.distRoot ?? path.join(projectRoot, production ? 'dist-hosting' : 'dist'));
  const dataDir = options.dataDir ?? path.join(projectRoot, '.data');
  const publicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? '';
  const verification = {
    googleVerification: options.googleVerification ?? process.env.GOOGLE_SITE_VERIFICATION ?? '',
    yandexVerification: options.yandexVerification ?? process.env.YANDEX_VERIFICATION ?? '',
  };
  const manifest = JSON.parse(await readFile(path.join(distRoot, 'site-build.json'), 'utf8'));
  if (manifest.production !== production || (production && manifest.siteUrl !== SITE_URL)) {
    throw new Error('Неверный режим сборки. Для хостинга выполните npm run build:hosting.');
  }
  const middleware = createMenuMiddleware({ ...options, projectRoot, dataDir, production, publicOrigin: publicOrigin || undefined });

  async function currentMenu() {
    let saved;
    try {
      saved = JSON.parse(await readFile(path.join(dataDir, 'menu.json'), 'utf8'));
      if (!Number.isSafeInteger(saved.revision) || saved.revision < 1) throw new Error('Invalid menu revision');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      saved = JSON.parse(await readFile(path.join(projectRoot, 'public/data/menu.json'), 'utf8'));
    }
    return validateItems(saved.items);
  }

  function respond(req, res, status, type, content, cache = 'no-store') {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': cache });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function serveStatic(req, res) {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      return respond(req, res, 405, 'text/plain; charset=utf-8', 'Метод не поддерживается');
    }
    let url, pathname;
    try { url = new URL(req.url, 'http://localhost'); pathname = decodeURIComponent(url.pathname); }
    catch { return respond(req, res, 400, 'text/plain; charset=utf-8', 'Некорректный адрес'); }
    if (pathname === '/index.html' || pathname === '/admin' || pathname === '/admin/') {
      res.writeHead(308, { Location: `${pathname === '/index.html' ? '/' : '/admin.html'}${url.search}`, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    if (pathname === '/robots.txt') return respond(req, res, 200, 'text/plain; charset=utf-8', renderRobots({ production }), 'no-cache');
    if (pathname === '/sitemap.xml') return respond(req, res, 200, 'application/xml; charset=utf-8', renderSitemap({ production }), 'no-cache');
    const segments = pathname.split('/').filter(Boolean);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    let filename;
    try {
      if (pathname.includes('\\') || pathname.includes('\0') || segments.some((segment) => segment.startsWith('.') || ['server', 'node_modules'].includes(segment.toLowerCase())) || relative.toLowerCase() === 'site-build.json' || !mimeTypes[path.extname(relative)]) throw new Error('Not found');
      filename = await realpath(path.join(distRoot, relative));
      const within = path.relative(distRoot, filename);
      if (within.startsWith('..') || path.isAbsolute(within) || !(await stat(filename)).isFile()) throw new Error('Not found');
    } catch {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      return respond(req, res, 404, 'text/plain; charset=utf-8', 'Страница не найдена');
    }
    let content = await readFile(filename);
    if (path.extname(filename) === '.html') {
      const page = path.basename(filename, '.html');
      try {
        content = transformPage(content.toString('utf8'), { page, production, items: page === 'index' ? await currentMenu() : [], ...verification });
      } catch {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        return respond(req, res, 503, 'text/plain; charset=utf-8', 'Сайт временно недоступен. Пожалуйста, повторите позже.');
      }
      if (!production || page !== 'index') res.setHeader('X-Robots-Tag', production && ['privacy', 'consent'].includes(page) ? 'noindex, follow' : 'noindex, nofollow');
      content = secureHtml(content, res);
    }
    respond(req, res, 200, mimeTypes[path.extname(filename)], content, path.extname(filename) === '.html' ? 'no-store' : 'public, max-age=3600');
  }

  const server = http.createServer((req, res) => {
    securityHeaders(res, { production, publicOrigin });
    if (!production || req.url?.startsWith('/api/') || req.url?.startsWith('/data/')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    Promise.resolve(middleware(req, res, () => serveStatic(req, res))).catch(() => {
      if (res.headersSent) { res.destroy(); return; }
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      respond(req, res, 500, 'text/plain; charset=utf-8', 'Не удалось выполнить запрос.');
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = await createSiteServer();
  const host = process.env.HOST ?? '127.0.0.1';
  server.listen(Number(process.env.PORT ?? 3000), host, () => {
    console.log(`«Восемь утра»: http://${host}:${server.address().port}`);
  });
}
