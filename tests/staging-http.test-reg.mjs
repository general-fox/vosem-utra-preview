import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { phpBinary, phpEnvironment } from '../scripts/php-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const targetOrigin = 'https://test888.ru';
const php = args => spawnSync(phpBinary, args, { env: phpEnvironment, windowsHide: true, encoding: 'utf8' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('test888 package: isolated HTTPS ordering, password login and no Telegram or external delivery', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cafe-staging-'));
  const packageDir = path.join(directory, 'package'), privateDir = path.join(packageDir, 'vosem-utra-private');
  const source = path.join(directory, 'source'), notes = path.join(directory, 'access.txt');
  let child, port, origin;
  t.after(async () => {
    await stop();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('cafe-staging-'));
    await rm(directory, { recursive: true, force: true });
  });
  await cp(path.join(root, 'dist-reg-test'), packageDir, { recursive: true });
  const prepared = php([path.join(root, 'hosting/prepare-access.php'), source]); assert.equal(prepared.status, 0, prepared.stderr);
  await mkdir(path.join(source, 'admin-data'), { recursive: true });
  const seed = JSON.parse(await readFile(path.join(root, 'public/data/menu.json'), 'utf8')); seed.revision = 23;
  await writeFile(path.join(source, 'admin-data/menu.json'), JSON.stringify(seed));
  const provision = php([path.join(root, 'hosting/staging/prepare-test.php'), 'fresh', privateDir, notes, source]);
  assert.equal(provision.status, 0, provision.stderr);
  const note = await readFile(notes, 'utf8');
  assert.doesNotMatch(note,/аутентификатор|резервные коды|QR/);
  const username = note.match(/^Логин: (.+)$/m)[1], password = note.match(/^Временный пароль: (.+)$/m)[1];
  const accountBefore = await readFile(path.join(privateDir, 'admin-data/auth-state.json'));
  assert.notEqual(php([path.join(root, 'hosting/staging/prepare-test.php'), 'fresh', privateDir, notes, source]).status, 0);
  assert.deepEqual(await readFile(path.join(privateDir, 'admin-data/auth-state.json')), accountBefore);
  const router = path.join(directory, 'router.php');
  await writeFile(router, `<?php $_SERVER['HTTPS']='on'; return require '${path.join(root, 'hosting/dev-router.php').replaceAll('\\', '/').replaceAll("'", "\\'")}';\n`);
  const reservation = net.createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening');
  port = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); origin = `http://127.0.0.1:${port}`;
  async function start() {
    child = spawn(phpBinary, ['-S', `127.0.0.1:${port}`, '-t', path.join(packageDir, 'site'), router], { env: { ...phpEnvironment, CAFE_ENV: '' }, windowsHide: true, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { await (await fetch(origin + '/robots.txt')).text(); return; } catch { await pause(50); } }
    throw new Error('Test PHP did not start');
  }
  async function stop() { if (child?.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; } }
  const cookies = new Map(); let csrf;
  async function request(route, { body, method = body ? 'POST' : 'GET', headers = {} } = {}) {
    const response = await fetch(origin + route, { method, headers: { Origin: targetOrigin,
      Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    for (const value of response.headers.getSetCookie()) { const pair = value.split(';')[0], i = pair.indexOf('='); cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch {}
    if (json?.csrfToken) csrf = json.csrfToken;
    return { status: response.status, json, text, headers: response.headers };
  }
  await start();
  await t.test('package contains no staff app or bot; deployment stays noindex and private files are unavailable', async () => {
    for (const folder of [privateDir, path.join(privateDir, 'app'), path.join(privateDir, 'app/templates'), path.join(packageDir, 'site/assets')]) {
      for (const name of await readdir(folder)) assert.doesNotMatch(name, /^(staff|telegram)/, name);
    }
    const rules = await readFile(path.join(packageDir, 'site/.htaccess'), 'utf8'); assert.match(rules, /acme-challenge/); assert.doesNotMatch(rules, /Header always unset X-Frame-Options/);
    for (const page of ['/', '/admin.html', '/checkout.html', '/registration.html']) {
      const response = await request(page); assert.equal(response.status, 200, response.text);
      assert.match(response.headers.get('x-robots-tag'), /noindex/); assert.match(response.text, /cafe-test-banner/);
      assert.doesNotMatch(response.text, /rel="canonical"|application\/ld\+json|telegram\.org\/js/);
    }
    assert.doesNotMatch((await request('/sitemap.xml')).text, /<loc>/);
    for (const route of ['/staff.html', '/staff-demo.html', '/api/staff/session', '/api/telegram/webhook', '/admin-config.php', '/orders-config.php', '/vosem-utra-private/admin-config.php', '/orders-data/orders.sqlite']) assert.equal((await request(route)).status, 404, route);
    const club = await request('/api/register.php', { body: {} }); assert.equal(club.status, 503); assert.match(club.json.Message, /тестовом стенде отключена/);
    const menu = (await request('/api/menu')).json; assert.equal(menu.revision, 23);
    for (const item of menu.items.filter(item => item.image)) {
      const photo = await fetch(new URL(item.image, origin)); assert.equal(photo.status, 200, item.id);
      assert.match(photo.headers.get('content-type'), /^image\//); assert.ok((await photo.arrayBuffer()).byteLength > 0);
    }
  });
  await t.test('fresh test administrator must replace the temporary password and log in before editing', async () => {
    assert.equal((await request('/api/admin/menu')).status, 401);
    const login = await request('/api/admin/login', { body: { username, password } }); assert.equal(login.status, 202, login.text);
    assert.equal(login.json.passwordChangeRequired, true);
    assert.equal(login.headers.get('set-cookie'), null);
    assert.equal((await request('/api/admin/menu')).status, 401);
    assert.equal((await request('/api/admin/enroll/start', { body: {} })).status,404);
    const same = await request('/api/admin/password-reset/complete', {body:{passwordToken:login.json.passwordToken,password}});
    assert.equal(same.status,400,'The temporary password cannot be kept');
    const changed = await request('/api/admin/password-reset/complete', {body:{passwordToken:login.json.passwordToken,password:'new-test888-password-only'}});
    assert.equal(changed.status,200,changed.text);assert.equal(changed.json.passwordChanged,true);
    assert.equal((await request('/api/admin/menu')).status,401,'Changing a password alone does not start a session');
    assert.equal((await request('/api/admin/login', {body:{username,password}})).status,401,'The old temporary password is revoked');
    const confirmed = await request('/api/admin/login', {body:{username,password:'new-test888-password-only'}});
    assert.equal(confirmed.status, 200, confirmed.text); assert.equal(confirmed.json.authenticated, true);
    const menu = (await request('/api/admin/menu')).json; menu.items[0].price += 1;
    assert.equal((await request('/api/admin/menu', { method: 'PUT', body: menu, headers: { 'X-CSRF-Token': 'bad' } })).status, 403);
    assert.equal((await request('/api/admin/menu', { method: 'PUT', body: menu })).status, 200);
    assert.equal((await request('/api/menu')).json.revision, 24);
  });
  await t.test('test order persists, replay survives restart, unknown delivery stays unknown and KDS has no sent receipt', async () => {
    const settings = await request('/api/ordering'); assert.equal(settings.json.enabled, true); assert.equal(settings.json.mode, 'staging');
    assert.match(settings.headers.get('set-cookie'), /Secure/i);
    const item = (await request('/api/menu')).json.items[0];
    const draft = { items: [{ id: item.id, quantity: 2 }], contact: { name: 'Тест', phone: '+70000000000' },
      fulfilment: { type: 'pickup', timing: 'asap', requestedAt: null, address: null, courierInstructions: '' }, orderComment: '', consent: { accepted: true, version: settings.json.settings.consent.version } };
    assert.equal((await request('/api/orders/quote', { body: draft, headers: { Origin: 'https://vosem-utra.ru' } })).status, 403);
    assert.equal((await request('/api/orders/quote', { body: draft, headers: { 'X-CSRF-Token': 'bad' } })).status, 403);
    const quote = await request('/api/orders/quote', { body: draft }); assert.equal(quote.status, 200, quote.text);
    const body = { ...draft, quoteId: quote.json.quote.quoteId, idempotencyKey: randomUUID() };
    const created = await request('/api/orders', { body }); assert.equal(created.status, 201, created.text); assert.match(created.json.order.number, /^TEST-/);
    assert.equal(created.json.order.payment.status, 'not_configured'); assert.equal(created.json.order.status, 'new');
    await stop(); await start();
    const replay = await request('/api/orders', { body }); assert.equal(replay.status, 200); assert.deepEqual(replay.json.order, created.json.order);
    const delivery = { ...draft, fulfilment: { ...draft.fulfilment, type: 'delivery', address: { city: 'Тест', streetHouse: 'Вымышленная, 1' } } };
    const deliveryQuote = await request('/api/orders/quote', { body: delivery }); assert.equal(deliveryQuote.status, 200, deliveryQuote.text);
    assert.equal(deliveryQuote.json.quote.deliveryFeeMinor, null); assert.equal(deliveryQuote.json.quote.totalMinor, null);
    const check = php(['-r', '$db=new PDO("sqlite:".$argv[1]); if ($db->query("SELECT count(*) FROM orders")->fetchColumn()!=1 || $db->query("SELECT count(*) FROM integration_events")->fetchColumn()!=0 || $db->query("SELECT count(*) FROM outbox WHERE status <> \'pending\'")->fetchColumn()!=0) exit(1);', path.join(privateDir, 'orders-data/orders.sqlite')]);
    assert.equal(check.status, 0, check.stderr);
  });
  await t.test('KDS update preserves the account, appends mapped dishes, and protects order tracking over HTTP', async () => {
    const savedAuth = await readFile(path.join(privateDir, 'admin-data/auth-state.json'));
    const testItem = { ...seed.items[0], id: 'test-kds-dish', name: 'Тест КДС', price: 200, published: true, availableForOrder: true };
    await writeFile(path.join(privateDir, 'kds-config.json'), JSON.stringify({ enabled: true, enableTestOrders: true, environment: 'staging',
      organizationId: 'baa06e7a-b091-4296-97bc-275bc22d9af9', baseUrl: 'https://kds.invalid/api/v1', serviceName: 'fixture', servicePassword: 'fixture-secret',
      menuMap: { 'test-kds-dish': '1012080' }, testItems: [testItem] }));
    const settings = (await request('/api/ordering')).json; assert.equal(settings.kds.enabled, true);
    const menu = (await request('/api/menu')).json; assert.equal(menu.items.length, seed.items.length + 1);
    assert.deepEqual(menu.items.filter(item => item.availableForOrder).map(item => item.id), ['test-kds-dish']);
    const draft = { items: [{ id: testItem.id, quantity: 1 }], contact: { name: 'Тест', phone: '+70000000000' },
      fulfilment: { type: 'pickup', timing: 'asap', requestedAt: null, address: null, courierInstructions: '' }, orderComment: '', consent: { accepted: true, version: settings.settings.consent.version } };
    const quote = await request('/api/orders/quote', { body: draft }); assert.equal(quote.status, 200, quote.text);
    const body = { ...draft, quoteId: quote.json.quote.quoteId, idempotencyKey: randomUUID() };
    const created = await request('/api/orders', { body }); assert.equal(created.status, 201, created.text);
    const id = created.json.order.trackingId; assert.match(id, /^[a-f0-9]{32}$/);
    const route = `/api/orders/${id}`;
    const tracked = await request(route + '/status'); assert.equal(tracked.status, 200, tracked.text); assert.equal(tracked.json.delivery.state, 'queued');
    assert.doesNotMatch(tracked.text, /fixture-secret|externalGuid|serviceName/);
    assert.equal((await request(route + '/status', { headers: { Cookie: '' } })).status, 403);
    assert.equal((await request(route + '/sync', { body: {}, headers: { 'X-CSRF-Token': 'bad' } })).status, 403);
    assert.equal((await request(route + '/sync', { body: {}, headers: { Origin: 'https://elsewhere.example' } })).status, 403);
    assert.equal((await request(route + '/sync')).status, 405);
    assert.deepEqual((await request('/api/orders', { body })).json.order, created.json.order);
    for (const name of ['/kds-config.json', '/kds-data/anything.json']) assert.equal((await request(name)).status, 404);
    const count = php(['-r', '$db=new PDO("sqlite:".$argv[1]); if ($db->query("SELECT count(*) FROM kds_jobs")->fetchColumn()!=1 || $db->query("SELECT count(*) FROM kds_jobs WHERE state=\'queued\'")->fetchColumn()!=1) exit(1);', path.join(privateDir, 'orders-data/orders.sqlite')]);
    assert.equal(count.status, 0, count.stderr); assert.deepEqual(await readFile(path.join(privateDir, 'admin-data/auth-state.json')), savedAuth);
  });
});

test('staging conditions cannot enable real orders without the explicit HTTPS test profile', () => {
  const script = `require 'hosting/php/orders.php'; $c=CafeOrders::developmentConfig(); $c['mode']='staging'; $base=['public_origin'=>'https://test888.ru','staging'=>true,'orders_environment'=>'staging','indexing'=>false]; foreach ([['staging'=>false],['public_origin'=>'https://vosem-utra.ru'],['public_origin'=>'https://www.vosem-utra.ru'],['public_origin'=>'http://test888.ru'],['indexing'=>true],['orders_environment'=>'production']] as $change) { $o=new CafeOrders(sys_get_temp_dir(),array_replace($base,$change),static fn():array=>[],$c); if ($o->settings()['enabled']) exit(1); }`;
  const result = php(['-r', script]); assert.equal(result.status, 0, result.stderr);
});
