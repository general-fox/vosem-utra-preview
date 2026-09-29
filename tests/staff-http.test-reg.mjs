import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { phpBinary } from '../scripts/php-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicOrigin = 'https://staff-test.invalid';
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function launchData(token, id, age = 0) {
  const data = { auth_date: String(Math.floor(Date.now() / 1000) - age), query_id: randomUUID(), user: JSON.stringify({ id, first_name: 'Тест' }) };
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  data.hash = createHmac('sha256', secret).update(Object.keys(data).sort().map(key => `${key}=${data[key]}`).join('\n')).digest('hex');
  return new URLSearchParams(data).toString();
}

test('assembled staff API authenticates Telegram, isolates roles and commits acceptance once', { timeout: 90000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vosem-staff-http-'));
  const site = path.join(directory, 'site'), privateDir = path.join(directory, 'vosem-utra-private');
  const socket = net.createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const config = { enabled: true, environment: 'production', botToken: '123456789:' + randomBytes(32).toString('base64url'), botUsername: 'vosem_utra_bot',
    webhookSecret: randomBytes(32).toString('hex'), webAppUrl: publicOrigin + '/staff.html',
    notifications: { mode: 'private', groupChatId: null, miniAppName: '' }, responsibleContact: '',
    staff: [101, 202, 303].map(id => ({ id: String(id), name: 'Тест ' + id, role: id === 303 ? 'manager' : 'employee', active: true })) };
  let child, log = '', cookie = '', csrf = '', alice, bob, manager, order, guestRequest, guestReceipt;
  async function request(url, { body, method = body ? 'POST' : 'GET', token, headers = {} } = {}) {
    const response = await fetch(origin + url, { method, signal: AbortSignal.timeout(15000), headers: {
      Accept: 'application/json', Cookie: cookie, ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json', Origin: publicOrigin, 'X-CSRF-Token': csrf } : {}), ...headers,
    }, body: body ? JSON.stringify(body) : undefined });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch {}
    if (json?.csrfToken) csrf = json.csrfToken;
    return { status: response.status, json, text, headers: response.headers };
  }
  async function saveConfig() { await writeFile(path.join(privateDir, 'test-telegram.json'), JSON.stringify(config)); }
  try {
    await cp(path.join(root, 'dist-reg'), directory, { recursive: true });
    await writeFile(path.join(privateDir, 'admin-config.php'), `<?php return ['publicOrigin'=>'${publicOrigin}'];\n`);
    await writeFile(path.join(privateDir, 'orders-config.php'), "<?php $c=CafeOrders::developmentConfig(); $c['mode']='production'; $c['termsApproved']=true; return $c;\n");
    await writeFile(path.join(privateDir, 'telegram-config.php'), "<?php return json_decode(file_get_contents(__DIR__.'/test-telegram.json'),true,32,JSON_THROW_ON_ERROR);\n");
    await saveConfig();
    // Test-only server metadata simulates the TLS terminator. No request header can enable this in production.
    const router = path.join(directory, 'test-router.php');
    const realRouter = path.join(root, 'hosting/dev-router.php').replaceAll('\\', '/').replaceAll("'", "\\'");
    await writeFile(router, `<?php $_SERVER['HTTPS']='on'; require '${realRouter}';\n`);
    child = spawn(phpBinary, ['-S', `127.0.0.1:${port}`, '-t', site, router], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CAFE_ENV: '' } });
    child.stderr.on('data', chunk => { log += chunk.toString(); });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('Fixture PHP server failed: ' + log);
      try { await request('/robots.txt'); break; } catch { await pause(50); }
      if (i === 99) throw new Error('Fixture PHP server did not start');
    }
    await t.test('only the staff page permits Telegram framing; private files and unauthenticated API stay closed', async () => {
      const page = await request('/staff.html'); assert.equal(page.status, 200, page.text);
      assert.match(page.headers.get('content-security-policy'), /frame-ancestors https:\/\/web\.telegram\.org/);
      assert.match(page.headers.get('content-security-policy'), /script-src[^;]+https:\/\/telegram\.org/);
      assert.equal(page.headers.get('x-frame-options'), null); assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
      assert.match(page.headers.get('x-robots-tag'), /noindex/);
      const admin = await request('/admin.html'); assert.equal(admin.headers.get('x-frame-options'), 'DENY');
      assert.match(admin.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      const demo = await request('/staff-demo.html'); assert.equal(demo.status, 200); assert.doesNotMatch(demo.text, /telegram\.org\/js/);
      for (const url of ['/telegram-config.php', '/telegram-worker.php', '/telegram-setup.php', '/test-telegram.json', '/orders-data/orders.sqlite', '/vosem-utra-private/telegram-config.php']) assert.equal((await request(url)).status, 404, url);
      assert.equal((await request('/api/staff/orders/search', { body: {} })).status, 401);
      const webhook = await request('/api/telegram/webhook', { body: { update_id: 1 } }); assert.equal(webhook.status, 403);
      const legitimate = { body: { update_id: 1 }, headers: { 'X-Telegram-Bot-Api-Secret-Token': config.webhookSecret } };
      assert.equal((await request('/api/telegram/webhook', legitimate)).status, 200);
      assert.equal((await request('/api/telegram/webhook', legitimate)).status, 200);
    });
    await t.test('raw signed launch is required, fresh, allowlisted and same-origin', async () => {
      const login = id => request('/api/staff/session', { body: { initData: launchData(config.botToken, id) } });
      assert.equal((await request('/api/staff/session', { body: { initData: launchData(config.botToken, 101, 301) } })).status, 401);
      assert.equal((await request('/api/staff/session', { body: { initData: launchData(config.botToken, 101) + '&hash=' + '0'.repeat(64) } })).status, 401);
      assert.equal((await request('/api/staff/session', { body: { initData: launchData(config.botToken, 101) }, headers: { Origin: 'https://foreign.invalid' } })).status, 403);
      assert.equal((await login(999)).status, 403);
      const first = await login(101); assert.equal(first.status, 200, first.text); alice = first.json.token;
      assert.match(alice, /^[a-f0-9]{64}$/); assert.equal(first.json.staff.role, 'employee');
      assert.equal(first.headers.get('set-cookie'), null); assert.equal(first.headers.get('cache-control'), 'no-store');
      bob = (await login(202)).json.token; manager = (await login(303)).json.token;
      assert.equal((await request('/api/staff/session?token=' + alice)).status, 401);
      assert.equal((await request('/api/staff/notifications', { token: alice })).status, 403);
      assert.equal((await request('/api/staff/notifications', { token: manager })).status, 200);
      const settings = await request('/api/staff/settings', { token: manager }); assert.equal(settings.status, 200, settings.text); assert.equal(settings.json.staff.length, 3);
      assert.equal((await request('/api/staff/settings', { token: alice })).json.staff.length, 0);
      assert.notEqual((await request('/api/admin/session', { token: manager })).json?.authenticated, true);
    });
    await t.test('guest creation enters the staff queue and simultaneous claims keep one owner', async () => {
      const settings = await request('/api/ordering'); assert.equal(settings.json.enabled, true, settings.text);
      const menu = (await request('/api/menu')).json;
      const draft = { items: [{ id: menu.items[0].id, quantity: 2 }], contact: { name: 'Тестовый гость', phone: '+70000000000' },
        fulfilment: { type: 'pickup', timing: 'asap', requestedAt: null, address: null, courierInstructions: '' }, orderComment: 'Тест без исполнения', consent: { accepted: true, version: settings.json.settings.consent.version } };
      const quoted = await request('/api/orders/quote', { body: draft }); assert.equal(quoted.status, 200, quoted.text);
      guestRequest = { ...draft, quoteId: quoted.json.quote.quoteId, idempotencyKey: randomUUID() };
      const created = await request('/api/orders', { body: guestRequest }); assert.equal(created.status, 201, created.text); guestReceipt = created.json.order;
      const found = await request('/api/staff/orders/search', { token: alice, body: { status: 'new', query: '+7 (000) 000-00-00', page: 1 } });
      assert.equal(found.status, 200, found.text); assert.equal(found.json.total, 1); order = found.json.orders[0];
      assert.equal(order.contact.phone, draft.contact.phone); assert.equal(order.number, guestReceipt.number);
      const claims = await Promise.all([alice, bob].map(token => request(`/api/staff/orders/${order.id}/claim`, { token, body: { expectedVersion: 1 } })));
      assert.deepEqual(claims.map(x => x.status).sort(), [200, 409]);
      order = claims.find(x => x.status === 200).json.order;
      if (order.assignee.id === '202') [alice, bob] = [bob, alice];
      assert.equal((await request(`/api/staff/orders/${order.id}/release`, { token: bob, body: { expectedVersion: order.version } })).status, 403);
    });
    await t.test('current menu lock, staff save, acceptance replay and readonly final order work together', async () => {
      const settings = (await request('/api/staff/settings', { token: alice })).json;
      const body = { expectedVersion: order.version, items: order.items.map(({ id, quantity }) => ({ id, quantity })), contact: order.contact,
        fulfilment: { ...order.fulfilment, confirmedAt: settings.availability.pickup.slots[0] }, deliveryFeeMinor: 0,
        staffNote: 'Внутренняя тестовая заметка', fulfillmentComment: 'Тестовая упаковка' };
      const saved = await request(`/api/staff/orders/${order.id}`, { method: 'PATCH', token: alice, body });
      assert.equal(saved.status, 200, saved.text); order = saved.json.order;
      const accept = { expectedVersion: order.version, agreed: true };
      assert.equal((await request(`/api/staff/orders/${order.id}/accept`, { token: alice, body: accept })).status, 400);
      const key = randomUUID(), options = { token: alice, body: accept, headers: { 'Idempotency-Key': key } };
      const accepted = await request(`/api/staff/orders/${order.id}/accept`, options);
      assert.equal(accepted.status, 200, accepted.text); assert.equal(accepted.json.order.status, 'accepted');
      assert.equal(accepted.json.integration.status, 'waiting_configuration');
      const replay = await request(`/api/staff/orders/${order.id}/accept`, options); assert.equal(replay.status, 200); assert.deepEqual(replay.json, accepted.json);
      const modified = await request(`/api/staff/orders/${order.id}`, { method: 'PATCH', token: alice, body: { ...body, expectedVersion: accepted.json.order.version } });
      assert.equal(modified.status, 409); assert.equal(modified.json.code, 'read_only');
      assert.deepEqual((await request('/api/orders', { body: guestRequest })).json.order, guestReceipt);
      const retry = await request(`/api/staff/events/${accepted.json.integration.eventId}/retry`, { token: manager, body: { expectedVersion: accepted.json.order.version } });
      assert.equal(retry.status, 409, retry.text); assert.equal(retry.json.code, 'retry_unavailable');
      assert.equal((await request(`/api/staff/orders/${order.id}`, { token: manager })).json.integration.eventId, accepted.json.integration.eventId);
    });
    await t.test('revocation affects an existing session immediately and logout deletes it', async () => {
      const current = (await request('/api/staff/session', { token: alice })).json.staff.id;
      config.staff.find(person => person.id === current).active = false; await saveConfig();
      const revoked = await request(`/api/staff/orders/${order.id}`, { token: alice }); assert.equal(revoked.status, 403, revoked.text);
      assert.equal((await request('/api/staff/logout', { token: manager, body: {} })).status, 200);
      assert.equal((await request('/api/staff/session', { token: manager })).status, 401);
    });
  } finally {
    if (child?.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('vosem-staff-http-'));
    await rm(directory, { recursive: true, force: true });
  }
});
