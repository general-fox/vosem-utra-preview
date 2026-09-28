import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMenuMiddleware, makePasswordRecord } from '../server/menu-api.mjs';
import { makeEnrolledAccount } from '../server/auth.mjs';
import { encodeBase32, totp } from '../server/totp.mjs';

const PASSWORD = 'a-test-password-with-24-characters';
const fixtureAccess = new Map();
const seedItems = [
  { id: 'egg-toast', name: 'Тост с яйцом', description: 'Хлеб, яйцо и зелень', price: 450, category: 'eggs', image: '/menu-images/toast.jpg', published: true, order: 1 },
  { id: 'hidden', name: 'Черновик', description: '', price: 600, category: 'signature', image: '', published: false, order: 0 },
];

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vosem-menu-'));
  const seedPath = options.seedPath ?? path.join(directory, 'seed.json');
  const dataDir = options.dataDir ?? path.join(directory, 'store');
  if (!options.seedPath) await writeFile(seedPath, JSON.stringify({ items: seedItems, source: { note: 'Test seed' } }));
  let server;
  let base;
  let auth = {};
  async function start(extra = {}) {
    const handler = createMenuMiddleware({ projectRoot: directory, dataDir, seedPath, password: PASSWORD, ...options, ...extra });
    server = http.createServer((req, res) => handler(req, res, () => { res.writeHead(404); res.end(); }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (!server) return;
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server = null;
  }
  await start();
  t.after(async () => { await stop(); fixtureAccess.delete(dataDir); await rm(directory, { recursive: true, force: true }); });
  async function request(route, { method = 'GET', body, headers = {}, authenticated = true, origin, raw } = {}) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { ...(authenticated ? auth : {}), ...(!['GET', 'HEAD'].includes(method) ? { Origin: origin ?? base } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? raw : JSON.stringify(body),
    });
    const type = response.headers.get('content-type') ?? '';
    const value = type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, value };
  }
  async function login(password = PASSWORD) {
    let result = await request('/api/admin/login', { method: 'POST', body: { username: 'admin', password }, authenticated: false });
    if (result.value.enrollmentRequired) {
      const started = await request('/api/admin/enroll/start', { method: 'POST', body: { challengeToken: result.value.challengeToken, username: 'admin' }, authenticated: false });
      assert.equal(started.status, 200);
      result = await request('/api/admin/enroll/confirm', { method: 'POST', body: { enrollmentToken: started.value.enrollmentToken, code: totp(started.value.secret) }, authenticated: false });
      fixtureAccess.set(dataDir, { recoveryCodes: result.value.recoveryCodes });
    } else if (result.value.mfaRequired) {
      result = await request('/api/admin/verify', { method: 'POST', body: { challengeToken: result.value.challengeToken, code: fixtureAccess.get(dataDir)?.recoveryCodes.shift() }, authenticated: false });
    }
    if (result.status === 200) auth = { Cookie: result.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': result.value.csrfToken };
    return result;
  }
  async function overlappingLogins(passwords) {
    // Deliver every request's headers first so all handlers wait on body input together.
    let receivedHeaders = 0;
    let headersReady;
    const allHeaders = new Promise((resolve) => { headersReady = resolve; });
    const onRequest = (req) => {
      if (req.url === '/api/admin/login' && ++receivedHeaders === passwords.length) headersReady();
    };
    server.on('request', onRequest);
    const pending = passwords.map((password) => {
      const body = JSON.stringify({ username: 'admin', password });
      let req;
      const response = new Promise((resolve, reject) => {
        req = http.request(`${base}/api/admin/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()) }));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.flushHeaders();
      });
      return { req, body, response };
    });
    await allHeaders;
    await new Promise((resolve) => setImmediate(resolve));
    server.off('request', onRequest);
    for (const entry of pending) entry.req.end(entry.body);
    return Promise.all(pending.map((entry) => entry.response));
  }
  return { request, login, overlappingLogins, stop, start, dataDir, seedPath };
}

test('public menu omits drafts; admin API requires login and secure cookie settings', async (t) => {
  const app = await fixture(t);
  const publicMenu = await app.request('/api/menu');
  assert.equal(publicMenu.status, 200);
  assert.equal(publicMenu.value.revision, 1);
  assert.equal(publicMenu.value.items[0].availableForOrder, true);
  assert.deepEqual(publicMenu.value.items.map((item) => item.id), ['egg-toast']);
  assert.deepEqual((await app.request('/data/menu.json')).value, publicMenu.value);
  assert.equal((await app.request('/api/admin/menu')).status, 401);
  assert.deepEqual((await app.request('/api/admin/session')).value, { authenticated: false, configured: true, mfaRequired: true, production: false, ready: false, enrollmentAvailable: true });
  assert.equal((await app.login('incorrect')).status, 401);
  const login = await app.login();
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(login.headers.get('set-cookie'), /Path=\/api\/admin/);
  assert.equal((await app.request('/api/admin/session')).value.csrfToken, login.value.csrfToken);
  assert.equal((await app.request('/api/admin/menu')).value.items.length, 2);
});

test('edits, additions, visibility, removal, and ordering persist across restart', async (t) => {
  const app = await fixture(t);
  await app.login();
  const { value: original } = await app.request('/api/admin/menu');
  const items = original.items.map((item) => ({ ...item, published: true, price: item.price + 10 }));
  items.push({ id: 'porridge', name: 'Каша', description: 'На молоке', price: 300, category: 'porridge', image: 'menu-images/porridge.webp', published: true, order: 2 });
  const saved = await app.request('/api/admin/menu', { method: 'PUT', body: { items, revision: original.revision } });
  assert.equal(saved.status, 200);
  assert.equal(saved.value.revision, original.revision + 1);
  assert.equal(saved.value.items[2].image, '/menu-images/porridge.webp');
  assert.deepEqual((await app.request('/api/menu')).value.items.map((item) => item.id), ['hidden', 'egg-toast', 'porridge']);
  await app.stop();
  await app.start();
  assert.equal((await app.request('/api/admin/menu')).status, 401);
  await app.login();
  const restored = await app.request('/api/admin/menu');
  assert.deepEqual(restored.value, saved.value);
  const reduced = await app.request('/api/admin/menu', { method: 'PUT', body: { items: restored.value.items.slice(1), revision: restored.value.revision } });
  assert.equal(reduced.status, 200);
  const onDisk = JSON.parse(await readFile(path.join(app.dataDir, 'menu.json'), 'utf8'));
  assert.deepEqual(onDisk, reduced.value);
});

test('origin and CSRF checks reject cross-site writes and unauthorized uploads', async (t) => {
  const app = await fixture(t);
  const rejectedLogin = await app.request('/api/admin/login', { method: 'POST', origin: 'https://evil.example', body: { password: PASSWORD } });
  assert.equal(rejectedLogin.status, 403);
  await app.login();
  const body = { items: seedItems, revision: 1 };
  assert.equal((await app.request('/api/admin/menu', { method: 'PUT', body, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await app.request('/api/admin/menu', { method: 'PUT', body, origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.request('/api/admin/menu', { method: 'PUT', body, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await app.request('/api/admin/upload', { method: 'POST', raw: 'fake', headers: { 'Content-Type': 'image/png' }, authenticated: false })).status, 401);
});

test('optimistic revision and write serialization prevent lost edits', async (t) => {
  const app = await fixture(t);
  await app.login();
  const results = await Promise.all([450, 500].map((price) => app.request('/api/admin/menu', { method: 'PUT', body: { items: [{ ...seedItems[0], price }], revision: 1 } })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal((await app.request('/api/admin/menu')).value.revision, 2);
  assert.equal((await app.request('/api/admin/menu', { method: 'PUT', body: { items: [], revision: 1 } })).status, 409);
  assert.equal((await app.request('/api/admin/menu')).value.items.length, 1);
});

test('an already initialized server reads external menu edits and rejects stale writes', async (t) => {
  const first = await fixture(t);
  await first.login();
  const original = (await first.request('/api/admin/menu')).value;
  const second = await fixture(t, { dataDir: first.dataDir, seedPath: first.seedPath });
  await second.login();
  const items = original.items.map((item) => ({ ...item, image: '/menu-images/current.webp', price: item.price + 25 }));
  const saved = await second.request('/api/admin/menu', { method: 'PUT', body: { items, revision: original.revision } });
  assert.equal(saved.status, 200);
  assert.deepEqual((await first.request('/api/admin/menu')).value, saved.value);
  for (const route of ['/api/menu', '/data/menu.json']) {
    const visible = (await first.request(route)).value.items;
    assert.equal(visible.length, 1);
    assert.equal(visible[0].image, '/menu-images/current.webp');
    assert.equal(visible[0].price, 475);
  }
  const rejected = await first.request('/api/admin/menu', { method: 'PUT', body: original });
  assert.equal(rejected.status, 409);
  assert.deepEqual(JSON.parse(await readFile(path.join(first.dataDir, 'menu.json'), 'utf8')), saved.value);
  // Also reject without an intervening GET: PUT must refresh inside its own write queue.
  const savedAgain = await second.request('/api/admin/menu', { method: 'PUT', body: { ...saved.value, items: [] } });
  assert.equal(savedAgain.status, 200);
  const staleWithoutRead = await first.request('/api/admin/menu', { method: 'PUT', body: saved.value });
  assert.equal(staleWithoutRead.status, 409);
  assert.deepEqual(JSON.parse(await readFile(path.join(first.dataDir, 'menu.json'), 'utf8')), savedAgain.value);
});

test('validation rejects malformed prices, categories, IDs, and unsafe image paths without changing menu', async (t) => {
  const app = await fixture(t);
  await app.login();
  const invalid = [
    { price: -1 }, { price: 1.111 }, { price: '400' }, { category: 'invalid' }, { published: 'true' },
    { availableForOrder: 'false' }, { availableForOrder: null }, { availableForOrder: 0 },
    { order: -1 }, { name: '' }, { name: 'x'.repeat(161) }, { description: '\u0000' }, { id: '../bad' },
    { image: 'https://evil.example/track.jpg' }, { image: '/uploads/../secret.jpg' }, { image: '/menu-images/a.svg' }, { image: 'javascript:alert(1)' },
  ];
  for (const patch of invalid) {
    const result = await app.request('/api/admin/menu', { method: 'PUT', body: { revision: 1, items: [{ ...seedItems[0], ...patch }] } });
    assert.equal(result.status, 400, JSON.stringify(patch));
  }
  assert.equal((await app.request('/api/admin/menu', { method: 'PUT', body: { revision: 1, items: [seedItems[0], seedItems[0]] } })).status, 400);
  assert.equal((await app.request('/api/admin/menu')).value.revision, 1);
});

test('upload verifies magic bytes, rejects oversized files, and serves only generated image filenames', async (t) => {
  const app = await fixture(t);
  await app.login();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrXcAAAAASUVORK5CYII=', 'base64');
  const upload = await app.request('/api/admin/upload', { method: 'POST', raw: png, headers: { 'Content-Type': 'image/png' } });
  assert.equal(upload.status, 201);
  assert.match(upload.value.url, /^\/uploads\/[a-f0-9-]{36}\.png$/);
  const downloaded = await app.request(upload.value.url, { authenticated: false });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(downloaded.value, png);
  assert.equal((await app.request('/api/admin/upload', { method: 'POST', raw: png, headers: { 'Content-Type': 'image/jpeg' } })).status, 400);
  assert.equal((await app.request('/api/admin/upload', { method: 'POST', raw: '<svg/>', headers: { 'Content-Type': 'image/svg+xml' } })).status, 415);
  assert.equal((await app.request('/api/admin/upload', { method: 'POST', raw: Buffer.alloc(5 * 1024 * 1024 + 1), headers: { 'Content-Type': 'image/png' } })).status, 413);
  assert.equal((await app.request('/uploads/admin-password.json')).status, 404);
  assert.equal((await app.request('/uploads/%2e%2e%2fadmin-password.json')).status, 404);
});

test('logout invalidates the cookie and expired sessions stop authorizing requests', async (t) => {
  const app = await fixture(t);
  await app.login();
  assert.equal((await app.request('/api/admin/logout', { method: 'POST', headers: { 'X-CSRF-Token': '' } })).status, 403);
  const result = await app.request('/api/admin/logout', { method: 'POST' });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await app.request('/api/admin/menu')).status, 401);
  await app.stop();
  await app.start({ sessionMs: 1 });
  await app.login();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await app.request('/api/admin/menu')).status, 401);
});

test('password login is rate limited', async (t) => {
  const app = await fixture(t);
  for (let i = 0; i < 8; i++) assert.equal((await app.login('bad-password')).status, 401);
  const blocked = await app.login();
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('overlapping login bodies cannot bypass the eight-attempt rate limit', async (t) => {
  const app = await fixture(t);
  await app.request('/api/admin/session');
  const attempts = await app.overlappingLogins(Array(12).fill('bad-password'));
  assert.equal(attempts.filter((attempt) => attempt.status === 401).length, 8);
  assert.equal(attempts.filter((attempt) => attempt.status === 429).length, 4);
  assert.equal((await app.login()).status, 429);
});

test('successful login does not clear concurrent or previously failed attempts', async (t) => {
  const app = await fixture(t);
  await app.request('/api/admin/session');
  const attempts = await app.overlappingLogins([PASSWORD, ...Array(7).fill('bad-password')]);
  assert.equal(attempts.filter((attempt) => attempt.status === 202 && attempt.value.enrollmentRequired).length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 401).length, 7);
  assert.equal((await app.login('bad-password')).status, 401);
  assert.equal((await app.login()).status, 429);
});

test('local password hash config requires enrollment before issuing a session', async (t) => {
  const app = await fixture(t);
  await app.stop();
  await mkdir(app.dataDir, { recursive: true });
  await writeFile(path.join(app.dataDir, 'admin-password.json'), JSON.stringify(await makePasswordRecord(PASSWORD)));
  await app.start({ password: '', publicOrigin: 'https://cafe.example' });
  const result = await app.request('/api/admin/login', { method: 'POST', body: { username: 'admin', password: PASSWORD }, origin: 'https://cafe.example' });
  assert.equal(result.status, 202);
  assert.equal(result.value.enrollmentRequired, true);
  assert.equal(result.headers.get('set-cookie'), null);
});

test('unconfigured admin remains closed while public menu works', async (t) => {
  const app = await fixture(t, { password: '' });
  assert.equal((await app.request('/api/menu')).status, 200);
  assert.deepEqual((await app.request('/api/admin/session')).value, { authenticated: false, configured: false, mfaRequired: false, production: false, ready: false, enrollmentAvailable: false });
  assert.equal((await app.login()).status, 503);
});

test('production auth setup failures never prevent the public menu from loading', async (t) => {
  const app = await fixture(t, { production: true, publicOrigin: undefined, encryptionKey: '' });
  assert.equal((await app.request('/api/menu')).status, 200);
  assert.equal((await app.login()).status, 503);
  await writeFile(path.join(app.dataDir, 'admin-auth.json'), 'invalid credential JSON');
  assert.equal((await app.request('/api/menu')).status, 200);
  assert.equal((await app.request('/data/menu.json')).status, 200);
  assert.equal((await app.request('/api/admin/session')).value.ready, false);
});

test('explicit local origin override ignores an exported production PUBLIC_ORIGIN', async (t) => {
  const previous = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = 'https://production.example';
  t.after(() => { if (previous === undefined) delete process.env.PUBLIC_ORIGIN; else process.env.PUBLIC_ORIGIN = previous; });
  const app = await fixture(t, { production: false, publicOrigin: undefined });
  assert.equal((await app.login()).status, 200);
});

test('HTTP MFA login sets no cookie before verification and issues a Secure session only afterward', async (t) => {
  const key = Buffer.alloc(32, 44);
  const origin = 'https://cafe.example';
  const app = await fixture(t, { production: true, password: '', publicOrigin: origin, encryptionKey: key.toString('hex') });
  await app.request('/api/menu');
  const secret = encodeBase32(Buffer.from('12345678901234567890'));
  const enrollmentTime = Date.now() - 60_000;
  const { account } = await makeEnrolledAccount({ username: 'owner', password: PASSWORD, secret, key, time: enrollmentTime, code: totp(secret, { time: enrollmentTime }) });
  await writeFile(path.join(app.dataDir, 'admin-auth.json'), JSON.stringify(account));
  const pending = await app.request('/api/admin/login', { method: 'POST', origin, body: { username: 'owner', password: PASSWORD } });
  assert.equal(pending.status, 202);
  assert.equal(pending.value.mfaRequired, true);
  assert.equal(pending.headers.get('set-cookie'), null);
  assert.equal((await app.request('/api/admin/menu')).status, 401);
  const verified = await app.request('/api/admin/verify', { method: 'POST', origin, body: { challengeToken: pending.value.challengeToken, code: totp(secret) } });
  assert.equal(verified.status, 200);
  assert.equal(verified.value.authenticated, true);
  assert.match(verified.headers.get('set-cookie'), /; Secure/);
  assert.equal((await app.request('/api/admin/menu', { headers: { Cookie: verified.headers.get('set-cookie').split(';')[0] } })).status, 200);
});

test('HTTP enrollment keeps menu locked until TOTP, serves a private QR, then returns recovery codes once', async (t) => {
  const key = Buffer.alloc(32, 55);
  const origin = 'https://cafe.example';
  const app = await fixture(t, { production: true, username: 'v.utra@yandex.ru', publicOrigin: origin, encryptionKey: key.toString('hex') });
  const status = await app.request('/api/admin/session');
  assert.equal(status.value.ready, false);
  assert.equal(status.value.enrollmentAvailable, true);
  assert.equal((await app.request('/api/admin/enroll/start', { method: 'POST', origin, body: { challengeToken: 'invented', username: 'v.utra@yandex.ru' } })).status, 410);
  const pending = await app.request('/api/admin/login', { method: 'POST', origin, body: { username: 'v.utra@yandex.ru', password: PASSWORD } });
  assert.equal(pending.status, 202);
  assert.equal(pending.value.enrollmentRequired, true);
  assert.equal(pending.headers.get('set-cookie'), null);
  assert.equal((await app.request('/api/admin/menu')).status, 401);
  const startBody = { challengeToken: pending.value.challengeToken, username: 'v.utra@yandex.ru' };
  assert.equal((await app.request('/api/admin/enroll/start', { method: 'POST', origin: 'https://evil.example', body: startBody })).status, 403);
  const started = await app.request('/api/admin/enroll/start', { method: 'POST', origin, body: startBody });
  assert.equal(started.status, 200);
  assert.equal(started.headers.get('cache-control'), 'no-store');
  assert.match(started.value.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(new URL(started.value.otpauthUri).searchParams.get('secret'), started.value.secret);
  await assert.rejects(readFile(path.join(app.dataDir, 'admin-auth.json')), { code: 'ENOENT' });
  assert.equal((await app.request('/api/admin/enroll/confirm', { method: 'POST', origin, body: { enrollmentToken: started.value.enrollmentToken, code: 'wrong' } })).status, 401);
  assert.equal((await app.request('/api/admin/menu')).status, 401);
  const confirmed = await app.request('/api/admin/enroll/confirm', { method: 'POST', origin, body: { enrollmentToken: started.value.enrollmentToken, code: totp(started.value.secret) } });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.value.recoveryCodes.length, 10);
  assert.match(confirmed.headers.get('set-cookie'), /; Secure/);
  const authenticated = { Cookie: confirmed.headers.get('set-cookie').split(';')[0] };
  assert.equal((await app.request('/api/admin/menu', { headers: authenticated })).status, 200);
  assert.equal((await app.request('/api/admin/session', { headers: authenticated })).value.recoveryCodes, undefined);
  assert.equal((await app.request('/api/admin/enroll/confirm', { method: 'POST', origin, body: { enrollmentToken: started.value.enrollmentToken, code: totp(started.value.secret) } })).status, 410);
  const audit = await readFile(path.join(app.dataDir, 'security-audit.jsonl'), 'utf8');
  for (const sensitive of [started.value.secret, started.value.otpauthUri, started.value.qrDataUrl, ...confirmed.value.recoveryCodes]) assert.equal(audit.includes(sensitive), false);
});

test('private server files stay inaccessible, including encoded and Vite filesystem paths', async (t) => {
  const app = await fixture(t);
  for (const route of ['/.data/admin-password.json', '/%2edata/admin-password.json', '/.DATA/menu.json', '/.env', '/.env.example', '/server/menu-api.mjs', '/@fs/C:/project/.data/menu.json', '/@fs/C:/project/.git/config']) {
    const response = await app.request(route);
    assert.equal(response.status, 404, route);
    assert.equal(response.value.code, 'not_found', route);
  }
});


test('legacy availability defaults on read without rewriting data, and independent availability persists with the public revision', async (t) => {
  const app = await fixture(t);
  await app.request('/api/menu');
  const legacy = JSON.stringify({ revision: 7, items: seedItems });
  await writeFile(path.join(app.dataDir, 'menu.json'), legacy);
  const loaded = (await app.request('/api/menu')).value;
  assert.equal(loaded.revision, 7);
  assert.equal(loaded.items[0].availableForOrder, true);
  assert.equal(await readFile(path.join(app.dataDir, 'menu.json'), 'utf8'), legacy, 'Reading a legacy catalog must not rewrite production data');
  await app.login();
  const saved = await app.request('/api/admin/menu', { method: 'PUT', body: { revision: 7, items: [
    { ...seedItems[0], availableForOrder: false },
    { ...seedItems[1], availableForOrder: true },
  ] } });
  assert.equal(saved.status, 200);
  assert.equal(saved.value.revision, 8);
  assert.equal(saved.value.items[0].published, true);
  assert.equal(saved.value.items[0].availableForOrder, false);
  assert.equal(saved.value.items[1].availableForOrder, true);
  for (const route of ['/api/menu', '/data/menu.json']) {
    const catalog = (await app.request(route)).value;
    assert.equal(catalog.revision, saved.value.revision);
    assert.deepEqual(catalog.items.map((item) => item.id), ['egg-toast']);
    assert.equal(catalog.items[0].availableForOrder, false, 'Visible unavailable dishes remain in the public catalog');
  }
  await app.stop(); await app.start();
  assert.deepEqual((await app.request('/api/menu')).value, { items: [saved.value.items[0]], revision: 8 });
  assert.deepEqual(JSON.parse(await readFile(path.join(app.dataDir, 'menu.json'), 'utf8')), saved.value);
});
