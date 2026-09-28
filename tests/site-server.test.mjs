import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createSiteServer } from '../server/index.mjs';
import { SITE_URL, transformPage } from '../server/seo.mjs';

const seedItems = [
  { id: 'toast', name: 'Тост из актуального меню', description: 'Яйцо, хлеб и зелень', price: 450, category: 'eggs', image: '/menu-images/toast.webp', order: 0, published: true },
  { id: 'draft', name: 'Скрытый черновик', description: '', price: 300, category: 'porridge', image: '', order: 1, published: false },
];
const template = `<!doctype html><html lang="ru"><head>
  <meta charset="utf-8"><title>Исходный заголовок</title><meta name="robots" content="noindex, nofollow">
  <script nonce="old-build-nonce">window.siteReady = true;</script>
  <script type="module" src="/app.js"></script>
  <script nonce='another-old-nonce'>window.otherReady = true;</script>
</head><body><h1>Восемь утра</h1>
  <section data-breakfast-menu><div data-menu-filters hidden><button data-menu-filter="all">Все</button><span data-menu-count></span></div>
  <div data-dish-grid></div><div data-extra-section hidden><div data-dish-extras></div></div>
  <p data-menu-empty hidden>Пока нет блюд.</p></section></body></html>`;

async function fixture(t, { production = true, manifest, omitManifest = false, publicOrigin = SITE_URL.slice(0, -1), start = true } = {}) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'vosem-site-'));
  const distRoot = path.join(projectRoot, production ? 'dist-hosting' : 'dist');
  const dataDir = path.join(projectRoot, '.data');
  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    assert.ok(path.resolve(projectRoot).startsWith(path.join(path.resolve(os.tmpdir()), 'vosem-site-')), 'Cleanup stays inside this test fixture');
    await rm(projectRoot, { recursive: true, force: true });
  });
  for (const directory of [distRoot, dataDir, path.join(projectRoot, 'public/data'), path.join(distRoot, 'server'), path.join(distRoot, 'node_modules'), path.join(distRoot, '.data')]) {
    await mkdir(directory, { recursive: true });
  }
  if (!omitManifest) await writeFile(path.join(distRoot, 'site-build.json'), JSON.stringify(manifest ?? { production, siteUrl: SITE_URL }));
  await writeFile(path.join(projectRoot, 'public/data/menu.json'), JSON.stringify({ items: seedItems }));
  // Model real deployment: the server receives already rendered build output.
  const built = transformPage(template, { production, items: [{ ...seedItems[0], name: 'Устаревший снимок сборки' }] });
  await writeFile(path.join(distRoot, 'index.html'), built);
  for (const page of ['admin', 'registration', 'privacy', 'consent']) await writeFile(path.join(distRoot, `${page}.html`), `<html><head><title>${page}</title></head><body>${page}</body></html>`);
  await writeFile(path.join(distRoot, 'app.js'), 'window.testAsset = true;');
  await writeFile(path.join(projectRoot, 'private.txt'), 'PRIVATE-OUTSIDE-DIST');
  for (const filename of ['server/private.json', 'node_modules/package.json', '.data/menu.json']) await writeFile(path.join(distRoot, filename), '{"private":"MUST-NOT-BE-SERVED"}');
  const options = {
    projectRoot, distRoot, dataDir, production, publicOrigin,
    password: '', encryptionKey: '', googleVerification: '', yandexVerification: '',
  };
  async function launch() {
    server = await createSiteServer(options);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  }
  if (start) await launch();
  const request = (route = '/', { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: route, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTP test request timed out')));
    req.on('error', reject);
    req.end();
  });
  return { options, projectRoot, distRoot, dataDir, request, launch };
}

function schema(html) {
  const match = html.match(/<script\b(?=[^>]*\bid="cafe-structured-data")[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match, 'JSON-LD is in the original HTTP response');
  return JSON.parse(match[1]);
}

test('production serves indexable live HTML while unconfigured MFA keeps admin access closed', async (t) => {
  const app = await fixture(t);
  const page = await app.request();
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-robots-tag'], undefined);
  assert.match(page.body, /content="index, follow, max-image-preview:large"/);
  assert.match(page.body, /rel="canonical" href="https:\/\/vosem-utra\.ru\/"/);
  assert.match(page.body, /Тост из актуального меню/);
  assert.doesNotMatch(page.body, /Устаревший снимок сборки|Скрытый черновик/);
  assert.equal(schema(page.body).hasMenu.hasMenuSection[0].hasMenuItem[0].offers.price, 450);
  const api = await app.request('/api/menu');
  assert.equal(api.status, 200);
  assert.deepEqual(JSON.parse(api.body).items.map((item) => item.id), ['toast']);
  const session = await app.request('/api/admin/session');
  assert.equal(session.status, 200);
  const status = JSON.parse(session.body);
  assert.equal(status.authenticated, false);
  assert.equal(status.configured, false);
  assert.equal(status.ready, false);
  assert.equal(status.mfaRequired, true);
  assert.equal((await app.request('/api/admin/menu')).status, 401);
});

test('production and preview serve matching robots, sitemap and utility-page index restrictions', async (t) => {
  for (const production of [true, false]) {
    await t.test(production ? 'production' : 'preview', async (child) => {
      const app = await fixture(child, { production });
      const home = await app.request();
      const robots = await app.request('/robots.txt');
      const sitemap = await app.request('/sitemap.xml');
      assert.equal(robots.status, 200);
      assert.equal(sitemap.status, 200);
      assert.match(sitemap.headers['content-type'], /application\/xml/);
      assert.doesNotMatch(robots.body, /^Disallow:\s*\/\s*$/m);
      if (production) {
        assert.match(robots.body, /Sitemap: https:\/\/vosem-utra\.ru\/sitemap\.xml/);
        assert.deepEqual([...sitemap.body.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]), [SITE_URL]);
      } else {
        assert.match(home.headers['x-robots-tag'], /noindex/);
        assert.match(home.body, /name="robots" content="noindex, nofollow"/);
        assert.doesNotMatch(home.body, /rel="canonical"|application\/ld\+json/);
        assert.doesNotMatch(robots.body, /Sitemap:/);
        assert.doesNotMatch(sitemap.body, /<loc>/);
      }
      for (const page of ['admin', 'registration', 'privacy', 'consent']) {
        const result = await app.request(`/${page}.html`);
        assert.equal(result.status, 200, page);
        assert.match(result.headers['x-robots-tag'], /noindex/);
        assert.match(result.body, /name="robots" content="noindex,/);
        assert.doesNotMatch(result.body, /rel="canonical"/);
      }
    });
  }
});

test('persisted edits and hiding update the first HTML and JSON-LD without rebuilding', async (t) => {
  const app = await fixture(t);
  const buildBefore = await readFile(path.join(app.distRoot, 'index.html'), 'utf8');
  const updated = { ...seedItems[0], name: 'Новый тост', description: 'Новый состав', price: 650.5 };
  await writeFile(path.join(app.dataDir, 'menu.json'), JSON.stringify({ revision: 2, items: [updated, seedItems[1]] }));
  const page = await app.request();
  assert.equal(page.status, 200);
  assert.match(page.body, /Новый тост/);
  assert.match(page.body, /650,5(?:\u00a0| )₽/);
  assert.doesNotMatch(page.body, /Тост из актуального меню|Устаревший снимок сборки|Скрытый черновик/);
  assert.equal(schema(page.body).hasMenu.hasMenuSection[0].hasMenuItem[0].offers.price, 650.5);
  await writeFile(path.join(app.dataDir, 'menu.json'), JSON.stringify({ revision: 3, items: [{ ...updated, published: false }] }));
  const hidden = await app.request();
  assert.equal(hidden.status, 200);
  assert.doesNotMatch(hidden.body, /Новый тост|Тост из актуального меню|Устаревший снимок сборки/);
  assert.deepEqual(schema(hidden.body).hasMenu.hasMenuSection, []);
  assert.equal((hidden.body.match(/class="dish-card/g) || []).length, 0);
  assert.equal(await readFile(path.join(app.distRoot, 'index.html'), 'utf8'), buildBefore, 'Request rendering never rewrites the built file');
});

test('every response gets security headers and each HTML response gets a fresh script nonce', async (t) => {
  const app = await fixture(t);
  const first = await app.request();
  const second = await app.request();
  const nonceFor = (page) => {
    const policy = page.headers['content-security-policy'];
    assert.match(policy, /default-src 'self'/);
    assert.match(policy, /object-src 'none'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.match(policy, /form-action 'self'/);
    const nonce = policy.match(/script-src 'self' 'nonce-([A-Za-z0-9+/=]+)'/)[1];
    assert.ok(Buffer.from(nonce, 'base64').length >= 24);
    const scripts = [...page.body.matchAll(/<script\b([^>]*)>/g)];
    assert.equal(scripts.length, 4, 'Three template scripts plus generated JSON-LD');
    for (const [, attributes] of scripts) {
      assert.equal((attributes.match(/\bnonce=/g) || []).length, 1);
      assert.ok(attributes.includes(`nonce="${nonce}"`));
    }
    assert.doesNotMatch(page.body, /old-build-nonce|another-old-nonce/);
    return nonce;
  };
  assert.notEqual(nonceFor(first), nonceFor(second));
  for (const result of [first, await app.request('/app.js'), await app.request('/does-not-exist.html'), await app.request('/api/menu')]) {
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    assert.equal(result.headers['x-frame-options'], 'DENY');
    assert.equal(result.headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.equal(result.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(result.headers['strict-transport-security'], 'max-age=31536000');
    assert.match(result.headers['permissions-policy'], /camera=\(\).*microphone=\(\).*geolocation=\(\)/);
  }
  assert.match((await app.request('/app.js')).headers['cache-control'], /public/);
  const local = await fixture(t, { production: false, publicOrigin: '' });
  assert.equal((await local.request()).headers['strict-transport-security'], undefined);
});

test('private paths, encoded traversal and build manifest cannot be downloaded', async (t) => {
  const app = await fixture(t);
  const routes = [
    '/site-build.json', '/site-build%2ejson', '/Site-Build.json', '/.data/menu.json', '/%2edata/menu.json',
    '/server/private.json', '/SERVER/private.json', '/node_modules/package.json', '/.git/config', '/.env',
    '/%2e%2e/private.txt', '/assets/%2e%2e/%2e%2e/private.txt', '/%2e%2e%5cprivate.txt',
    `/@fs/${app.projectRoot.replaceAll('\\', '/')}/.data/menu.json`,
  ];
  for (const route of routes) {
    const result = await app.request(route);
    assert.equal(result.status, 404, route);
    assert.doesNotMatch(result.body, /MUST-NOT-BE-SERVED|PRIVATE-OUTSIDE-DIST|"siteUrl"/);
  }
  const missing = await app.request('/missing.html');
  assert.equal(missing.status, 404);
  assert.match(missing.headers['x-robots-tag'], /noindex/);
});

test('canonical redirects retain query strings and HEAD returns headers without a body', async (t) => {
  const app = await fixture(t);
  for (const [route, destination] of [['/index.html?from=test', '/?from=test'], ['/admin', '/admin.html'], ['/admin/?from=test', '/admin.html?from=test']]) {
    const result = await app.request(route);
    assert.equal(result.status, 308);
    assert.equal(result.headers.location, destination);
  }
  for (const route of ['/', '/admin.html', '/app.js', '/robots.txt', '/sitemap.xml']) {
    const get = await app.request(route);
    const head = await app.request(route, { method: 'HEAD' });
    assert.equal(head.status, get.status, route);
    assert.equal(head.body, '', route);
    assert.equal(head.headers['content-type'], get.headers['content-type']);
    assert.equal(Number(head.headers['content-length']), Buffer.byteLength(get.body));
  }
  const unsupported = await app.request('/app.js', { method: 'POST' });
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.allow, 'GET, HEAD');
});

test('startup rejects missing, broken, or mismatched build manifests', async (t) => {
  const missing = await fixture(t, { start: false, omitManifest: true });
  await assert.rejects(createSiteServer(missing.options), { code: 'ENOENT' });
  const wrongMode = await fixture(t, { start: false, production: true, manifest: { production: false, siteUrl: SITE_URL } });
  await assert.rejects(createSiteServer(wrongMode.options), /Неверный режим сборки/);
  const wrongSite = await fixture(t, { start: false, manifest: { production: true, siteUrl: 'https://other.example/' } });
  await assert.rejects(createSiteServer(wrongSite.options), /Неверный режим сборки/);
  const malformed = await fixture(t, { start: false });
  await writeFile(path.join(malformed.distRoot, 'site-build.json'), '{broken');
  await assert.rejects(createSiteServer(malformed.options), SyntaxError);
});

test('corrupt persisted menu yields 503 and never substitutes a stale seed or build snapshot', async (t) => {
  const app = await fixture(t);
  for (const value of ['{broken', JSON.stringify({ revision: 0, items: seedItems }), JSON.stringify({ revision: 1, items: [{ ...seedItems[0], price: -1 }] })]) {
    await writeFile(path.join(app.dataDir, 'menu.json'), value);
    const result = await app.request();
    assert.equal(result.status, 503);
    assert.match(result.headers['x-robots-tag'], /noindex/);
    assert.doesNotMatch(result.body, /Тост из актуального меню|Устаревший снимок сборки|application\/ld\+json/);
    assert.equal(result.headers['cache-control'], 'no-store');
  }
  await writeFile(path.join(app.dataDir, 'menu.json'), JSON.stringify({ revision: 2, items: seedItems }));
  const recovered = await app.request();
  assert.equal(recovered.status, 200);
  assert.match(recovered.body, /Тост из актуального меню/);
});
