import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMenuMiddleware } from './menu-api.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const distRoot = path.join(projectRoot, 'dist');
const middleware = createMenuMiddleware({ projectRoot });
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

async function serveStatic(req, res) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const segments = pathname.split('/').filter(Boolean);
    if (pathname.includes('\\') || pathname.includes('\0') || segments.some((segment) => segment.startsWith('.') || ['server', 'node_modules'].includes(segment))) throw new Error('Not found');
    let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (relative === 'admin' || relative === 'admin/') relative = 'admin.html';
    if (!mimeTypes[path.extname(relative)]) throw new Error('Not found');
    const root = await realpath(distRoot);
    const filename = await realpath(path.join(root, relative));
    const within = path.relative(root, filename);
    if (within.startsWith('..') || path.isAbsolute(within) || !(await stat(filename)).isFile()) throw new Error('Not found');
    const content = await readFile(filename);
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filename)], 'Content-Length': content.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': path.extname(filename) === '.html' || relative === 'data/menu.json' ? 'no-cache' : 'public, max-age=3600' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end('Страница не найдена');
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  middleware(req, res, () => serveStatic(req, res));
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1', () => {
  const address = server.address();
  console.log(`«Восемь утра»: http://${process.env.HOST ?? '127.0.0.1'}:${address.port}`);
});
