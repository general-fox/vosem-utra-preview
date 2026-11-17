import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PNG } from 'pngjs';
import { createMenuMiddleware, makePasswordRecord } from '../server/menu-api.mjs';
import { makeEnrolledAccount } from '../server/auth.mjs';
import { encodeBase32, totp } from '../server/totp.mjs';

const PASSWORD = 'a-test-password-with-24-characters';
const fixtureAccess = new Map();
const seedItems = [
  { id: 'egg-toast', name: 'Тост с яйцом', description: 'Хлеб, яйцо и зелень', price: 450, category: 'eggs', image: '/menu-images/toast.jpg', published: true, order: 1 },
  { id: 'hidden', name: 'Черновик', description: '', price: 600, category: 'signature', image: '', published: false, order: 0 },
];

test('dish nutrition and allergens survive save, public JSON, restart and explicit clearing', async t => {
  const app = await fixture(t);
  await app.login();
  let current = (await app.request('/api/admin/menu')).value;
  for (const item of current.items) for (const key of ['nutrition','allergens']) assert.equal(Object.hasOwn(item,key),false);
  Object.assign(current.items[0], { nutrition:'  420 ккал\nБ: 14 г, Ж: 22 г, У: 39 г  ', allergens:'  Яйцо, молоко и глютен  ' });
  let saved = await app.request('/api/admin/menu', { method:'PUT', body:current });
  assert.equal(saved.status,200);
  assert.equal(saved.value.items[0].nutrition,'420 ккал\nБ: 14 г, Ж: 22 г, У: 39 г');
  assert.equal(saved.value.items[0].allergens,'Яйцо, молоко и глютен');
  assert.equal(saved.value.items[0].description,seedItems[0].description);
  for (const route of ['/api/menu','/data/menu.json']) {
    const guest=(await app.request(route,{authenticated:false})).value.items.find(item=>item.id===current.items[0].id);
    assert.equal(guest.nutrition,saved.value.items[0].nutrition);
    assert.equal(guest.allergens,saved.value.items[0].allergens);
  }
  const bytes=await readFile(path.join(app.dataDir,'menu.json'),'utf8');
  for (const patch of [{nutrition:null},{nutrition:42},{nutrition:'я'.repeat(501)},{allergens:[]},{allergens:'bad\u0000value'},{allergens:'я'.repeat(1001)}]) {
    const invalid=structuredClone(saved.value); Object.assign(invalid.items[0],patch);
    const result=await app.request('/api/admin/menu',{method:'PUT',body:invalid});
    assert.equal(result.status,400); assert.equal(result.value.code,'invalid_item');
    assert.equal(await readFile(path.join(app.dataDir,'menu.json'),'utf8'),bytes);
  }
  await app.stop(); await app.start(); await app.login();
  current=(await app.request('/api/admin/menu')).value;
  assert.deepEqual(current,saved.value);
  assert.equal(Object.hasOwn(current.items[1],'nutrition'),false);
  assert.equal(Object.hasOwn(current.items[1],'allergens'),false);
  Object.assign(current.items[0],{nutrition:' \n ',allergens:''});
  saved=await app.request('/api/admin/menu',{method:'PUT',body:current});
  assert.equal(saved.status,200);
  const cleared=(await app.request('/api/menu',{authenticated:false})).value.items.find(item=>item.id===current.items[0].id);
  assert.equal(cleared.nutrition,''); assert.equal(cleared.allergens,'');
});

test('photo galleries survive save, public JSON and restart with ordered covers', async t => {
  const app = await fixture(t);
  await app.login();
  let current = (await app.request('/api/admin/menu')).value;
  assert.equal(Object.hasOwn(current.items[0], 'images'), false, 'Old records remain backward compatible');
  current.items[0].images = ['uploads/second.png', '/menu-images/toast.jpg', '/uploads/third.webp'];
  let saved = await app.request('/api/admin/menu', { method:'PUT', body:current });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.value.items[0].images, ['/uploads/second.png', '/menu-images/toast.jpg', '/uploads/third.webp']);
  assert.equal(saved.value.items[0].image, '/uploads/second.png');
  for (const route of ['/api/menu','/data/menu.json']) {
    const guest=(await app.request(route,{authenticated:false})).value.items.find(item=>item.id===current.items[0].id);
    assert.deepEqual(guest.images,saved.value.items[0].images);
    assert.equal(guest.image,guest.images[0]);
  }
  await app.stop(); await app.start(); await app.login();
  current=(await app.request('/api/admin/menu')).value;
  assert.deepEqual(current.items[0].images,saved.value.items[0].images);
  current.items[0].images.reverse();
  saved=await app.request('/api/admin/menu',{method:'PUT',body:current});
  assert.equal(saved.status,200);
  assert.equal(saved.value.items[0].image,'/uploads/third.webp');
  const bytes=await readFile(path.join(app.dataDir,'menu.json'),'utf8');
  const invalid=structuredClone(saved.value);
  invalid.items[0].images=['https://outside.test/a.jpg'];
  assert.equal((await app.request('/api/admin/menu',{method:'PUT',body:invalid})).status,400);
  assert.equal(await readFile(path.join(app.dataDir,'menu.json'),'utf8'),bytes,'Invalid gallery cannot corrupt saved state');
  current=structuredClone(saved.value); current.items[0].images=[];
  saved=await app.request('/api/admin/menu',{method:'PUT',body:current});
  assert.equal(saved.status,200);
  assert.deepEqual(saved.value.items[0].images,[]);
  assert.equal(saved.value.items[0].image,'');
  await app.stop(); await app.start(); await app.login();
  const cleared=(await app.request('/api/admin/menu')).value.items[0];
  assert.deepEqual(cleared.images,[]); assert.equal(cleared.image,'');
});

test('beverage edits survive save, public JSON and restart while invalid choices leave storage untouched', async t => {
  const app = await fixture(t);
  await app.login();
  const current = (await app.request('/api/admin/menu')).value;
  const drink = { section: 'Кофе', variants: [{ volumeMl: 250, price: 180 }, { volumeMl: 350, price: 230 }], addons: [{ name: 'Сироп', price: 40 }], childFriendly: false, sectionOrder: 2 };
  current.items[0].drink = drink;
  current.items[0].price = 999;
  const saved = await app.request('/api/admin/menu', { method: 'PUT', body: current });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.value.items[0].drink, drink);
  assert.equal(saved.value.items[0].price, 180);
  assert.equal(saved.value.items[0].availableForOrder, false);
  for (const route of ['/api/menu', '/data/menu.json']) {
    const guest = (await app.request(route, { authenticated: false })).value.items.find(item => item.id === current.items[0].id);
    assert.deepEqual(guest.drink, drink);
    assert.equal(guest.availableForOrder, false);
  }
  const stored = await readFile(path.join(app.dataDir, 'menu.json'), 'utf8');
  const invalid = structuredClone(saved.value);
  invalid.items[0].drink.variants[1].volumeMl = 250;
  const rejected = await app.request('/api/admin/menu', { method: 'PUT', body: invalid });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.value.code, 'invalid_drink');
  const invalidRank = structuredClone(saved.value);
  invalidRank.items[0].drink.sectionOrder = 10001;
  const rejectedRank = await app.request('/api/admin/menu', { method: 'PUT', body: invalidRank });
  assert.equal(rejectedRank.status, 400);
  assert.equal(rejectedRank.value.code, 'invalid_drink');
  assert.equal(await readFile(path.join(app.dataDir, 'menu.json'), 'utf8'), stored);
  await app.stop(); await app.start(); await app.login();
  const restored = (await app.request('/api/admin/menu')).value;
  assert.deepEqual(restored, saved.value);
  assert.equal(Object.hasOwn(restored.items[1], 'drink'), false);
});

test('legacy source groups migrate once; individual website assignments survive edits without automatic mapping', async t => {
  const app = await fixture(t);
  await app.login();
  const current = (await app.request('/api/admin/menu')).value;
  const organizationId = 'baa06e7a-b091-4296-97bc-275bc22d9af9';
  const source = externalId => ({provider:'kds',organizationId,externalId,testOnly:true});
  const categories = [...current.categories, {id:'drinks',name:'Напитки',parentId:null,order:2}, {id:'source-coffee',name:'Кофе',parentId:null,order:3,source:source('11')}];
  const sourceCategories = [{id:'source-bar',name:'Бар',parentId:null,order:0,source:source('10')},{id:'source-coffee',name:'Кофе',parentId:'source-bar',order:0,source:source('11')}];
  const importedCoffee = {...seedItems[0],id:'imported-coffee',category:'source-coffee',source:{...source('101'),groupExternalId:'11'},name:'Кофе для сайта'};
  const body = { ...current, categories, sourceCategories, categoryMappings:[{provider:'kds',organizationId,externalId:'11',categoryId:'drinks'}], items:[...current.items,{...importedCoffee,id:'new-source-coffee',category:null,source:{...source('102'),groupExternalId:'11'}},importedCoffee] };
  await writeFile(path.join(app.dataDir,'menu.json'), JSON.stringify(body));
  const saved = await app.request('/api/admin/menu');
  assert.equal(saved.status,200);
  assert.equal(saved.value.items.at(-1).category,'drinks');
  assert.equal(saved.value.items.at(-1).source.groupExternalId,'11');
  assert.deepEqual(saved.value.sourceCategories,sourceCategories);
  assert.deepEqual(saved.value.categoryMappings,[]);
  assert.ok(saved.value.categories.every(category=>!category.source));
  assert.equal(saved.value.revision,current.revision+1);
  await app.stop(); await app.start(); await app.login();
  const loaded = (await app.request('/api/admin/menu')).value;
  assert.equal(loaded.items.at(-1).name,'Кофе для сайта');
  assert.deepEqual(loaded.categoryMappings,[]);
  assert.equal(loaded.revision,saved.value.revision);
  loaded.items.at(-1).price=600;
  loaded.items.at(-1).category='dinner';
  const unassigned = loaded.items.find(item=>item.id==='new-source-coffee');
  Object.assign(unassigned,{category:null,published:true,availableForOrder:true});
  const updated = await app.request('/api/admin/menu',{method:'PUT',body:loaded});
  assert.equal(updated.status,200);
  const guest=(await app.request('/api/menu',{authenticated:false})).value;
  assert.equal(guest.items.find(item=>item.id==='imported-coffee').category,'dinner');
  assert.equal(guest.items.find(item=>item.id==='imported-coffee').price,600);
  assert.equal(guest.items.some(item=>item.id==='new-source-coffee'),false);
  assert.deepEqual(updated.value.items.find(item=>item.id==='new-source-coffee'),{...unassigned,published:false,availableForOrder:false});
  const rejected=await app.request('/api/admin/menu',{method:'PUT',body:{...updated.value,categoryMappings:body.categoryMappings}});
  assert.equal(rejected.status,400,'New automatic group rules are no longer accepted');
});

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vosem-menu-'));
  const seedPath = options.seedPath ?? path.join(directory, 'seed.json');
  const dataDir = options.dataDir ?? path.join(directory, 'store');
  if (!options.seedPath) await writeFile(seedPath, JSON.stringify(options.seedMenu ?? { items: seedItems, source: { note: 'Test seed' } }));
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
      result = await request('/api/admin/enroll/confirm', { method: 'POST', body: { enrollmentToken: started.value.enrollmentToken, code: totp(started.value.secret, { time: options.now?.() ?? Date.now() }) }, authenticated: false });
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
  async function slowRequest(route, { method = 'PUT', body, raw, contentType = 'application/json' } = {}) {
    const buffer = raw ?? Buffer.from(JSON.stringify(body));
    let ready;
    const bodyReadStarted = new Promise((resolve) => { ready = resolve; });
    // Wait for the real middleware's body reader, not an arbitrary sleep. Its
    // first session check has finished before it subscribes to request data.
    server.once('request', (incoming) => {
      const originalOn = incoming.on;
      incoming.on = function (type, listener) {
        const result = originalOn.call(this, type, listener);
        if (type === 'data') { incoming.on = originalOn; ready(); }
        return result;
      };
    });
    let req;
    const response = new Promise((resolve, reject) => {
      req = http.request(`${base}${route}`, { method, headers: { ...auth, Origin: base, 'Content-Type': contentType, 'Content-Length': buffer.length } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()) }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.flushHeaders();
    });
    t.after(() => req.destroy());
    let timer;
    try {
      await Promise.race([bodyReadStarted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Request never reached its body reader')), 3000); })]);
    } finally { clearTimeout(timer); }
    return { finish: () => { req.end(buffer); return response; } };
  }
  async function announcedUpload(contentLength) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${base}/api/admin/upload`, { method: 'POST', headers: { ...auth, Origin: base, 'Content-Type': 'image/png', 'Content-Length': contentLength } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => { resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()) }); req.destroy(); });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('Oversized upload was not rejected from its headers')));
      req.end();
    });
  }
  return { request, login, overlappingLogins, slowRequest, announcedUpload, stop, start, dataDir, seedPath };
}

test('HTTP device trust survives normal logout; explicit forget revokes the active session and device', async (t) => {
  let now = 1800000000000;
  const origin = 'https://cafe.example';
  const app = await fixture(t, { production: true, publicOrigin: origin, encryptionKey: '22'.repeat(32), now: () => now });
  const send = (route, body = {}, cookie = '', csrfToken = '') => app.request(route, { method: 'POST', origin, authenticated: false, body, headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken } });
  const login = await send('/api/admin/login', { username: 'admin', password: PASSWORD });
  assert.equal(login.status, 202);
  const setup = await send('/api/admin/enroll/start', { challengeToken: login.value.challengeToken, username: 'owner@example.test' });
  const done = await send('/api/admin/enroll/confirm', { enrollmentToken: setup.value.enrollmentToken, code: totp(setup.value.secret, { time: now }) });
  assert.equal(done.status, 200);
  const header = done.headers.getSetCookie().find((value) => value.startsWith('vosem_admin_device='));
  assert.match(header, /Path=\/api\/admin; HttpOnly; SameSite=Strict; Max-Age=34560000; Secure/);
  const device = header.split(';')[0];
  assert.equal(done.value.deviceToken, undefined); assert.equal(done.value.token, undefined);
  assert.equal((await app.request('/api/admin/menu', { headers: { Cookie: device } })).status, 401);
  const known = await app.request('/api/admin/session', { headers: { Cookie: device } });
  assert.equal(known.value.trustedUsername, 'owner@example.test'); assert.equal(known.value.authenticated, false);
  assert.equal((await app.request('/api/admin/resume', { method: 'POST', body: {}, headers: { Cookie: device }, origin: 'https://evil.example' })).status, 403);
  now += 31 * 86400000;
  const pending = await send('/api/admin/resume', {}, device);
  assert.equal(pending.status, 202);
  const unlocked = await send('/api/admin/verify', { challengeToken: pending.value.challengeToken, code: totp(setup.value.secret, { time: now }) }, device);
  assert.equal(unlocked.status, 200);
  const rotated = unlocked.headers.getSetCookie().find((value) => value.startsWith('vosem_admin_device=')).split(';')[0];
  assert.notEqual(rotated, device);
  assert.match(unlocked.headers.getSetCookie().find((value) => value.startsWith('vosem_admin_device=')), /Max-Age=34560000/);
  assert.equal((await send('/api/admin/resume', {}, device)).status, 401);
  const sessionCookie = unlocked.headers.getSetCookie().find((value) => value.startsWith('vosem_admin=')).split(';')[0];
  assert.equal((await app.request('/api/admin/menu', { headers: { Cookie: sessionCookie } })).status, 200);
  const allCookies = `${sessionCookie}; ${rotated}`;
  assert.equal((await send('/api/admin/logout', {}, allCookies)).status, 403);
  const out = await send('/api/admin/logout', {}, allCookies, unlocked.value.csrfToken);
  assert.equal(out.status, 200);
  assert.equal(out.value.authenticated, false);
  assert.equal(out.value.trustedUsername, 'owner@example.test');
  assert.equal(out.headers.getSetCookie().some((value) => value.startsWith('vosem_admin_device=')), false);
  assert.equal((await app.request('/api/admin/menu', { headers: { Cookie: allCookies } })).status, 401);
  now += 30000;
  const again = await send('/api/admin/resume', {}, rotated);
  assert.equal(again.status, 202);
  const relogin = await send('/api/admin/verify', { challengeToken: again.value.challengeToken, code: totp(setup.value.secret, { time: now }) }, rotated);
  const newCookies = relogin.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  assert.equal((await send('/api/admin/forget-device', {}, newCookies)).status, 403);
  const forgotten = await send('/api/admin/forget-device', {}, newCookies, relogin.value.csrfToken);
  assert.equal(forgotten.status, 200);
  assert.equal(forgotten.value.authenticated, false);
  assert.equal(forgotten.value.trustedUsername, undefined);
  assert.equal(forgotten.headers.getSetCookie().length, 2);
  for (const cleared of forgotten.headers.getSetCookie()) assert.match(cleared, /Max-Age=0/);
  assert.equal((await app.request('/api/admin/menu', { headers: { Cookie: newCookies } })).status, 401);
  assert.equal((await send('/api/admin/resume', {}, newCookies)).status, 401);
  assert.equal((await send('/api/admin/resume', {}, rotated)).status, 401);
});

test('HTTP status and menu reads do not keep a session alive; explicit activity requires session, origin and CSRF', async (t) => {
  let now = 1800000000000;
  const initialTime = now;
  const app = await fixture(t, { now: () => now });
  const login = await app.login();
  assert.equal(login.status, 200);
  assert.equal(login.value.username, 'admin');
  assert.deepEqual(login.value.session, { idleTimeoutMs: 900000, idleExpiresAt: now + 900000, expiresAt: now + 28800000, serverNow: now });
  now += 10 * 60000;
  assert.equal((await app.request('/api/admin/session')).value.session.idleExpiresAt, initialTime + 900000);
  assert.equal((await app.request('/api/admin/session')).value.username, 'admin');
  assert.equal((await app.request('/api/admin/menu')).status, 200);
  assert.equal((await app.request('/api/admin/activity', { method: 'POST', authenticated: false })).status, 401);
  assert.equal((await app.request('/api/admin/activity', { method: 'POST', headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await app.request('/api/admin/activity', { method: 'POST', origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.request('/api/admin/session')).value.session.idleExpiresAt, initialTime + 900000);
  const activity = await app.request('/api/admin/activity', { method: 'POST', body: {} });
  assert.equal(activity.status, 200);
  assert.equal(activity.value.authenticated, true);
  assert.equal(activity.value.username, 'admin');
  assert.equal(activity.value.session.idleExpiresAt, now + 900000);
  assert.equal(activity.value.session.expiresAt, initialTime + 28800000);
  assert.equal(activity.headers.get('set-cookie'), null);
  for (let minute = 1; minute < 15; minute++) {
    now += 60000;
    assert.equal((await app.request('/api/admin/session')).value.authenticated, true);
    assert.equal((await app.request('/api/admin/menu')).status, 200);
  }
  now += 60000;
  assert.equal((await app.request('/api/admin/session')).value.authenticated, false);
  assert.equal((await app.request('/api/admin/activity', { method: 'POST', body: {} })).status, 401);
  assert.equal((await app.request('/api/admin/menu')).status, 401);
});

test('logout forgetDevice flag clears both cookies and cannot be abused cross-origin or without CSRF', async (t) => {
  const app = await fixture(t);
  const logged = await app.login();
  const cookies = logged.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const headers = { Cookie: cookies };
  assert.equal((await app.request('/api/admin/logout', { method: 'POST', body: { forgetDevice: true }, headers, origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.request('/api/admin/logout', { method: 'POST', body: { forgetDevice: true }, headers: { ...headers, 'X-CSRF-Token': '' } })).status, 403);
  const out = await app.request('/api/admin/logout', { method: 'POST', body: { forgetDevice: true }, headers });
  assert.equal(out.status, 200);
  assert.equal(out.value.trustedUsername, undefined);
  assert.equal(out.headers.getSetCookie().length, 2);
  for (const cookie of out.headers.getSetCookie()) assert.match(cookie, /Max-Age=0/);
  assert.equal((await app.request('/api/admin/session', { headers })).value.authenticated, false);
  assert.equal((await app.request('/api/admin/resume', { method: 'POST', body: {}, headers })).status, 401);
});

test('public menu includes every assigned dish; admin API requires login and secure cookie settings', async (t) => {
  const app = await fixture(t);
  const publicMenu = await app.request('/api/menu');
  assert.equal(publicMenu.status, 200);
  assert.equal(publicMenu.value.revision, 1);
  assert.equal(publicMenu.value.items[0].availableForOrder, true);
  assert.deepEqual(publicMenu.value.items.map((item) => item.id), ['hidden','egg-toast']);
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

test('edits, removal, and ordering of seeded dishes persist across restart', async (t) => {
  const porridge = { id: 'porridge', name: 'Каша', description: 'На молоке', price: 300, category: 'porridge', image: 'menu-images/porridge.webp', published: false, order: 2 };
  const app = await fixture(t, {seedMenu:{items:[...seedItems,porridge]}});
  await app.login();
  const { value: original } = await app.request('/api/admin/menu');
  const items = original.items.map((item) => ({ ...item, published: true, price: item.price + 10 }));
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

test('admin saves cannot create dishes or rewrite their trusted cash-system source', async t => {
  const source = {provider:'kds',organizationId:'test-org',externalId:'101',groupExternalId:'10',testOnly:true};
  const sourceCategories = [{id:'cash-coffee',name:'Кофе',parentId:null,order:0,source:{provider:'kds',organizationId:'test-org',externalId:'10',testOnly:true}}];
  const app = await fixture(t,{seedMenu:{sourceCategories,items:[...seedItems,{...seedItems[0],id:'cash-dish',category:null,source,published:false,availableForOrder:false}]}});
  await app.login();
  const initial=(await app.request('/api/admin/menu')).value;
  const attempts = [
    {code:'import_only',patch:{items:[...initial.items,{...initial.items[0],id:'manual-new'}]}},
    {code:'import_only',patch:{items:[...initial.items,{...initial.items[2],id:'forged-import',source:{...source,externalId:'202'}}]}},
    {code:'immutable_source',patch:{items:initial.items.map(item=>item.id==='cash-dish'?{...item,source:{...source,externalId:'202'}}:item)}},
    {code:'immutable_source',patch:{items:initial.items.map(item=>item.id==='cash-dish'?{...item,source:null}:item)}},
    {code:'immutable_source',patch:{items:initial.items.map(item=>item.id==='egg-toast'?{...item,source}:item)}},
    {code:'immutable_source',patch:{sourceCategories:sourceCategories.map(group=>({...group,name:'Подменённая группа'}))}},
    {code:'immutable_source',patch:{sourceCategories:[]}},
    {code:'immutable_source',patch:{categories:[...initial.categories,{id:'forged-group',name:'Подменённая группа',parentId:null,order:2,source:{...source,externalId:'20'}}]}},
  ];
  for (const {code,patch} of attempts) {
    const rejected=await app.request('/api/admin/menu',{method:'PUT',body:{...initial,...patch}});
    assert.equal(rejected.status,400,code);
    assert.equal(rejected.value.code,code);
    assert.deepEqual((await app.request('/api/admin/menu')).value,initial,'Rejected edit must leave the catalog and revision unchanged');
  }
  const items=initial.items.map(({source:_source,...item})=>item.id==='cash-dish'?{...item,category:'dinner',published:true,price:620,name:'Кофе для гостей'}:item);
  const saved=await app.request('/api/admin/menu',{method:'PUT',body:{revision:initial.revision,items}});
  assert.equal(saved.status,200);
  assert.deepEqual(saved.value.items.find(item=>item.id==='cash-dish').source,source,'Omitted importer metadata must be restored');
  assert.equal(saved.value.items.find(item=>item.id==='cash-dish').availableForOrder,false,'Test imports stay unavailable for ordering');
  assert.deepEqual(saved.value.sourceCategories,sourceCategories);
  assert.equal((await app.request('/api/menu')).value.items.find(item=>item.id==='cash-dish').name,'Кофе для гостей');
});

test('manual website groups can be deleted atomically after moving existing dishes', async t => {
  const app=await fixture(t);
  await app.login();
  const initial=(await app.request('/api/admin/menu')).value;
  const added=await app.request('/api/admin/menu',{method:'PUT',body:{...initial,categories:[...initial.categories,{id:'drinks',name:'Напитки',parentId:null,order:2}],items:initial.items.map(item=>({...item,category:'drinks'}))}});
  assert.equal(added.status,200);
  const categories=added.value.categories.filter(group=>group.id!=='drinks');
  const unsafe=await app.request('/api/admin/menu',{method:'PUT',body:{...added.value,categories}});
  assert.equal(unsafe.status,400,'A group containing assigned dishes cannot disappear silently');
  assert.deepEqual((await app.request('/api/admin/menu')).value,added.value);
  const removed=await app.request('/api/admin/menu',{method:'PUT',body:{...added.value,categories,items:added.value.items.map(item=>({...item,category:'breakfast'}))}});
  assert.equal(removed.status,200);
  assert.equal(removed.value.items.length,initial.items.length);
  assert.equal(removed.value.categories.some(group=>group.id==='drinks'),false);
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
    assert.equal(visible.length, 2);
    assert.equal(visible[0].image, '/menu-images/current.webp');
    assert.equal(visible.find(item=>item.id==='egg-toast').price, 475);
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
    { price: -1 }, { price: 1.111 }, { price: '400' }, { category: 'invalid' },
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
  const largePng = PNG.sync.write({ width: 1536, height: 1536, data: randomBytes(1536 * 1536 * 4) });
  assert.ok(largePng.length > 5 * 1024 * 1024, 'The valid image exceeds the previous 5 MiB limit');
  const largeUpload = await app.request('/api/admin/upload', { method: 'POST', raw: largePng, headers: { 'Content-Type': 'image/png' } });
  assert.equal(largeUpload.status, 201);
  assert.deepEqual((await app.request(largeUpload.value.url, { authenticated: false })).value, largePng);
  const oversized = await app.announcedUpload(100 * 1024 * 1024 + 1);
  assert.equal(oversized.status, 413);
  assert.equal(oversized.value.code, 'too_large');
  assert.match(oversized.value.error, /100 МБ/);
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

test('a delayed mutation body cannot save after idle expiry or explicit logout', async (t) => {
  await t.test('menu body received after the fifteen-minute deadline leaves the catalog unchanged', async (t) => {
    let now = Date.now();
    const app = await fixture(t, { now: () => now });
    await app.login();
    const menu = (await app.request('/api/admin/menu')).value;
    const pending = await app.slowRequest('/api/admin/menu', { body: { revision: menu.revision, items: menu.items.map((item) => ({ ...item, name: 'Must not be saved' })) } });
    now += 900000;
    const denied = await pending.finish();
    assert.equal(denied.status, 401);
    assert.equal(denied.value.code, 'unauthorized');
    assert.deepEqual(JSON.parse(await readFile(path.join(app.dataDir, 'menu.json'), 'utf8')), menu);
  });
  await t.test('upload body received after logout cannot create a file', async (t) => {
    const app = await fixture(t);
    await app.login();
    const pending = await app.slowRequest('/api/admin/upload', { method: 'POST', raw: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), contentType: 'image/jpeg' });
    assert.equal((await app.request('/api/admin/logout', { method: 'POST' })).status, 200);
    const denied = await pending.finish();
    assert.equal(denied.status, 401);
    assert.equal(denied.value.code, 'unauthorized');
    const images = await readdir(path.join(app.dataDir, 'uploads')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    assert.deepEqual(images, []);
  });
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


test('compatible legacy reads remain unchanged and admin visibility flags are derived from placement', async (t) => {
  const app = await fixture(t);
  await app.request('/api/menu');
  const placed = seedItems.map(item=>({...item,published:true}));
  const legacy = JSON.stringify({ revision: 7, items: placed });
  await writeFile(path.join(app.dataDir, 'menu.json'), legacy);
  const loaded = (await app.request('/api/menu')).value;
  assert.equal(loaded.revision, 7);
  assert.equal(loaded.items[0].availableForOrder, true);
  assert.equal(await readFile(path.join(app.dataDir, 'menu.json'), 'utf8'), legacy, 'Already compatible legacy flags need no migration');
  await app.login();
  const saved = await app.request('/api/admin/menu', { method: 'PUT', body: { revision: 7, items: [
    { ...seedItems[0], published:false, availableForOrder: false },
    { ...seedItems[1], published:'ignored', availableForOrder: 'ignored' },
  ] } });
  assert.equal(saved.status, 200);
  assert.equal(saved.value.revision, 8);
  assert.equal(saved.value.items[0].published, true);
  assert.equal(saved.value.items[0].availableForOrder, true);
  assert.equal(saved.value.items[1].published, true);
  assert.equal(saved.value.items[1].availableForOrder, true);
  for (const route of ['/api/menu', '/data/menu.json']) {
    const catalog = (await app.request(route)).value;
    assert.equal(catalog.revision, saved.value.revision);
    assert.deepEqual(catalog.items.map((item) => item.id), ['hidden','egg-toast']);
    assert.ok(catalog.items.every(item=>item.published&&item.availableForOrder), 'Assigned dishes cannot be manually hidden or marked unavailable');
  }
  await app.stop(); await app.start();
  assert.deepEqual((await app.request('/api/menu')).value, { categories: saved.value.categories, items: [...saved.value.items].sort((a,b)=>a.order-b.order), revision: 8 });
  assert.deepEqual(JSON.parse(await readFile(path.join(app.dataDir, 'menu.json'), 'utf8')), saved.value);
});

test('old website nesting and manual flags migrate once with a raw backup while cash nesting is preserved', async t => {
  const app=await fixture(t);await app.login();
  const current=(await app.request('/api/admin/menu')).value;
  const source=externalId=>({provider:'kds',organizationId:'org-test',externalId,testOnly:true});
  const sourceCategories=[
    {id:'cash-bar',name:'Бар',parentId:null,order:0,source:source('bar')},
    {id:'cash-coffee',name:'Кофе',parentId:'cash-bar',order:0,source:source('coffee')},
  ];
  const original={revision:12,categories:[...current.categories,{id:'brunch',name:'Поздние завтраки',parentId:'breakfast',order:2}],sourceCategories,items:[
    {...current.items[0],category:'brunch',published:false,availableForOrder:false},
    {...current.items[1],published:false,availableForOrder:false},
    {...current.items[0],id:'cash-only',category:null,published:true,availableForOrder:true,source:{...source('cash-dish'),groupExternalId:'coffee'}},
    {...current.items[0],id:'cash-placed',category:'dinner',published:false,availableForOrder:true,source:{...source('cash-placed'),groupExternalId:'coffee'}},
  ]};
  const raw=JSON.stringify(original,null,4)+'\n';await writeFile(path.join(app.dataDir,'menu.json'),raw);
  const migrated=(await app.request('/api/admin/menu')).value;
  assert.equal(migrated.revision,13);
  assert.ok(migrated.categories.every(group=>group.parentId===null));
  assert.deepEqual(migrated.sourceCategories,sourceCategories);
  assert.equal(migrated.items[0].category,'brunch');
  assert.equal(migrated.items[0].name,original.items[0].name);
  assert.deepEqual(migrated.items.map(item=>[item.published,item.availableForOrder]),[[true,true],[true,true],[false,false],[true,false]]);
  const backups=(await readdir(app.dataDir)).filter(name=>name.startsWith('menu-before-flat-groups-'));
  assert.equal(backups.length,1);
  assert.equal(await readFile(path.join(app.dataDir,backups[0]),'utf8'),raw);
  const attemptedNested={...migrated,categories:migrated.categories.map(group=>group.id==='brunch'?{...group,parentId:'breakfast'}:group)};
  const rejected=await app.request('/api/admin/menu',{method:'PUT',body:attemptedNested});
  assert.equal(rejected.status,400);assert.equal(rejected.value.code,'flat_site_groups');
  assert.deepEqual((await app.request('/api/admin/menu')).value,migrated);
  await app.stop();await app.start();await app.login();
  assert.deepEqual((await app.request('/api/admin/menu')).value,migrated);
  assert.deepEqual((await readdir(app.dataDir)).filter(name=>name.startsWith('menu-before-flat-groups-')),backups);
  const withoutFlags={...migrated,items:migrated.items.map(({published,availableForOrder,...item})=>item)};
  const saved=await app.request('/api/admin/menu',{method:'PUT',body:withoutFlags});
  assert.equal(saved.status,200);
  assert.deepEqual(saved.value.items,migrated.items,'Publication controls are not required in requests');
});

test('explicit hiding survives saves and restart, excludes both public feeds and can be reversed without data loss', async t => {
  const app = await fixture(t); await app.login();
  const original = (await app.request('/api/admin/menu')).value;
  const item = original.items[0];
  const saved = await app.request('/api/admin/menu', { method:'PUT', body:{ ...original, items:original.items.map(entry => entry.id === item.id ? {...entry,hiddenOnSite:true} : entry) } });
  assert.equal(saved.status,200); const hidden = saved.value.items.find(entry=>entry.id===item.id);
  assert.equal(hidden.published,false); assert.equal(hidden.availableForOrder,false);
  assert.equal(hidden.category,item.category); assert.equal(hidden.name,item.name);
  for (const route of ['/api/menu','/data/menu.json']) assert.ok(!(await app.request(route)).value.items.some(entry=>entry.id===item.id),route);
  await app.stop(); await app.start(); await app.login();
  const reloaded = (await app.request('/api/admin/menu')).value;
  assert.deepEqual(reloaded.items.find(entry=>entry.id===item.id),hidden);
  for (const hiddenOnSite of ['true', null, 1]) {
    const invalid = await app.request('/api/admin/menu', {method:'PUT',body:{...reloaded,items:reloaded.items.map(entry=>entry.id===item.id?{...entry,hiddenOnSite}:entry)}});
    assert.equal(invalid.status,400);
  }
  const shown = await app.request('/api/admin/menu', {method:'PUT',body:{...reloaded,items:reloaded.items.map(entry=>entry.id===item.id?{...entry,hiddenOnSite:false}:entry)}});
  assert.equal(shown.status,200); assert.equal(shown.value.items.find(entry=>entry.id===item.id).published,true);
  assert.ok((await app.request('/api/menu')).value.items.some(entry=>entry.id===item.id));
});
