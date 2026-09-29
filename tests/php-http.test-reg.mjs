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
import { totp } from '../server/totp.mjs';
import { encryptTotp } from '../server/auth.mjs';
import { createHash } from 'node:crypto';
import { phpEnvironment } from '../scripts/php-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('REG.RU stable assets are complete without archived images or font source files', async () => {
  const site = path.join(root, 'dist-reg/site');
  const names = await readdir(path.join(site, 'assets'));
  for (const name of ['logo.svg', 'favicon.svg', 'cookie-sun.svg', 'Lato-Regular.woff2',
    'Lato-Medium.woff2', 'Lato-Italic.woff2', 'Lato-OFL.txt', 'Lato-WOFF2.txt']) {
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
  assert.equal(version, '2026-09-29-reg4');
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
      const menu = await request('/api/menu'); assert.equal(menu.status, 200); assert.equal(menu.json.items.length, 19);
      for (const item of menu.json.items.filter((item) => item.image)) assert.equal((await request(item.image)).status, 200);
    });
    let enrollment; let recovery;
    await t.test('password alone cannot edit; real TOTP completes protected enrollment', async () => {
      assert.equal((await request('/api/admin/menu')).status, 401);
      assert.equal((await request('/api/admin/enroll/start', { method: 'POST', body: { username: 'v.utra@yandex.ru', challengeToken: 'fake' } })).status, 410);
      assert.equal((await request('/api/admin/login', { method: 'POST', body: { username: 'v.utra@yandex.ru', password }, headers: { Origin: 'https://attacker.example' } })).status, 403);
      const login = await request('/api/admin/login', { method: 'POST', body: { username: 'v.utra@yandex.ru', password } });
      assert.equal(login.status, 202, login.text); assert.equal(login.json.enrollmentRequired, true); assert.equal(login.response.headers.get('Set-Cookie'), null);
      const begin = await request('/api/admin/enroll/start', { method: 'POST', body: { username: 'v.utra@yandex.ru', challengeToken: login.json.challengeToken } });
      assert.equal(begin.status, 200, begin.text); enrollment = begin.json;
      assert.match(enrollment.otpauthUri, /^otpauth:\/\/totp\//); assert.equal(begin.response.headers.get('Cache-Control'), 'no-store');
      assert.equal((await request('/api/admin/menu')).status, 401);
      const complete = await request('/api/admin/enroll/confirm', { method: 'POST', body: { enrollmentToken: enrollment.enrollmentToken, code: totp(enrollment.secret) } });
      assert.equal(complete.status, 200, complete.text); csrf = complete.json.csrfToken; recovery = complete.json.recoveryCodes;
      cookie = complete.response.headers.get('Set-Cookie').split(';')[0];
      assert.match(complete.response.headers.get('Set-Cookie'), /HttpOnly/i); assert.match(complete.response.headers.get('Set-Cookie'), /SameSite=Strict/i);
      assert.equal(recovery.length, 10);
      const state = await readFile(path.join(privateDir, 'admin-data/auth-state.json'), 'utf8');
      assert.ok(!state.includes(enrollment.secret)); assert.ok(!state.includes(cookie.split('=')[1])); assert.ok(!state.includes(recovery[0]));
    });
    let menu; let uploaded;
    await t.test('CSRF, revision conflicts, upload validation and escaped live menu', async () => {
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
      assert.ok(!home.text.includes(menu.items[1].name));
      assert.equal((await request('/data/menu.json')).json.items.length, 18);
    });
    await t.test('PHP restart preserves menu, sessions, MFA and one-use recovery codes', async () => {
      await stop(); await start();
      assert.equal((await request('/api/admin/session', { auth: true })).json.authenticated, true);
      assert.equal((await request('/api/admin/menu', { auth: true })).json.items[0].price, 777);
      assert.equal((await request(uploaded)).status, 200);
      assert.equal((await request('/api/admin/logout', { method: 'POST', auth: true, body: {} })).status, 403);
      assert.equal((await request('/api/admin/logout', { method: 'POST', auth: true, token: true, body: {} })).status, 200);
      assert.equal((await request('/api/admin/menu', { auth: true })).status, 401);
      const login = await request('/api/admin/login', { method: 'POST', body: { username: 'v.utra@yandex.ru', password } }); assert.equal(login.status, 202); assert.equal(login.json.mfaRequired, true);
      const verify = await request('/api/admin/verify', { method: 'POST', body: { challengeToken: login.json.challengeToken, code: recovery[0] } }); assert.equal(verify.status, 200);
      const again = await request('/api/admin/login', { method: 'POST', body: { username: 'v.utra@yandex.ru', password } });
      assert.equal((await request('/api/admin/verify', { method: 'POST', body: { challengeToken: again.json.challengeToken, code: recovery[0] } })).status, 401);
    });
    await t.test('offline employee add preserves owner; HTTP enrollment sets private device cookie and logout revokes it', async () => {
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
      assert.equal(login.status, 202); assert.equal(login.json.requiresNewPassword, true);
      assert.equal(login.response.headers.get('Set-Cookie'), null);
      const begin = await request('/api/admin/enroll/start', { method: 'POST', body: { challengeToken: login.json.challengeToken, username: 'ira@example.test', password: 'different-new-fixture-password' } });
      assert.equal(begin.status, 200, begin.text);
      const done = await request('/api/admin/enroll/confirm', { method: 'POST', body: { enrollmentToken: begin.json.enrollmentToken, code: totp(begin.json.secret) } });
      assert.equal(done.status, 200, done.text);
      assert.equal(done.json.deviceToken, undefined); assert.equal(done.json.token, undefined);
      const deviceHeader = done.response.headers.getSetCookie().find((value) => value.startsWith('vosem_admin_device='));
      assert.match(deviceHeader, /HttpOnly/i); assert.match(deviceHeader, /SameSite=Strict/i); assert.match(deviceHeader, /path=\/api\/admin/i); assert.match(deviceHeader, /Max-Age=25920\d\d/i);
      const deviceCookie = deviceHeader.split(';')[0];
      const known = await request('/api/admin/session', { headers: { Cookie: deviceCookie } });
      assert.equal(known.json.authenticated, false); assert.equal(known.json.trustedUsername, 'ira@example.test');
      assert.equal((await request('/api/admin/menu', { headers: { Cookie: deviceCookie } })).status, 401);
      assert.equal((await request('/api/admin/resume', { method: 'POST', headers: { Cookie: deviceCookie, Origin: 'https://attacker.example' } })).status, 403);
      const challenge = await request('/api/admin/resume', { method: 'POST', headers: { Cookie: deviceCookie }, body: {} });
      assert.equal(challenge.status, 202);
      const unlocked = await request('/api/admin/verify', { method: 'POST', headers: { Cookie: deviceCookie }, body: { challengeToken: challenge.json.challengeToken, code: totp(begin.json.secret, { time: Date.now() + 30000 }) } });
      assert.equal(unlocked.status, 200, unlocked.text);
      const rotated = unlocked.response.headers.getSetCookie().find((value) => value.startsWith('vosem_admin_device=')).split(';')[0];
      assert.notEqual(rotated, deviceCookie);
      assert.equal(unlocked.json.deviceToken, undefined);
      assert.equal((await request('/api/admin/resume', { method: 'POST', headers: { Cookie: deviceCookie } })).status, 401);
      // With only the device cookie (no active session), logout must still forget it.
      const out = await request('/api/admin/logout', { method: 'POST', headers: { Cookie: rotated }, body: {} });
      assert.equal(out.status, 200); assert.match(out.response.headers.get('Set-Cookie'), /vosem_admin_device=deleted/);
      assert.equal((await request('/api/admin/resume', { method: 'POST', headers: { Cookie: rotated } })).status, 401);
    });
  } finally {
    await stop();
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir())); assert.ok(path.basename(temp).startsWith('vosem-php-http-'));
    await rm(temp, { recursive: true, force: true });
  }
});
