import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { phpBinary } from '../scripts/php-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const router = fileURLToPath(new URL('../hosting/orders-dev.php', import.meta.url));
const loopbackHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Vite uses exactly the PHP order service shipped to REG.RU. This bridge only
// runs on loopback, with a private per-process token and a separate test DB.
export function createOrdersDevMiddleware({ projectRoot = root, php = phpBinary } = {}) {
  const secret = randomBytes(32).toString('hex');
  let child, starting, port, closed = false;
  async function start() {
    if (closed) throw new Error('Bridge closed');
    if (starting) return starting;
    starting = (async () => {
      const reservation = net.createServer().listen(0, '127.0.0.1');
      await once(reservation, 'listening'); port = reservation.address().port;
      await new Promise((resolve) => reservation.close(resolve));
      child = spawn(php, ['-S', `127.0.0.1:${port}`, '-t', path.join(projectRoot, 'public'), router], {
        cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, CAFE_DEV_BRIDGE: secret, CAFE_DEV_PROJECT: projectRoot },
      });
      let failure;
      child.once('error', (error) => { failure = error; });
      child.once('exit', () => { starting = undefined; });
      for (let attempt = 0; attempt < 60; attempt++) {
        if (closed || failure || child.exitCode !== null) throw failure || new Error('PHP unavailable');
        try {
          const response = await fetch(`http://127.0.0.1:${port}/__health`, {
            headers: { 'X-Cafe-Dev-Bridge': secret }, signal: AbortSignal.timeout(400),
          });
          if (response.ok) return;
        } catch { /* Bounded startup wait. Never claim the order was saved. */ }
        await pause(50);
      }
      throw new Error('PHP startup timeout');
    })();
    try { await starting; } catch (error) { child?.kill(); starting = undefined; throw error; }
  }
  function error(res, status, message) {
    if (res.headersSent || res.destroyed) return res.destroy();
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    res.end(JSON.stringify({ error: message, code: 'ordering_unavailable' }));
  }
  async function middleware(req, res, next) {
    const pathname = (req.url || '').split('?')[0];
    if (!/^\/api\/(?:ordering|orders(?:\/.*)?|staff(?:\/.*)?)$/.test(pathname)) return next();
    if (!loopbackHost.test(req.headers.host || '') || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      return error(res, 403, 'Тестовый сервис доступен только локально.');
    }
    try {
      await start();
      if (res.destroyed || req.destroyed) return;
      const headers = { host: `127.0.0.1:${port}`, 'x-cafe-dev-bridge': secret, 'x-cafe-dev-origin': `http://${req.headers.host}` };
      for (const key of ['content-type', 'content-length', 'cookie', 'origin', 'x-csrf-token', 'idempotency-key', 'authorization', 'sec-fetch-site']) {
        if (req.headers[key] !== undefined) headers[key] = req.headers[key];
      }
      const upstream = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers }, (response) => {
        const forwarded = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (!['connection', 'transfer-encoding', 'keep-alive', 'x-powered-by', 'host'].includes(key)) forwarded[key] = value;
        }
        res.writeHead(response.statusCode, forwarded); response.pipe(res);
      });
      upstream.setTimeout(15000, () => upstream.destroy(new Error('PHP timeout')));
      upstream.on('error', () => error(res, 503, 'Не удалось получить ответ сервера. Повторите отправку, не меняя заявку.'));
      let size = 0;
      req.on('data', (chunk) => { size += chunk.length; if (size > 65536) { upstream.destroy(); error(res, 413, 'Слишком большой запрос.'); } });
      req.on('aborted', () => upstream.destroy());
      res.once('close', () => upstream.destroy());
      req.pipe(upstream);
    } catch { error(res, 503, 'Тестовое оформление недоступно. Проверьте локальный PHP и расширение PDO SQLite.'); }
  }
  function close() { closed = true; child?.kill(); process.removeListener('exit', close); }
  process.once('exit', close);
  return { middleware, close };
}
