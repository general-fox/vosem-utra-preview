import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { phpBinary, phpEnvironment } from '../scripts/php-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const router = fileURLToPath(new URL('../hosting/api-dev.php', import.meta.url));
const loopbackHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/;
const apiPath = /^\/(?:api\/(?:admin(?:\/.*)?|menu|ordering|orders(?:\/.*)?|staff(?:\/.*)?|telegram(?:\/.*)?)|data\/menu\.json|uploads(?:\/.*)?)$/;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Vite serves editable assets only. Authentication, menu and orders run the SAME
// PHP classes as REG.RU, with a private loopback-only transport (not a public proxy).
export function createPhpDevMiddleware({ projectRoot = root, php = phpBinary, deliveryEnabled = true } = {}) {
  const secret = randomBytes(32).toString('hex');
  let child, starting, port, closed = false;
  async function start() {
    if (closed) throw new Error('Bridge closed');
    if (starting) return starting;
    starting = (async () => {
      const reservation = net.createServer().listen(0, '127.0.0.1');
      await once(reservation, 'listening'); port = reservation.address().port;
      await new Promise((resolve) => reservation.close(resolve));
      child = spawn(php, ['-d', 'upload_max_filesize=100M', '-d', 'post_max_size=110M', '-d', 'memory_limit=512M', '-S', `127.0.0.1:${port}`, '-t', path.join(projectRoot, 'public'), router], {
        cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...phpEnvironment, CAFE_ENV: 'development', CAFE_DEV_BRIDGE: secret, CAFE_DEV_PROJECT: projectRoot, CAFE_SITE_PROFILE: deliveryEnabled ? 'delivery' : 'catalog' },
      });
      let failure;
      child.once('error', (error) => { failure = error; });
      child.once('exit', () => { starting = undefined; });
      for (let attempt = 0; attempt < 60; attempt++) {
        if (closed || failure || child.exitCode !== null) throw failure || new Error('PHP unavailable');
        try {
          const response = await fetch(`http://127.0.0.1:${port}/__health`, { headers: { 'X-Cafe-Dev-Bridge': secret }, signal: AbortSignal.timeout(400) });
          if (response.ok) return;
        } catch { /* bounded startup, no credentials in logs */ }
        await pause(50);
      }
      throw new Error('PHP startup timeout');
    })();
    try { await starting; } catch (error) { child?.kill(); starting = undefined; throw error; }
  }
  function error(res, status, message) {
    if (res.headersSent || res.destroyed) return res.destroy();
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    res.end(JSON.stringify({ error: message, code: 'php_unavailable' }));
  }
  async function middleware(req, res, next) {
    if (!apiPath.test((req.url || '').split('?')[0])) return next();
    if (!loopbackHost.test(req.headers.host || '') || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      return error(res, 403, 'Локальный сервер доступен только на этом компьютере.');
    }
    const upload = (req.url || '').split('?')[0] === '/api/admin/upload' && req.method === 'POST';
    const maxSize = (upload ? 100 : 6) * 1024 * 1024;
    if (Number(req.headers['content-length'] || 0) > maxSize) return error(res, 413, 'Слишком большой запрос.');
    try {
      await start();
      if (res.destroyed || req.destroyed) return;
      const headers = { host: `127.0.0.1:${port}`, 'x-cafe-dev-bridge': secret, 'x-cafe-dev-origin': `http://${req.headers.host}` };
      for (const key of ['content-type', 'content-length', 'cookie', 'origin', 'sec-fetch-site', 'x-csrf-token', 'idempotency-key', 'authorization']) {
        if (req.headers[key] !== undefined) headers[key] = req.headers[key];
      }
      const upstream = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers }, (response) => {
        const forwarded = {};
        for (const [key, value] of Object.entries(response.headers)) if (!['connection', 'transfer-encoding', 'keep-alive', 'x-powered-by', 'host'].includes(key)) forwarded[key] = value;
        if (!res.headersSent && !res.destroyed) { res.writeHead(response.statusCode, forwarded); response.pipe(res); }
        else response.destroy();
      });
      upstream.setTimeout(upload ? 120000 : (req.url || '').split('?')[0] === '/api/admin/sync-availability' ? 95000 : 20000, () => upstream.destroy(new Error('PHP timeout')));
      upstream.on('error', () => error(res, 503, 'Не удалось получить ответ локального сервера. Повторите попытку.'));
      let size = 0;
      req.on('data', (chunk) => { size += chunk.length; if (size > maxSize) { error(res, 413, 'Слишком большой запрос.'); upstream.destroy(); } });
      req.on('aborted', () => upstream.destroy());
      res.once('close', () => upstream.destroy());
      req.pipe(upstream);
    } catch { error(res, 503, 'Локальный PHP-сервер недоступен. Проверьте PHP и выполните npm run local:prepare.'); }
  }
  function close() {
    closed = true;
    const exited = child?.pid && child.exitCode === null ? once(child, 'exit').catch(() => {}) : Promise.resolve();
    child?.kill(); process.removeListener('exit', close);
    return exited;
  }
  process.once('exit', close);
  return { middleware, close };
}
