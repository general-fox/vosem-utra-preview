import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SITE_URL, SOCIAL_IMAGE, SEO_TITLE, transformPage, renderMenu, renderRobots, renderSitemap } from '../server/seo.mjs';

const home = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const seed = JSON.parse(await readFile(new URL('../public/data/menu.json', import.meta.url), 'utf8'));
const item = (patch = {}) => ({
  id: 'toast', name: 'Тост с яйцом', description: 'Яйцо, хлеб и зелень', price: 450,
  category: 'eggs', image: '/menu-images/toast.webp', order: 0, published: true, ...patch,
});
const schema = (html) => JSON.parse(html.match(/<script type="application\/ld\+json" id="cafe-structured-data">([\s\S]*?)<\/script>/)[1]);
const slot = (html, name) => html.match(new RegExp(`<!-- SEO:${name}:START -->([\\s\\S]*?)<!-- SEO:${name}:END -->`))[1];
const renderedNames = (html) => [...slot(html, 'DISH-GRID').matchAll(/<h3>([\s\S]*?)<\/h3>/g)].map((match) => match[1]);

test('preview stays noindex while rendering real breakfast cards without JavaScript', () => {
  const html = transformPage(home, { items: seed.items });
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.doesNotMatch(html, /rel="canonical"|property="og:|application\/ld\+json|site-verification|yandex-verification/);
  assert.ok(html.includes(`<title>${SEO_TITLE}</title>`));
  assert.equal((slot(html, 'DISH-GRID').match(/<article /g) || []).length, 13);
  assert.equal((slot(html, 'DISH-EXTRAS').match(/<article /g) || []).length, 6);
  assert.match(html, /Авокадо-тост с яйцом пашот и гуакамоле/);
  assert.match(html, /data-extra-section>/);
  assert.match(html, /data-menu-filter="all"/);
  assert.doesNotMatch(html, /Чтобы увидеть карточки блюд/);
});

test('only an explicitly selected production homepage can become indexable', async () => {
  for (const production of [false, undefined, 'true', 'hosting']) {
    const html = transformPage(home, { production, items: [] });
    assert.match(html, /name="robots" content="noindex, nofollow"/);
  }
  const html = transformPage(home, { production: true, page: '/index.html', items: [item()] });
  assert.match(html, /name="robots" content="index, follow, max-image-preview:large"/);
  assert.doesNotMatch(html, /noindex/);
  assert.match(html, /<link rel="canonical" href="https:\/\/vosem-utra\.ru\/">/);
  assert.match(html, /property="og:url" content="https:\/\/vosem-utra\.ru\/"/);
  assert.ok(html.includes(`property="og:image" content="${SOCIAL_IMAGE}"`));
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  for (const page of ['admin', 'registration', 'privacy', 'consent']) {
    const original = await readFile(new URL(`../${page}.html`, import.meta.url), 'utf8');
    const transformed = transformPage(original, { page, production: true });
    assert.match(transformed, /name="robots" content="noindex,/);
    assert.doesNotMatch(transformed, /rel="canonical"|application\/ld\+json/);
    assert.equal((transformed.match(/<title>/g) || []).length, 1);
  }
});

test('JSON-LD uses only established cafe facts and the visible published menu', () => {
  const data = schema(transformPage(home, { production: true, items: [item(), item({ id: 'draft', name: 'Секретный черновик', published: false })] }));
  assert.equal(data['@type'], 'CafeOrCoffeeShop');
  assert.equal(data.name, 'Восемь утра');
  assert.equal(data.url, SITE_URL);
  assert.equal(data.telephone, '+79851308106');
  assert.deepEqual(data.address, {
    '@type': 'PostalAddress', streetAddress: 'Шелепихинская набережная, 34, корпус 6',
    addressLocality: 'Москва', addressCountry: 'RU',
  });
  assert.equal(data.openingHoursSpecification[0].dayOfWeek.length, 7);
  assert.equal(data.openingHoursSpecification[0].opens, '08:00');
  assert.equal(data.openingHoursSpecification[0].closes, '20:00');
  assert.equal(data.menu, `${SITE_URL}#menu`);
  assert.deepEqual(data.sameAs, ['https://yandex.ru/maps/org/vosem_utra/133294557510/', 'https://t.me/vosemutracafe']);
  assert.equal(data.hasMenu.hasMenuSection[0].hasMenuItem[0].offers.price, 450);
  assert.doesNotMatch(JSON.stringify(data), /Секретный черновик|aggregateRating|reviewCount|geo|priceRange|servesCuisine/);
});

test('re-rendering built HTML replaces old cards, counts and schema with the live menu', () => {
  const initial = transformPage(home, { production: true, items: [item({ name: 'Старый завтрак' }), item({ id: 'porridge', name: 'Каша', image: '' })] });
  const live = transformPage(initial, { production: true, items: [item({ name: 'Новый завтрак', price: 650.5 })] });
  assert.doesNotMatch(live, /Старый завтрак|>Каша<|"name":"Каша"/);
  assert.deepEqual(renderedNames(live), ['Новый завтрак']);
  assert.match(live, /650,5(?:\u00a0| )₽/);
  assert.match(live, /data-extra-section hidden>/);
  assert.match(live, /data-menu-count[^>]*>1 блюдо<\/span>/);
  assert.equal((live.match(/id="cafe-structured-data"/g) || []).length, 1);
  assert.equal((live.match(/rel="canonical"/g) || []).length, 1);
  assert.equal((live.match(/SEO:DISH-GRID:START/g) || []).length, 1);
  assert.equal(transformPage(live, { production: true, items: [item({ name: 'Новый завтрак', price: 650.5 })] }), live);
  const empty = transformPage(live, { production: true, items: [] });
  assert.equal(slot(empty, 'DISH-GRID').trim(), '');
  assert.match(empty, /data-menu-empty>/);
  assert.equal(schema(empty).hasMenu.hasMenuSection.length, 0);
});

test('HTML, JSON-LD and verification values cannot break out into executable markup', () => {
  const attack = '</script><script>alert("x")</script><img src=x onerror="alert(1)">& $& $` $\'';
  const html = transformPage(home, {
    production: true,
    items: [item({ name: attack, description: attack, image: 'javascript:alert(1)' })],
    googleVerification: '"><script>alert(2)</script>', yandexVerification: '" onload="alert(3)',
  });
  assert.doesNotMatch(html, /<script>alert\(|src="javascript:|content="" onload=/);
  assert.match(slot(html, 'DISH-EXTRAS'), /&lt;\/script&gt;&lt;script&gt;alert\(&quot;x&quot;\)/);
  assert.equal(schema(html).hasMenu.hasMenuSection[0].hasMenuItem[0].name, attack);
  assert.match(html, /name="google-site-verification" content="&quot;&gt;&lt;script&gt;/);
  assert.match(html, /name="yandex-verification" content="&quot; onload=&quot;alert\(3\)"/);
  for (const options of [{ production: false }, { production: true }]) {
    const withoutTokens = transformPage(home, { ...options, items: [] });
    assert.doesNotMatch(withoutTokens, /google-site-verification|yandex-verification/);
  }
  assert.doesNotMatch(transformPage(home, { production: false, googleVerification: 'actual-token' }), /actual-token/);
});

test('rendered menu hides drafts and rejects unsafe images or invalid prices', () => {
  const result = renderMenu([
    item({ id: 'safe', name: 'Опубликовано' }),
    item({ id: 'draft', name: 'Не показывать', published: false }),
    item({ id: 'nan', name: 'Плохая цена', price: NaN }),
    item({ id: 'external', name: 'Без внешнего фото', image: 'https://other.example/tracker.webp' }),
    item({ id: 'traversal', name: 'Без обхода пути', image: '/uploads/../private.webp' }),
  ]);
  assert.equal(result.count, 3);
  assert.doesNotMatch(result.grid + result.extras, /Не показывать|Плохая цена|https:\/\/other|\.\.\//);
  assert.match(result.grid, /src="menu-images\/toast.webp"/);
  assert.match(result.extras, /Без внешнего фото/);
});

test('robots allows crawlers to see noindex and sitemap lists only the canonical production homepage', async () => {
  for (const text of [renderRobots(), await readFile(new URL('../robots.txt', import.meta.url), 'utf8'), await readFile(new URL('../public/robots.txt', import.meta.url), 'utf8')]) {
    assert.doesNotMatch(text, /^Disallow:\s*\/\s*$/m);
    assert.doesNotMatch(text, /^Sitemap:/m);
    assert.doesNotMatch(text, /^Noindex:/im);
  }
  assert.match(renderRobots({ production: true }), /^Sitemap: https:\/\/vosem-utra\.ru\/sitemap\.xml$/m);
  assert.doesNotMatch(renderRobots({ production: true }), /Disallow: \/(?:admin|registration|privacy|consent)/);
  assert.equal((renderSitemap({ production: true }).match(/<loc>/g) || []).length, 1);
  assert.match(renderSitemap({ production: true }), /<loc>https:\/\/vosem-utra\.ru\/<\/loc>/);
  assert.doesNotMatch(renderSitemap(), /<loc>|https:\/\/vosem-utra/);
});

test('social cover is the existing photograph with a stable public URL', async () => {
  const cover = await readFile(new URL('../public/social-cover.webp', import.meta.url));
  const source = await readFile(new URL('../assets/hero-two-cups-1254.webp', import.meta.url));
  assert.deepEqual(cover, source);
  assert.equal(cover.toString('ascii', 8, 12), 'WEBP');
  assert.ok(cover.length < 450 * 1024);
});
