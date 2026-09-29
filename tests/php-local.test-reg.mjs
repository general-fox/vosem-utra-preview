import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeEnrolledAccount, atomicAuthWrite, additionalAccountFile } from '../server/auth.mjs';
import { addAdministrator } from '../server/add-admin.mjs';
import { totp } from '../server/totp.mjs';
import { prepareLocalPhp } from '../scripts/prepare-local-php.mjs';
import { createPhpDevMiddleware } from '../server/php-dev.mjs';
import { phpBinary, phpEnvironment } from '../scripts/php-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const PASSWORD = 'test-portable-password-very-long';
const SECRET = 'JBSWY3DPEHPK3PXP';
const PHOTO = '11111111-2222-4333-a444-555555555555.png';
const KEY = randomBytes(32);
const php = (args, input) => spawnSync(phpBinary, args, { env: phpEnvironment, input, encoding: 'utf8', windowsHide: true });
const transfer = (...args) => php([path.join(root, 'hosting/php/private-data.php'), ...args]);
async function fixture(t) {
  const project = await mkdtemp(path.join(os.tmpdir(), 'cafe-php-local-'));
  let cleanup = async () => {};
  t.after(async () => {
    await cleanup();
    assert.equal(path.dirname(project), path.resolve(os.tmpdir())); assert.ok(path.basename(project).startsWith('cafe-php-local-'));
    await rm(project, { recursive: true, force: true });
  });
  await mkdir(path.join(project, 'public/data'), { recursive: true });
  await cp(path.join(root, 'public/data/menu.json'), path.join(project, 'public/data/menu.json'));
  const data = path.join(project, '.data'); await mkdir(data);
  const owner = await makeEnrolledAccount({ username: 'owner@example.test', password: PASSWORD, secret: SECRET, code: totp(SECRET, { time: Date.now() - 120000 }), key: KEY, time: Date.now() - 120000 });
  await atomicAuthWrite(path.join(data, 'admin-auth.json'), owner.account);
  await writeFile(path.join(data, 'auth-key'), KEY.toString('hex'));
  const employee = await addAdministrator({ dataDir: data, username: 'employee@example.test' });
  const tempPassword = (await readFile(employee.accessFile, 'utf8')).match(/^Временный пароль: (.+)$/m)[1];
  const beforeEmployee = JSON.parse(await readFile(additionalAccountFile(data, 'employee@example.test'), 'utf8'));
  const menu = JSON.parse(await readFile(path.join(project, 'public/data/menu.json'), 'utf8'));
  menu.revision = 7; menu.items[0].image = `/uploads/${PHOTO}`;
  await writeFile(path.join(data, 'menu.json'), JSON.stringify(menu));
  await mkdir(path.join(data, 'uploads'));
  await writeFile(path.join(data, 'uploads', PHOTO), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGf8AAAAASUVORK5CYII=', 'base64'));
  return { project, data, owner, menu, tempPassword, beforeEmployee, runtime: path.join(data, 'php-runtime'), beforeCleanup: (handler) => { cleanup = handler; } };
}

test('one-time Node to PHP migration preserves every password, TOTP, recovery code, expiry, menu and photo', async (t) => {
  const app = await fixture(t);
  await assert.rejects(prepareLocalPhp({ projectRoot: app.project, passwordProvider: async () => 'wrong-password' }), /не подтверждён/);
  const result = await prepareLocalPhp({ projectRoot: app.project, passwordProvider: async (username) => { assert.equal(username, 'owner@example.test'); return PASSWORD; } });
  assert.equal(result.accounts, 2); assert.equal(result.items, app.menu.items.length);
  const state = JSON.parse(await readFile(path.join(app.runtime, 'admin-data/auth-state.json'), 'utf8'));
  assert.deepEqual(state.account.totp, app.owner.account.totp);
  assert.deepEqual(state.account.recovery, app.owner.account.recovery);
  assert.equal(state.accounts['employee@example.test'].initialExpiresAt, app.beforeEmployee.initialExpiresAt);
  const verified = php(['-r', `$s=json_decode(file_get_contents($argv[1]),true); $p=json_decode(stream_get_contents(STDIN),true); if (!password_verify($p[0],$s['account']['passwordHash']) || !password_verify($p[1],$s['accounts']['employee@example.test']['passwordHash'])) exit(1);`, path.join(app.runtime, 'admin-data/auth-state.json')], JSON.stringify([PASSWORD, app.tempPassword]));
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(JSON.parse(await readFile(path.join(app.runtime, 'admin-data/menu.json'))), app.menu);
  assert.deepEqual(await readFile(path.join(app.runtime, 'admin-data/uploads', PHOTO)), await readFile(path.join(app.data, 'uploads', PHOTO)));
  assert.deepEqual(JSON.parse(await readFile(path.join(app.data, 'admin-auth.json'))), app.owner.account);
  assert.deepEqual(await readFile(path.join(result.backup, 'admin-auth.json')), await readFile(path.join(app.data, 'admin-auth.json')));
  const before = await readFile(path.join(app.runtime, 'admin-data/auth-state.json'));
  assert.equal((await prepareLocalPhp({ projectRoot: app.project })).existing, true);
  assert.deepEqual(await readFile(path.join(app.runtime, 'admin-data/auth-state.json')), before);
});

test('Vite PHP transport protects login, cookies and CSRF; menu changes survive restart and encrypted transfer', { timeout: 60000 }, async (t) => {
  const app = await fixture(t);
  await prepareLocalPhp({ projectRoot: app.project, passwordProvider: async () => PASSWORD });
  let bridge, server, origin, cookies = new Map(), csrf;
  async function start() {
    bridge = createPhpDevMiddleware({ projectRoot: app.project });
    server = http.createServer((req, res) => bridge.middleware(req, res, () => { res.writeHead(404); res.end(); })).listen(0, '127.0.0.1');
    await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { await bridge.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await start(); app.beforeCleanup(stop);
  async function request(route, { body, method = body ? 'POST' : 'GET', headers = {} } = {}) {
    const response = await fetch(origin + route, { method, headers: { Origin: origin, Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    for (const line of response.headers.getSetCookie()) { const pair = line.split(';')[0]; const i = pair.indexOf('='); cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch {}
    return { status: response.status, json, text, headers: response.headers };
  }
  const status = await request('/api/admin/session'); assert.equal(status.status, 200); assert.equal(status.headers.get('x-cafe-runtime'), 'php'); assert.equal(status.json.ready, true);
  assert.equal((await request('/api/admin/menu')).status, 401);
  assert.equal((await request('/api/admin/login', { body: { username: 'owner@example.test', password: PASSWORD }, headers: { Origin: 'https://other.test' } })).status, 403);
  assert.equal((await request('/api/admin/login', { body: { username: 'owner@example.test', password: PASSWORD }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const foreignHost = await new Promise((resolve, reject) => {
    const req = http.get(origin + '/api/admin/session', { headers: { Host: 'evil.example' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject);
  });
  assert.equal(foreignHost, 403);
  const pending = await request('/api/admin/login', { body: { username: 'owner@example.test', password: PASSWORD } });
  assert.equal(pending.status, 202); assert.equal(pending.json.mfaRequired, true); assert.equal(pending.json.deviceToken, undefined);
  const verified = await request('/api/admin/verify', { body: { challengeToken: pending.json.challengeToken, code: totp(SECRET) } });
  assert.equal(verified.status, 200, verified.text); csrf = verified.json.csrfToken;
  assert.ok(cookies.get('vosem_admin_device')); assert.match(verified.headers.get('set-cookie'), /HttpOnly/i);
  const current = (await request('/api/admin/menu')).json; current.items[0].price += 1;
  assert.equal((await request('/api/admin/menu', { method: 'PUT', body: current, headers: { 'X-CSRF-Token': 'bad' } })).status, 403);
  assert.equal((await request('/api/admin/menu', { method: 'PUT', body: current })).status, 200);
  assert.equal((await request(`/uploads/${PHOTO}`)).status, 200);
  await stop(); await start();
  assert.equal((await request('/api/admin/session')).json.authenticated, true, 'PHP sessions survive a local bridge restart');
  assert.equal((await request('/api/menu')).json.revision, 8);
  const orderSettings = await request('/api/ordering'); assert.equal(orderSettings.status, 200); assert.equal(orderSettings.json.mode, 'development');
  assert.equal((await request('/api/admin/logout', { body: {} })).status, 200);
  assert.equal((await request('/api/admin/session')).json.trustedUsername, 'owner@example.test');
  assert.equal((await request('/api/admin/logout', { body: { forgetDevice: true } })).status, 200);
  assert.equal((await request('/api/admin/session')).json.trustedUsername, undefined);

  // Consume a recovery code BEFORE export; it must never become reusable again.
  const login = await request('/api/admin/login', { body: { username: 'owner@example.test', password: PASSWORD } });
  const recovered = await request('/api/admin/verify', { body: { challengeToken: login.json.challengeToken, code: app.owner.recoveryCodes[0] } });
  assert.equal(recovered.status, 200);
  const bundle = path.join(app.project, 'private.cafebackup'), key = path.join(app.project, 'private.key');
  const exported = transfer('export', app.runtime, bundle, key); assert.equal(exported.status, 0, exported.stderr);
  const encrypted = await readFile(bundle, 'utf8'); assert.ok(!encrypted.includes(PASSWORD)); assert.ok(!encrypted.includes('owner@example.test')); assert.ok(!encrypted.includes(KEY.toString('hex')));
  const restored = path.join(app.project, 'restored');
  const imported = transfer('import', bundle, key, restored, 'https://vosem-utra.ru'); assert.equal(imported.status, 0, imported.stderr);
  const original = JSON.parse(await readFile(path.join(app.runtime, 'admin-data/auth-state.json')));
  const saved = JSON.parse(await readFile(path.join(restored, 'admin-data/auth-state.json')));
  assert.deepEqual(saved.account, original.account); assert.deepEqual(saved.accounts, original.accounts);
  for (const field of ['sessions','devices','challenges','enrollments']) assert.deepEqual(saved[field], []);
  assert.equal(saved.account.recovery.length, 9); assert.deepEqual(saved.account.totp, original.account.totp);
  assert.equal(JSON.parse(await readFile(path.join(restored, 'admin-data/menu.json'))).revision, 8);
  assert.deepEqual(await readFile(path.join(restored, 'admin-data/uploads', PHOTO)), await readFile(path.join(app.data, 'uploads', PHOTO)));
  assert.ok(!(await readdir(restored)).some((name) => name.includes('admin-access')));
  const before = await readFile(path.join(restored, 'admin-data/auth-state.json'));
  assert.notEqual(transfer('import', bundle, key, restored, 'https://vosem-utra.ru').status, 0);
  assert.deepEqual(await readFile(path.join(restored, 'admin-data/auth-state.json')), before);
  const badKey = path.join(app.project, 'wrong.key'); await writeFile(badKey, randomBytes(32).toString('hex'));
  assert.notEqual(transfer('import', bundle, badKey, path.join(app.project, 'wrong-key-output'), origin).status, 0);
  const damaged = JSON.parse(encrypted); damaged.tag = '0'.repeat(32); const damagedBundle = path.join(app.project, 'damaged.cafebackup'); await writeFile(damagedBundle, JSON.stringify(damaged));
  assert.notEqual(transfer('import', damagedBundle, key, path.join(app.project, 'damaged-output'), origin).status, 0);
  // Actual PHP SQLite service has created its DB; use a consistent snapshot, not a live file copy.
  const fullBundle = path.join(app.project, 'full.cafebackup'), fullKey = path.join(app.project, 'full.key');
  assert.equal(transfer('export', app.runtime, fullBundle, fullKey, '--include-orders').status, 0);
  assert.notEqual(transfer('import', fullBundle, fullKey, path.join(app.project, 'no-test-orders'), 'https://vosem-utra.ru').status, 0);
  const localRestore = path.join(app.project, 'restored-local');
  const fullRestore = transfer('import', fullBundle, fullKey, localRestore, origin); assert.equal(fullRestore.status, 0, fullRestore.stderr);
  assert.ok((await readFile(path.join(localRestore, 'orders-data/orders.sqlite'))).length > 0);
});
