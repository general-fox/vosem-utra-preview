import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { phpBinary } from '../scripts/php-runtime.mjs';
import { encryptTotp } from '../server/auth.mjs';
import { createHash } from 'node:crypto';
import { phpEnvironment } from '../scripts/php-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('REG.RU stable assets are complete without archived images or font source files', async () => {
  const site = path.join(root, 'dist-reg/site');
  const names = await readdir(path.join(site, 'assets'));
  for (const name of ['logo.svg', 'favicon.svg', 'cookie-sun.svg', 'VosemSans-Regular.woff2',
    'VosemSans-Medium.woff2', 'VosemSans-Italic.woff2', 'Lato-OFL.txt', 'VosemSans-WOFF2.txt']) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(!names.some(name => /\.(?:ttf|png|jpe?g)$/i.test(name)), 'No unused originals in deployment assets');
  const templates = path.join(root, 'dist-reg/vosem-utra-private/app/templates');
  for (const name of ['registration', 'privacy', 'consent']) {
    const html = await readFile(path.join(templates, name + '.html'), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="(assets\/[^"?#]+)"/g)) {
      assert.ok((await readFile(path.join(site, match[1]))).length, `${name}: ${match[1]}`);
    }
  }
});
test('REG.RU consent receipts hash the current archived documents, not removed public HTML', async () => {
  const site = path.join(root, 'dist-reg/site');
  const privateDir = path.join(root, 'dist-reg/vosem-utra-private');
  const registration = await readFile(path.join(privateDir, 'app/templates/registration.html'), 'utf8');
  const version = registration.match(/name="ConsentVersion" value="([^"]+)"/)[1];
  assert.equal(version, '2026-09-29-reg5');
  const result = spawnSync(phpBinary, ['-r', 'require $argv[1]; echo json_encode([CONSENT_VERSION, consent_document_hash("privacy"), consent_document_hash("consent")]);', path.join(site, 'api/consent-log.php')], { encoding: 'utf8', env: phpEnvironment });
  assert.equal(result.status, 0, result.stderr);
  const hashes = JSON.parse(result.stdout);
  assert.equal(hashes[0], version);
  for (const [index, page] of ['privacy', 'consent'].entries()) {
    const displayed = await readFile(path.join(privateDir, 'app/templates', page + '.html'));
    const archived = await readFile(path.join(privateDir, 'legal-versions', version, page + '.html'));
    assert.deepEqual(archived, displayed);
    assert.equal(hashes[index + 1], createHash('sha256').update(displayed).digest('hex'));
  }
});
async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening'); const port = server.address().port;
  await new Promise((resolve) => server.close(resolve)); return port;
}
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('offline PHP access preparation preserves an enrolled phone and refuses overwrite', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'vosem-php-provision-'));
  const key = randomBytes(32);
  const account = { version: 2, username: 'v.utra@yandex.ru', totp: { encrypted: encryptTotp('JBSWY3DPEHPK3PXP', key), lastCounter: 0 }, recovery: [] };
  try {
    const created = spawnSync(phpBinary, [path.join(root, 'hosting/prepare-access.php'), temp, '--import-node'], { input: JSON.stringify({ account, encryptionKey: key.toString('hex') }), encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    const state = JSON.parse(await readFile(path.join(temp, 'admin-data/auth-state.json'), 'utf8'));
    assert.deepEqual(state.account.totp, account.totp);
    assert.match(state.account.passwordHash, /^\$(?:argon2id|2y)\$/);
    const verify = spawnSync(phpBinary, ['-r', `require $argv[1]; $c = require $argv[2].'/admin-config.php'; $a = new CafeAuth($argv[2].'/admin-data', ['public_origin'=>$c['publicOrigin'], 'encryption_key'=>$c['encryptionKey']]); $s=$a->status(); if (!$s['ready'] || $s['enrollmentAvailable']) exit(1);`, path.join(root, 'hosting/php/auth.php'), temp], { encoding: 'utf8' });
    assert.equal(verify.status, 0, verify.stderr);
    const overwritten = spawnSync(phpBinary, [path.join(root, 'hosting/prepare-access.php'), temp], { encoding: 'utf8' });
    assert.notEqual(overwritten.status, 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(temp, 'admin-data/auth-state.json'), 'utf8')).account.totp, account.totp);
    assert.ok(!created.stdout.includes(key.toString('hex')));
  } finally {
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir())); assert.ok(path.basename(temp).startsWith('vosem-php-provision-'));
    await rm(temp, { recursive: true, force: true });
  }
});

test('assembled REG.RU PHP package: HTTP auth, menu, photos, SSR and restart', { timeout: 90000 }, async (t) => {
  const seed = JSON.parse(await readFile(path.join(root, 'public/data/menu.json'), 'utf8'));
  const seedIds = seed.items.map(({ id }) => id).sort();
  const temp = await mkdtemp(path.join(os.tmpdir(), 'vosem-php-http-'));
  const site = path.join(temp, 'site');
  const privateDir = path.join(temp, 'vosem-utra-private');
  const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
  const password = 'HTTP-test-password-' + randomBytes(12).toString('hex');
  const hash = spawnSync(phpBinary, ['-r', 'echo password_hash(stream_get_contents(STDIN), PASSWORD_ARGON2ID);'], { input: password, encoding: 'utf8' });
  assert.equal(hash.status, 0, hash.stderr);
  let server; let serverLog = ''; let cookie = ''; let csrf = '';
  async function start() {
    serverLog = '';
    server = spawn(phpBinary, ['-S', `127.0.0.1:${port}`, '-t', site, path.join(root, 'hosting/dev-router.php')], { cwd: root, env: { ...process.env, CAFE_ENV: 'development' }, stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (server.exitCode !== null) throw new Error('PHP exited: ' + serverLog);
      try { await fetch(origin + '/robots.txt'); return; } catch { await pause(50); }
    }
    throw new Error('PHP server did not start: ' + serverLog);
  }
  async function stop() {
    if (server && server.exitCode === null) { const done = once(server, 'exit'); server.kill(); await done; }
  }
  async function request(url, { method = 'GET', body, auth = false, token = false, headers = {} } = {}) {
    const response = await fetch(origin + url, { method, redirect: 'manual', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && method !== 'HEAD' ? { Origin: origin } : {}), ...(auth ? { Cookie: cookie } : {}), ...(token ? { 'X-CSRF-Token': csrf } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const text = await response.text(); let json;
    try { json = JSON.parse(text); } catch {}
    return { response, status: response.status, text, json };
  }
  try {
    await cp(path.join(root, 'dist-reg'), temp, { recursive: true });
    await writeFile(path.join(privateDir, 'admin-config.php'), `<?php return ${JSON.stringify({ publicOrigin: 'https://vosem-utra.ru', username: 'v.utra@yandex.ru', passwordHash: hash.stdout, encryptionKey: randomBytes(32).toString('hex') }).replace(/^/, "json_decode('").replace(/$/, "', true);")}`);
    await start();
    await t.test('pages, cookies, assets, photos and private paths', async () => {
      const home = await request('/'); assert.equal(home.status, 200, serverLog);
      assert.match(home.text, /data-cookie-settings/); assert.match(home.text, /dish-card/);
      assert.equal((home.text.match(/\bdata-cookie-settings\b/g) || []).length, 1, 'One cookie settings button after REG packaging');
      assert.doesNotMatch(home.text, /src="cookies\.js\?/, 'Do not load the legacy module alongside its Vite bundle');
      assert.match(home.response.headers.get('Content-Security-Policy'), /nonce-/);
      const urls = new Set([...home.text.matchAll(/(?:src|href)="([^"#]+)"/g)].map((match) => match[1]).filter((url) => !/^(?:https?:|mailto:|tel:|data:)/.test(url)));
      for (const url of urls) {
        const result = await request('/' + url.replace(/^\//, ''));
        if (url === 'index.html') { assert.equal(result.status, 308); assert.equal(result.response.headers.get('Location'), '/'); }
        else assert.equal(result.status, 200, `${url}: ${result.status}`);
      }
      for (const page of ['admin.html', 'registration.html', 'privacy.html', 'consent.html']) {
        const result = await request('/' + page); assert.equal(result.status, 200);
        assert.match(result.response.headers.get('X-Robots-Tag'), /noindex/);
        if (page === 'registration.html') { assert.doesNotMatch(result.text, /data-preview="true"/); assert.match(result.response.headers.get('Content-Security-Policy'), /www\.recaptcha\.net/); }
        if (page === 'admin.html') assert.doesNotMatch(result.response.headers.get('Content-Security-Policy'), /recaptcha/);
      }
      for (const url of ['/.env', '/.data/admin-auth.json', '/.git/config', '/vosem-utra-private/admin-config.php', '/admin-data/auth-state.json', '/api/loyalty-core.php', '/api/recaptcha.php', '/api/consent-log.php', '/unknown-page', '/uploads/missing.php']) assert.equal((await request(url)).status, 404, url);
      assert.equal((await request('/admin')).response.headers.get('Location'), '/admin.html');
      assert.equal((await request('/index.html')).response.headers.get('Location'), '/');
      assert.equal((await request('/', { method: 'HEAD' })).text, '');
      assert.doesNotMatch((await request('/sitemap.xml')).text, /admin|<loc>/);
      const menu = await request('/api/menu'); assert.equal(menu.status, 200);
      assert.deepEqual(menu.json.items.map(({ id }) => id).sort(), seedIds, 'The full initial menu includes drinks');
      for (const item of menu.json.items.filter((item) => item.image)) assert.equal((await request(item.image)).status, 200);
    });
    await t.test('password login creates a protected session and retired MFA routes cannot authenticate', async () => {
      assert.equal((await request('/api/admin/menu')).status, 401);
      assert.equal((await request('/api/admin/sync-availability', { method: 'POST', body: {} })).status, 401);
      assert.equal((await request('/api/admin/enroll/start', { method: 'POST', body: { username: 'v.utra@yandex.ru', challengeToken: 'fake' } })).status, 404);
      assert.equal((await request('/api/admin/login', { method: 'POST', body: { username: 'v.utra@yandex.ru', password }, headers: { Origin: 'https://attacker.example' } })).status, 403);
      const login = await request('/api/admin/login', { method: 'POST', body: { username: 'v.utra@yandex.ru', password } });
      assert.equal(login.status, 200, login.text); assert.equal(login.json.authMode, 'password'); assert.equal(login.json.authenticated,true);
      csrf=login.json.csrfToken;cookie=login.response.headers.get('Set-Cookie').split(';')[0];
      assert.match(login.response.headers.get('Set-Cookie'), /HttpOnly/i); assert.match(login.response.headers.get('Set-Cookie'), /SameSite=Strict/i);
      for(const endpoint of ['verify','resume','enroll/confirm']) assert.equal((await request('/api/admin/'+endpoint,{method:'POST',body:{}})).status,404);
      const state = await readFile(path.join(privateDir, 'admin-data/auth-state.json'), 'utf8');
      assert.ok(!state.includes(password)); assert.ok(!state.includes(cookie.split('=')[1]));
    });
    let menu; let uploaded;
    await t.test('CSRF, revision conflicts, upload validation and escaped live menu', async () => {
      const before = (await request('/api/admin/session', { auth: true })).json;
      assert.equal(before.session.idleTimeoutMs, 900000);
      assert.equal((await request('/api/admin/activity', { method: 'POST', auth: true })).status, 403);
      assert.equal((await request('/api/admin/activity', { method: 'POST', auth: true, token: true, headers: { Origin: 'https://attacker.example' } })).status, 403);
      assert.equal((await request('/api/admin/session', { auth: true })).json.session.idleExpiresAt, before.session.idleExpiresAt);
      const active = await request('/api/admin/activity', { method: 'POST', auth: true, token: true });
      assert.equal(active.status, 200); assert.equal(active.json.authenticated, true);
      assert.ok(active.json.session.idleExpiresAt > before.session.idleExpiresAt);
      assert.equal(active.json.session.expiresAt, before.session.expiresAt);
      assert.equal(active.response.headers.get('set-cookie'), null, 'Activity never refreshes a device cookie');
      assert.equal((await request('/api/admin/forget-device', { method: 'POST', auth: true })).status, 403);
      menu = (await request('/api/admin/menu', { auth: true })).json;
      assert.equal((await request('/api/admin/menu', { method: 'PUT', auth: true, body: menu })).status, 403);
      const photoPath = menu.items.find((item) => item.image).image;
      const photo = await readFile(path.join(site, photoPath));
      const upload = await request('/api/admin/upload', { method: 'POST', auth: true, token: true, body: photo, headers: { 'Content-Type': 'image/webp' } });
      assert.equal(upload.status, 201, upload.text); uploaded = upload.json.url;
      assert.equal((await request(uploaded)).status, 200);
      assert.equal((await request('/api/admin/upload', { method: 'POST', auth: true, token: true, body: '<?php echo "bad"; ?>', headers: { 'Content-Type': 'image/webp' } })).status, 400);
      menu.items[0].name = 'Тест <script>alert(1)</script> & завтрак'; menu.items[0].price = 777; menu.items[0].image = uploaded;
      menu.items[1].published = false;
      const saved = await request('/api/admin/menu', { method: 'PUT', auth: true, token: true, body: menu }); assert.equal(saved.status, 200, saved.text);
      assert.equal((await request('/api/admin/menu', { method: 'PUT', auth: true, token: true, body: menu })).status, 409);
      const home = await request('/'); assert.match(home.text, /Тест &lt;script&gt;/); assert.doesNotMatch(home.text, /<script>alert\(1\)<\/script>/); assert.match(home.text, /777/);
      assert.ok(home.text.includes(menu.items[1].name), 'Group assignment controls visibility; obsolete manual flags are ignored');
      assert.deepEqual((await request('/data/menu.json')).json.items.map(({ id }) => id).sort(), seedIds);
    });
    await t.test('cash availability refresh requires session, CSRF and same origin and fails safely without KDS config', async () => {
      assert.equal((await request('/api/admin/sync-availability', { method: 'POST', auth: true, body: {} })).status, 403);
      assert.equal((await request('/api/admin/sync-availability', { method: 'POST', auth: true, token: true, body: {}, headers: { Origin: 'https://attacker.example' } })).status, 403);
      const before = (await request('/api/admin/menu', { auth: true })).json;
      assert.equal(before.keeperSync.configured, false);
      const result = await request('/api/admin/sync-availability', { method: 'POST', auth: true, token: true, body: {} });
      assert.equal(result.status, 503, result.text); assert.equal(result.json.code, 'keeper_not_configured');
      assert.deepEqual(Object.keys(result.json).sort(), ['code', 'error']);
      assert.doesNotMatch(result.text, /servicePassword|serviceName|kds-config|vosem-php-http|192\.168|89\.108/);
      const after = (await request('/api/admin/menu', { auth: true })).json;
      assert.equal(after.revision, before.revision); assert.deepEqual(after.items, before.items);
    });
    await t.test('POS hierarchy stays private until an editor assigns an individual website category', async () => {
      const initial = (await request('/api/admin/menu', { auth: true })).json;
      const manualCreation = await request('/api/admin/menu', { method: 'PUT', auth: true, token: true,
        body: { ...initial, items: [...initial.items, { ...initial.items[0], id: 'new-manual-dish' }] } });
      assert.equal(manualCreation.status, 400, manualCreation.text);
      assert.equal(manualCreation.json.code, 'import_only');
      assert.equal((await request('/api/admin/menu', { auth: true })).json.revision, initial.revision);
      const importPath = path.join(privateDir, 'fixture-pos-menu.json');
      await writeFile(importPath, JSON.stringify({ groups: [{ externalId: 'bar', name: 'Бар', parentExternalId: '0', items: [],
        childGroups: [{ externalId: 'coffee', name: 'Кофе', parentExternalId: 'bar', childGroups: [],
          items: [{ externalId: 'latte', name: 'Латте из источника', price: 250, description: 'Тест иерархии' }] }] }] }));
      const imported = spawnSync(phpBinary, [path.join(privateDir, 'app/import-menu.php'), privateDir, importPath, 'fixture-org', 'bar', '--test'], { encoding: 'utf8' });
      assert.equal(imported.status, 0, imported.stderr);
      assert.equal(JSON.parse(imported.stdout).imported, true);
      const snapshot = (await request('/api/admin/menu', { auth: true })).json;
      assert.deepEqual(snapshot.categories, initial.categories, 'Import cannot add or change website groups');
      const sourceDish = snapshot.items.find(item => item.source?.externalId === 'latte');
      assert.ok(sourceDish, 'Only trusted import adds a new dish');
      const sourceDishId = sourceDish.id;
      const forged = await request('/api/admin/menu', { method: 'PUT', auth: true, token: true,
        body: { ...snapshot, items: [...snapshot.items, { ...sourceDish, id: 'forged-import', source: { ...sourceDish.source, externalId: 'forged-import' } }] } });
      assert.equal(forged.status, 400, forged.text); assert.equal(forged.json.code, 'import_only');
      const sourceChanged = await request('/api/admin/menu', { method: 'PUT', auth: true, token: true,
        body: { ...snapshot, items: snapshot.items.map(item => item.id === sourceDishId ? { ...item, source: { ...item.source, testOnly: false } } : item) } });
      assert.equal(sourceChanged.status, 400, sourceChanged.text); assert.equal(sourceChanged.json.code, 'immutable_source');
      const groupChanged = await request('/api/admin/menu', { method: 'PUT', auth: true, token: true,
        body: { ...snapshot, sourceCategories: snapshot.sourceCategories.map(group => ({ ...group, name: 'Подмена группы' })) } });
      assert.equal(groupChanged.status, 400, groupChanged.text); assert.equal(groupChanged.json.code, 'immutable_source');
      const changes = { ...snapshot,
        categories: [...snapshot.categories, { id: 'fixture-drinks', name: 'Тестовые напитки', parentId: null, order: snapshot.categories.length }],
        categoryMappings: [],
      };
      const nested = await request('/api/admin/menu', { method: 'PUT', auth: true, token: true,
        body: { ...changes, categories: changes.categories.map(group => group.id === 'fixture-drinks' ? { ...group, parentId: 'breakfast' } : group) } });
      assert.equal(nested.status, 400, nested.text); assert.equal(nested.json.code, 'flat_site_groups');
      const rejected = await request('/api/admin/menu', { method: 'PUT', auth: true, token: true,
        body: { ...changes, categoryMappings: [{ provider: 'kds', organizationId: 'fixture-org', externalId: 'coffee', categoryId: 'fixture-drinks' }] } });
      assert.equal(rejected.status, 400, rejected.text);
      assert.equal((await request('/api/admin/menu', { auth: true })).json.revision, snapshot.revision);
      const saved = await request('/api/admin/menu', { method: 'PUT', auth: true, token: true, body: changes });
      assert.equal(saved.status, 200, saved.text);
      assert.deepEqual(saved.json.sourceCategories, changes.sourceCategories);
      assert.deepEqual(saved.json.categoryMappings, changes.categoryMappings);
      assert.equal(saved.json.items.find(({ id }) => id === sourceDishId).published, false);
      assert.ok(!(await request('/api/menu')).json.items.some(({ id }) => id === sourceDishId));
      assert.doesNotMatch((await request('/')).text, /Латте из источника/);
      const placed = { ...saved.json, items: saved.json.items.map(item => item.id === sourceDishId ? { ...item, category: 'fixture-drinks', published: false, availableForOrder: true } : item) };
      const assigned = await request('/api/admin/menu', { method: 'PUT', auth: true, token: true, body: placed });
      assert.equal(assigned.status, 200, assigned.text);
      const publicMenu = (await request('/api/menu')).json;
      const latte = publicMenu.items.find(({ id }) => id === sourceDishId);
      assert.equal(latte.category, 'fixture-drinks'); assert.equal(latte.published, true); assert.equal(latte.availableForOrder, false);
      assert.ok(publicMenu.categories.some(({ name }) => name === 'Тестовые напитки'));
      assert.equal(publicMenu.sourceCategories, undefined, 'Import configuration is only in the authenticated editor');
      const home = await request('/');
      assert.match(home.text, /data-menu-category="fixture-drinks"/); assert.match(home.text, /Латте из источника/);
      const changed = await request('/api/admin/menu', { method: 'PUT', auth: true, token: true, body: { ...assigned.json,
        items: assigned.json.items.map(item => item.id === sourceDishId ? { ...item, category: 'dinner' } : item) } });
      assert.equal(changed.status, 200, changed.text);
      assert.equal((await request('/api/menu')).json.items.find(({ id }) => id === sourceDishId).category, 'dinner', 'No group rule overrides individual edits');
      const removed = await request('/api/admin/menu', { method: 'PUT', auth: true, token: true, body: { ...changed.json,
        categories: changed.json.categories.filter(group => group.id !== 'dinner'),
        items: changed.json.items.map(item => item.id === sourceDishId ? { ...item, category: null, published: true } : item) } });
      assert.equal(removed.status, 200, removed.text);
      assert.ok(!(await request('/api/menu')).json.items.some(({ id }) => id === sourceDishId));
      assert.ok(!removed.json.categories.some(group => group.id === 'dinner'), 'Group removal saves atomically with cash-only dish');
      assert.equal(removed.json.items.find(item => item.id === sourceDishId).source.externalId, 'latte');
      const invalidTree = removed.json.categories.map(category => category.id === 'fixture-drinks' ? { ...category, parentId: 'fixture-drinks' } : category);
      assert.equal((await request('/api/admin/menu', { method: 'PUT', auth: true, token: true, body: { ...removed.json, categories: invalidTree } })).status, 400);
      assert.equal((await request('/api/admin/menu', { auth: true })).json.revision, removed.json.revision);
    });
    await t.test('PHP restart preserves menu and sessions; logout requires password again', async () => {
      await stop(); await start();
      assert.equal((await request('/api/admin/session', { auth: true })).json.authenticated, true);
      assert.equal((await request('/api/admin/menu', { auth: true })).json.items[0].price, 777);
      assert.equal((await request(uploaded)).status, 200);
      assert.equal((await request('/api/admin/logout', { method: 'POST', auth: true, body: {} })).status, 403);
      assert.equal((await request('/api/admin/logout', { method: 'POST', auth: true, token: true, body: {} })).status, 200);
      assert.equal((await request('/api/admin/menu', { auth: true })).status, 401);
      const login = await request('/api/admin/login', { method: 'POST', body: { username: 'v.utra@yandex.ru', password } }); assert.equal(login.status, 200); assert.equal(login.json.authMode,'password');
      assert.equal((await request('/api/admin/verify', { method: 'POST', body: { code: 'retired-recovery-code' } })).status, 404);
    });
    await t.test('offline employee add preserves owner; temporary password is replaced without an authenticator', async () => {
      const before = JSON.parse(await readFile(path.join(privateDir, 'admin-data/auth-state.json'), 'utf8')).account;
      const command = [path.join(privateDir, 'app/add-admin.php'), privateDir, 'ira@example.test'];
      const created = spawnSync(phpBinary, command, { encoding: 'utf8' });
      assert.equal(created.status, 0, created.stderr);
      assert.deepEqual(JSON.parse(await readFile(path.join(privateDir, 'admin-data/auth-state.json'), 'utf8')).account, before);
      const accessFile = (await readdir(privateDir)).find((name) => /^admin-access-[a-f0-9]+\.txt$/.test(name));
      const firstPassword = (await readFile(path.join(privateDir, accessFile), 'utf8')).match(/Временный пароль: (.+)/)[1];
      assert.ok(!created.stdout.includes(firstPassword));
      assert.notEqual(spawnSync(phpBinary, command, { encoding: 'utf8' }).status, 0);
      const login = await request('/api/admin/login', { method: 'POST', body: { username: 'ira@example.test', password: firstPassword } });
      assert.equal(login.status, 202); assert.equal(login.json.passwordChangeRequired, true);
      assert.equal(login.response.headers.get('Set-Cookie'), null);
      const change=await request('/api/admin/password-reset/complete',{method:'POST',body:{passwordToken:login.json.passwordToken,password:'different-new-fixture-password'}});
      assert.equal(change.status,200,change.text);assert.equal(change.response.headers.get('Set-Cookie'),null);
      const done = await request('/api/admin/login', { method: 'POST', body: { username:'ira@example.test',password:'different-new-fixture-password' } });
      assert.equal(done.status, 200, done.text);
      assert.equal(done.json.deviceToken, undefined); assert.equal(done.json.token, undefined);
      const deviceHeader = done.response.headers.getSetCookie().find((value) => value.startsWith('vosem_admin_device='));
      assert.match(deviceHeader, /HttpOnly/i); assert.match(deviceHeader, /SameSite=Strict/i); assert.match(deviceHeader, /path=\/api\/admin/i); assert.match(deviceHeader, /deleted/i);
      const deviceCookie = deviceHeader.split(';')[0];
      const known = await request('/api/admin/session', { headers: { Cookie: deviceCookie } });
      assert.equal(known.json.authenticated, false); assert.equal(known.json.trustedUsername, undefined);
      assert.equal((await request('/api/admin/menu', { headers: { Cookie: deviceCookie } })).status, 401);
      assert.equal((await request('/api/admin/resume', { method: 'POST', headers: { Cookie: deviceCookie, Origin: 'https://attacker.example' } })).status, 403);
      assert.equal((await request('/api/admin/resume', { method: 'POST', headers: { Cookie: deviceCookie }, body: {} })).status,404);
      const unlockedCookies = done.response.headers.getSetCookie().find((value) => value.startsWith('vosem_admin=')).split(';')[0];
      const out = await request('/api/admin/logout', { method: 'POST', headers: { Cookie: unlockedCookies, 'X-CSRF-Token': done.json.csrfToken }, body: {} });
      assert.equal(out.status, 200); assert.equal(out.json.trustedUsername, undefined);
      assert.doesNotMatch(out.response.headers.get('Set-Cookie'), /vosem_admin_device=/);
      assert.equal((await request('/api/admin/menu', { headers: { Cookie: unlockedCookies } })).status, 401);
      // Locked clients can explicitly forget the browser even without a live session.
      const forgotten = await request('/api/admin/logout', { method: 'POST', headers: { Cookie: deviceCookie }, body: { forgetDevice: true } });
      assert.equal(forgotten.status, 200); assert.equal(forgotten.json.trustedUsername, undefined);
      assert.match(forgotten.response.headers.get('Set-Cookie'), /vosem_admin_device=deleted/);
      assert.equal((await request('/api/admin/resume', { method: 'POST', headers: { Cookie: deviceCookie } })).status, 404);
    });
  } finally {
    await stop();
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir())); assert.ok(path.basename(temp).startsWith('vosem-php-http-'));
    await rm(temp, { recursive: true, force: true });
  }
});
