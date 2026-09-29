import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { phpBinary } from '../scripts/php-runtime.mjs';
import { createOrdersDevMiddleware } from '../server/orders-dev.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const socket = net.createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise((resolve) => socket.close(resolve)); return port;
}
function client(origin) {
  let cookie = '', csrf = '';
  return async (url, { body, headers = {}, method = body ? 'POST' : 'GET' } = {}) => {
    const response = await fetch(origin + url, { method, signal: AbortSignal.timeout(15000), headers: {
      Accept: 'application/json', Cookie: cookie, ...(body ? { 'Content-Type': 'application/json', Origin: origin, 'X-CSRF-Token': csrf } : {}), ...headers,
    }, body: body ? JSON.stringify(body) : undefined });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch {}
    if (json?.csrfToken) csrf = json.csrfToken;
    return { status: response.status, json, text, headers: response.headers };
  };
}
function draft(id, version, type = 'pickup') {
  return { items: [{ id, quantity: 2 }], fulfilment: { type, timing: 'asap', requestedAt: null,
    address: type === 'delivery' ? { city: 'Тестовый город', streetHouse: 'Тестовая улица, 1', apartment: '2', entrance: '', floor: '', intercom: '' } : null,
    courierInstructions: type === 'delivery' ? 'Тестовые указания курьеру' : '' },
  contact: { name: 'Тестовый гость', phone: '+70000000000' }, orderComment: 'Тест: без исполнения', consent: { accepted: true, version } };
}
async function removeTemp(directory, prefix) {
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith(prefix));
  await rm(directory, { recursive: true, force: true });
}

test('assembled PHP ordering: private persistence, repricing, unknown fees and safe retries', { timeout: 90000 }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'vosem-order-http-'));
  const privateDir = path.join(temporary, 'vosem-utra-private');
  const site = path.join(temporary, 'site'); const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
  let process; let log = ''; const request = client(origin);
  async function start() {
    process = spawn(phpBinary, ['-S', `127.0.0.1:${port}`, '-t', site, path.join(root, 'hosting/dev-router.php')], {
      cwd: root, env: { ...globalThis.process.env, CAFE_ENV: 'development' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    process.stderr.on('data', chunk => { log += chunk.toString(); });
    for (let n = 0; n < 80; n++) {
      if (process.exitCode !== null) throw new Error(log);
      try { await request('/robots.txt'); return; } catch { await pause(50); }
    }
    throw new Error('PHP start failed');
  }
  async function stop() { if (process?.exitCode === null) { const stopped = once(process, 'exit'); process.kill(); await stopped; } }
  let body, menu, quote, original, created;
  try {
    await cp(path.join(root, 'dist-reg'), temporary, { recursive: true }); await start();
    await t.test('production-style defaults disable submissions and private paths are hidden', async () => {
      const disabled = await request('/api/ordering'); assert.equal(disabled.status, 200, disabled.text); assert.equal(disabled.json.enabled, false);
      assert.equal(disabled.headers.get('set-cookie'), null);
      for (const page of ['/checkout.html', '/order-terms.html']) {
        const response = await request(page); assert.equal(response.status, 200, response.text); assert.match(response.headers.get('x-robots-tag'), /noindex/);
        assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
      }
      for (const url of ['/orders-data/orders.sqlite', '/orders-data/orders.sqlite-journal', '/orders-config.php', '/vosem-utra-private/orders-data/orders.sqlite', '/api/orders/260101-00000001']) assert.equal((await request(url)).status, 404, url);
    });
    await writeFile(path.join(privateDir, 'orders-config.php'), "<?php return CafeOrders::developmentConfig();\n");
    await t.test('settings establish a guest session, quotes come from the current menu', async () => {
      const settings = await request('/api/ordering'); assert.equal(settings.status, 200, settings.text); assert.equal(settings.json.enabled, true);
      assert.equal(settings.json.mode, 'development'); assert.match(settings.json.notice, /Тест/);
      assert.equal(settings.json._guestToken, undefined); assert.ok(settings.json.availability.pickup.slots.length);
      assert.match(settings.headers.get('set-cookie'), /HttpOnly/); assert.match(settings.headers.get('set-cookie'), /SameSite=Strict/); assert.match(settings.headers.get('set-cookie'), /path=\/api/i);
      assert.equal(settings.headers.get('cache-control'), 'no-store');
      const terms = settings.json.settings.consent; assert.equal((await request(terms.url)).status, 200);
      menu = (await request('/api/menu')).json; body = draft(menu.items[0].id, terms.version);
      assert.equal((await request('/api/orders/quote', { body, headers: { Origin: 'https://other.example' } })).status, 403);
      assert.equal((await request('/api/orders/quote', { body, headers: { 'X-CSRF-Token': '' } })).status, 403);
      const result = await request('/api/orders/quote', { body }); assert.equal(result.status, 200, result.text); quote = result.json.quote;
      assert.equal(quote.menuRevision, menu.revision); assert.equal(quote.subtotalMinor, Math.round(menu.items[0].price * 100) * 2);
      assert.equal(quote.deliveryFeeMinor, 0); assert.equal(quote.totalMinor, quote.subtotalMinor);
      assert.equal(quote.fulfilment.address, null); assert.equal(quote.fulfilment.requestedAt, null);
      const delivery = await request('/api/orders/quote', { body: draft(menu.items[0].id, terms.version, 'delivery') });
      assert.equal(delivery.status, 200, delivery.text); assert.equal(delivery.json.quote.deliveryFeeMinor, null); assert.equal(delivery.json.quote.totalMinor, null);
    });
    await t.test('server reprices and requires explicit resubmission; no silent price change', async () => {
      const savedFile = path.join(privateDir, 'admin-data/menu.json'); const saved = JSON.parse(await readFile(savedFile, 'utf8'));
      saved.items.find(item => item.id === body.items[0].id).price += 1; saved.revision++;
      await writeFile(savedFile, JSON.stringify(saved));
      const changed = await request('/api/orders', { body: { ...body, quoteId: quote.quoteId, idempotencyKey: randomUUID() } });
      assert.equal(changed.status, 409, changed.text); assert.equal(changed.json.code, 'quote_changed');
      quote = changed.json.details.quote; assert.equal(quote.menuRevision, saved.revision);
      original = { ...body, quoteId: quote.quoteId, idempotencyKey: randomUUID() };
      const response = await request('/api/orders', { body: original }); assert.equal(response.status, 201, response.text); created = response.json.order;
      assert.equal(created.status, 'new'); assert.equal(created.totalMinor, quote.totalMinor);
      assert.deepEqual(created.payment, { method: null, status: 'not_configured', paidAmountMinor: null });
      assert.equal(created.contact, undefined); assert.equal(created.orderComment, undefined);
      const replay = await request('/api/orders', { body: original }); assert.equal(replay.status, 200); assert.deepEqual(replay.json.order, created);
      const conflict = await request('/api/orders', { body: { ...original, orderComment: 'Другой запрос' } }); assert.equal(conflict.status, 409); assert.equal(conflict.json.code, 'idempotency_conflict');
      assert.equal((await request('/api/orders/' + created.number)).status, 404);
    });
    await t.test('restart keeps acknowledgement; a now-unavailable dish blocks a new quote', async () => {
      await stop(); await start(); const replay = await request('/api/orders', { body: original });
      assert.equal(replay.status, 200, replay.text); assert.deepEqual(replay.json.order, created);
      const savedFile = path.join(privateDir, 'admin-data/menu.json'); const saved = JSON.parse(await readFile(savedFile, 'utf8'));
      saved.items.find(item => item.id === body.items[0].id).availableForOrder = false; saved.revision++;
      await writeFile(savedFile, JSON.stringify(saved));
      const unavailable = await request('/api/orders/quote', { body }); assert.equal(unavailable.status, 409); assert.equal(unavailable.json.code, 'item_unavailable');
      assert.deepEqual((await request('/api/orders', { body: original })).json.order, created);
    });
  } finally { await stop(); await removeTemp(temporary, 'vosem-order-http-'); }
});

test('Vite bridge uses PHP and current saved menu, and survives parallel startup', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vosem-order-bridge-'));
  await mkdir(path.join(directory, '.data'), { recursive: true }); await mkdir(path.join(directory, 'public/data'), { recursive: true });
  const seed = JSON.parse(await readFile(path.join(root, 'public/data/menu.json'), 'utf8'));
  await writeFile(path.join(directory, 'public/data/menu.json'), JSON.stringify(seed));
  seed.revision = 31; seed.items[0].price = 12.34; await writeFile(path.join(directory, '.data/menu.json'), JSON.stringify(seed));
  const bridge = createOrdersDevMiddleware({ projectRoot: directory });
  const server = http.createServer((req, res) => bridge.middleware(req, res, () => { res.writeHead(404); res.end(); }));
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${server.address().port}`;
    const request = client(origin);
    const responses = await Promise.all([request('/api/ordering'), request('/api/ordering')]);
    assert.ok(responses.every(response => response.status === 200), responses.map(response => response.text).join('\n'));
    const settings = await request('/api/ordering'); assert.equal(settings.json.enabled, true);
    const quote = await request('/api/orders/quote', { body: draft(seed.items[0].id, settings.json.settings.consent.version) });
    assert.equal(quote.status, 200, quote.text); assert.equal(quote.json.quote.menuRevision, 31); assert.equal(quote.json.quote.totalMinor, 2468);
    const denied = await new Promise((resolve, reject) => {
      http.get(origin + '/api/ordering', { headers: { Host: 'external.example' } }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject);
    });
    assert.equal(denied, 403);
    assert.equal((await request('/api/orders/12345')).status, 404);
  } finally {
    bridge.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    // Windows releases the SQLite directory after the owned PHP child exits.
    await pause(150); await removeTemp(directory, 'vosem-order-bridge-');
  }
});
