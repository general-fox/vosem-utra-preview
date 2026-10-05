import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as menuCategories from '../menu-categories.js';

const script = readFileSync(new URL('../menu.js', import.meta.url), 'utf8').replace(/^import .*?;\r?\n/, '');

// Execute the complete browser entry point. This small DOM implements only native
// element/event operations; menu filtering, URLs and rendering remain real code.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.dataset = {};
    this.children = [];
    this.hidden = false;
    this.attributes = new Map();
    this.listeners = new Map();
    this.text = '';
  }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once: options.once });
    this.listeners.set(type, listeners);
  }
  async dispatch(type) {
    const listeners = [...(this.listeners.get(type) ?? [])];
    this.listeners.set(type, listeners.filter((entry) => !entry.once));
    await Promise.all(listeners.map(({ listener }) => listener({ target: this })));
  }
}

function descendants(element, predicate) {
  return element.children.flatMap((child) => [
    ...(predicate(child) ? [child] : []), ...descendants(child, predicate),
  ]);
}
const byClass = (element, name) => descendants(element, (child) => child.className.split(/\s+/).includes(name));
const byTag = (element, name) => descendants(element, (child) => child.tagName === name.toUpperCase());
const normalizedText = (element) => element.textContent.replace(/\s+/g, ' ').trim();

function response(status, body, contentType = 'application/json') {
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null },
    json: async () => structuredClone(body),
  };
}

const dish = (patch = {}) => ({
  id: 'eggs', name: 'Тост с яйцом', description: 'Яйцо, хлеб и зелень',
  price: 450, image: '/menu-images/eggs.webp', category: 'eggs',
  order: 1, published: true, ...patch,
});

async function browser(replies, href = 'https://cafe.example/index.html') {
  const root = new Element('section');
  const parts = Object.fromEntries([
    'dish-grid', 'dish-extras', 'extra-section', 'menu-empty', 'menu-count', 'menu-roots', 'menu-subcategories',
    'menu-breadcrumbs', 'menu-category-title', 'menu-test-notice',
    'menu-status', 'menu-retry', 'menu-filters',
  ].map((name) => [name, new Element()]));
  for (const name of ['menu-empty', 'menu-retry', 'menu-filters', 'menu-breadcrumbs', 'menu-subcategories', 'menu-test-notice']) parts[name].hidden = true;
  const filters = () => [...parts['menu-roots'].children, ...parts['menu-subcategories'].children];
  root.querySelector = (selector) => {
    const name = selector.match(/^\[data-(.+)\]$/)?.[1];
    assert.ok(parts[name], `Unexpected DOM query: ${selector}`);
    return parts[name];
  };
  root.querySelectorAll = (selector) => {
    assert.equal(selector, '[data-menu-filter]');
    return filters();
  };
  const window = new Element();
  const requests = [];
  const document = {
    querySelector: (selector) => selector === '[data-breakfast-menu]' ? root : null,
    createElement: (tag) => new Element(tag),
  };
  const context = vm.createContext({
    document, window, location: new URL(href), URL, Intl, AbortSignal, ...menuCategories,
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      const reply = replies.shift();
      if (!reply) throw new Error(`Unexpected request: ${url}`);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  vm.runInContext(script, context, { filename: 'menu.js' });
  // Initial load is started by the entry point. Wait for its public busy state,
  // avoiding access to internal functions or a fixed browser/network delay.
  for (let i = 0; i < 100 && root.getAttribute('aria-busy') === 'true'; i++) await Promise.resolve();
  assert.equal(root.getAttribute('aria-busy'), 'false', 'Initial menu request settles');
  const cards = () => [...parts['dish-grid'].children, ...parts['dish-extras'].children];
  return {
    root, parts, get filters() { return filters(); }, requests, window, cards,
    names: () => cards().flatMap((card) => byTag(card, 'h3').map((heading) => heading.textContent)),
    filter: async (name) => {
      const button = filters().find((entry) => entry.dataset.menuFilter === name);
      assert.ok(button);
      await button.dispatch('click');
    },
  };
}

test('static dist fallback keeps menu and photo requests inside a hosted subdirectory', async () => {
  const app = await browser([
    response(404),
    response(200, { items: [dish(), dish({ id: 'draft', name: 'Черновик', published: false })] }),
  ], 'https://general-fox.github.io/vosem-utra-preview/index.html#menu');
  assert.deepEqual(app.requests.map(({ url }) => url), [
    'https://general-fox.github.io/vosem-utra-preview/api/menu',
    'https://general-fox.github.io/vosem-utra-preview/data/menu.json',
  ]);
  assert.deepEqual(app.names(), ['Тост с яйцом']);
  assert.equal(byTag(app.cards()[0], 'img')[0].src,
    'https://general-fox.github.io/vosem-utra-preview/menu-images/eggs.webp');
  assert.equal(app.parts['menu-retry'].hidden, true);
  assert.equal(app.parts['menu-filters'].hidden, false);
});

test('source-folder fallback also resolves photos under public within the site subdirectory', async () => {
  const app = await browser([
    response(200, undefined, 'text/html; charset=utf-8'),
    response(404),
    response(200, { items: [dish()] }),
  ], 'https://general-fox.github.io/vosem-utra-preview/');
  assert.equal(app.requests.length, 3);
  assert.equal(app.requests[2].url, 'https://general-fox.github.io/vosem-utra-preview/public/data/menu.json');
  assert.equal(byTag(app.cards()[0], 'img')[0].src,
    'https://general-fox.github.io/vosem-utra-preview/public/menu-images/eggs.webp');
});

test('server failures never load the stale static menu; retry recovers from the live API', async () => {
  const app = await browser([
    response(500, { error: 'Unavailable' }),
    response(200, { items: [dish({ name: 'Обновлённый завтрак', image: '/uploads/new-photo.webp' })] }),
  ]);
  assert.deepEqual(app.requests.map(({ url }) => url), ['https://cafe.example/api/menu']);
  assert.equal(app.cards().length, 0);
  assert.equal(app.parts['menu-retry'].hidden, false);
  assert.match(app.parts['menu-status'].textContent, /Не удалось загрузить меню/);
  await app.parts['menu-retry'].dispatch('click');
  assert.deepEqual(app.requests.map(({ url }) => url), [
    'https://cafe.example/api/menu', 'https://cafe.example/api/menu',
  ]);
  assert.deepEqual(app.names(), ['Обновлённый завтрак']);
  assert.equal(byTag(app.cards()[0], 'img')[0].src, 'https://cafe.example/uploads/new-photo.webp');
  assert.equal(app.parts['menu-status'].textContent, '');
  assert.equal(app.parts['menu-retry'].hidden, true);
});

test('actual cards preserve fractional prices and treat menu text as plain content', async () => {
  const name = '<img src=x onerror=alert(1)> Завтрак';
  const description = '<script>alert(1)</script> — описание блюда';
  const app = await browser([response(200, { items: [
    dish({ name, description, price: 650.5 }),
    dish({ id: 'porridge', category: 'porridge', name: 'Каша', image: '', price: 300, order: 2 }),
  ] })]);
  const first = app.cards()[0];
  assert.equal(normalizedText(byClass(first, 'dish-price')[0]), '650,5 ₽');
  assert.equal(normalizedText(byClass(app.cards()[1], 'dish-price')[0]), '300 ₽');
  assert.equal(byTag(first, 'h3')[0].textContent, name);
  assert.equal(byClass(first, 'dish-description')[0].textContent, description);
  assert.equal(byTag(first, 'script').length, 0);
  assert.equal(byTag(first, 'img').length, 1, 'A name containing markup does not create another image');
});

test('groups show photo cards followed by a compact list and announce an empty dinner', async () => {
  const app = await browser([response(200, { items: [
    dish(),
    dish({ id: 'syrniki', name: 'Сырники', category: 'sweet', order: 3 }),
    dish({ id: 'porridge', name: 'Каша', category: 'porridge', image: '', order: 2 }),
    dish({ id: 'draft', name: 'Черновик', category: 'signature', published: false }),
  ] })]);
  assert.equal(app.cards().length, 3);
  assert.deepEqual(app.names(), ['Тост с яйцом', 'Сырники', 'Каша']);
  assert.equal(app.parts['dish-grid'].children.length, 2);
  assert.equal(app.parts['dish-extras'].children.length, 1);
  assert.equal(app.parts['extra-section'].hidden, false);
  assert.deepEqual(app.filters.map(button => button.dataset.menuFilter), ['breakfast', 'dinner']);
  assert.equal(app.parts['menu-subcategories'].hidden, true);
  assert.equal(app.parts['menu-breadcrumbs'].hidden, true);
  assert.equal(app.parts['menu-category-title'].textContent, 'Завтраки');
  assert.equal(app.parts['menu-count'].textContent, '3 блюда');
  assert.deepEqual(app.filters.filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.dataset.menuFilter), ['breakfast']);
  await app.filter('dinner');
  assert.equal(app.cards().length, 0);
  assert.equal(app.parts['extra-section'].hidden, true);
  assert.equal(app.parts['menu-empty'].hidden, false);
  assert.match(app.parts['menu-empty'].textContent, /Ужины скоро появятся/);
  assert.equal(app.parts['menu-category-title'].textContent, 'Ужины');
  assert.equal(app.parts['menu-count'].textContent, '0 блюд');
  await app.filter('breakfast');
  assert.equal(app.parts['menu-empty'].hidden, true);
  assert.equal(app.parts['dish-grid'].children.length, 2);
  assert.equal(app.parts['dish-extras'].children.length, 1);
  assert.equal(app.parts['extra-section'].hidden, false);
  assert.equal(app.parts['menu-count'].textContent, '3 блюда');
  assert.equal(app.requests.length, 1, 'Filtering the loaded menu requires no extra request');
});

test('photo edits move dishes between the cards and list without duplicates or empty gaps', async () => {
  const text = dish({ image: '' });
  const app = await browser([
    response(200, { items: [text] }),
    response(200, { items: [text] }),
    response(200, { items: [dish()] }),
    response(200, { items: [text] }),
    response(200, { items: [] }),
  ]);
  const row = app.parts['dish-extras'].children[0];
  assert.equal(app.parts['dish-grid'].children.length, 0);
  assert.equal(app.parts['extra-section'].hidden, false);
  assert.equal(app.parts['menu-empty'].hidden, true);
  assert.equal(app.parts['menu-count'].textContent, '1 блюдо');
  await app.window.dispatch('focus');
  assert.equal(app.parts['dish-extras'].children[0], row, 'Unchanged rows keep their live nodes');
  await app.window.dispatch('focus');
  assert.equal(app.parts['dish-grid'].children.length, 1);
  assert.equal(app.parts['dish-extras'].children.length, 0);
  assert.equal(app.parts['extra-section'].hidden, true);
  assert.deepEqual(app.names(), ['Тост с яйцом']);
  await app.window.dispatch('focus');
  assert.equal(app.parts['dish-grid'].children.length, 0);
  assert.equal(app.parts['dish-extras'].children.length, 1);
  assert.equal(app.parts['extra-section'].hidden, false);
  assert.deepEqual(app.names(), ['Тост с яйцом']);
  await app.window.dispatch('focus');
  assert.equal(app.cards().length, 0);
  assert.equal(app.parts['extra-section'].hidden, true);
  assert.equal(app.parts['menu-empty'].hidden, false);
});

test('returning to the page refreshes current items and keeps a deleted dish removed', async () => {
  const app = await browser([
    response(200, { items: [dish()] }),
    response(200, { items: [] }),
    response(500, { error: 'Unavailable' }),
  ]);
  assert.equal(app.cards().length, 1);
  await app.window.dispatch('focus');
  assert.equal(app.cards().length, 0);
  assert.equal(app.parts['menu-empty'].hidden, false);
  await app.window.dispatch('focus');
  assert.equal(app.cards().length, 0, 'An API failure does not resurrect deleted seed dishes');
  assert.equal(app.requests.length, 3);
  assert.ok(app.requests.every(({ url }) => url === 'https://cafe.example/api/menu'));
  assert.equal(app.parts['menu-retry'].hidden, false);
});

test('unchanged refresh and category round trip reuse cards without restarting reveal or quantity controls', async () => {
  const items = [dish(), dish({ id: 'sweet', category: 'sweet', order: 2 })];
  const app = await browser([response(200, { items }), response(200, { items })]);
  const card = app.cards()[0];
  assert.equal(card.dataset.reveal, 'visual');
  assert.equal(card.dataset.revealKey, 'dish:eggs');
  assert.equal(byClass(card, 'dish-cart-actions')[0].dataset.cartItem, 'eggs');
  card.dataset.revealState = 'shown';
  const breakfastButton = app.filters[0];
  await app.window.dispatch('focus');
  assert.equal(app.cards()[0], card);
  assert.equal(app.filters[0], breakfastButton, 'An unchanged refresh keeps the focused category button');
  await app.filter('dinner'); await app.filter('breakfast');
  assert.equal(app.cards()[0], card);
  assert.equal(card.dataset.revealState, 'shown');
});


test('live menu availability disables cart controls independently of publication for photo and text dishes', async () => {
  const app = await browser([response(200, { revision: 23, items: [
    dish({ id: 'legacy-photo' }),
    dish({ id: 'available-text', image: '', availableForOrder: true }),
    dish({ id: 'unavailable-photo', name: 'Тост & сыр', availableForOrder: false }),
    dish({ id: 'unavailable-text', image: '', availableForOrder: false }),
    dish({ id: 'test-only', availableForOrder: true, source: { provider: 'kds', organizationId: 'baa06e7a-b091-4296-97bc-275bc22d9af9', externalId: '100', testOnly: true } }),
    dish({ id: 'hidden-dish', published: false, availableForOrder: true }),
  ] })]);
  const buttons = app.cards().flatMap(card => byTag(card, 'button'));
  assert.equal(buttons.length, 5);
  for (const id of ['legacy-photo', 'available-text']) {
    const button = buttons.find(button => button.dataset.cartAdd === id);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'В корзину');
    assert.match(button.getAttribute('aria-label'), /^В корзину: /);
  }
  for (const id of ['unavailable-photo', 'unavailable-text', 'test-only']) {
    const button = buttons.find(button => button.dataset.cartAdd === id);
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, 'Временно недоступно');
    assert.match(button.getAttribute('aria-label'), /^Временно недоступно: /);
  }
  assert.equal(buttons.some(button => button.dataset.cartAdd === 'hidden-dish'), false);
  assert.equal(app.window.cafeMenuSnapshot.revision, 23);
  assert.equal(app.window.cafeMenuSnapshot.live, true);
  assert.equal(app.window.cafeMenuSnapshot.items.find(item => item.id === 'unavailable-photo').availableForOrder, false);
});

test('switching from the sticky navigation returns directly to the newly selected dishes', async () => {
  const app = await browser([response(200, { items: [dish()] })]);
  const heading = app.parts['menu-category-title'];
  const scrolled = [];
  heading.getBoundingClientRect = () => ({ top: -1600 });
  app.parts['menu-filters'].getBoundingClientRect = () => ({ bottom: 167 });
  heading.scrollIntoView = options => scrolled.push(JSON.parse(JSON.stringify(options)));
  await app.filter('dinner');
  assert.equal(heading.textContent, 'Ужины');
  assert.deepEqual(scrolled, [{ block: 'start', behavior: 'instant' }]);
});

test('manually created nested website groups expose descendants, siblings and breadcrumb navigation', async () => {
  const source = externalId => ({ provider: 'kds', organizationId: 'baa06e7a-b091-4296-97bc-275bc22d9af9', externalId, testOnly: true });
  const categories = [
    ...menuCategories.DEFAULT_MENU_CATEGORIES,
    { id: 'redbox', name: 'Меню REDBOX', parentId: null, order: 2 },
    { id: 'sushi', name: 'Суши', parentId: 'redbox', order: 0 },
    { id: 'seared', name: 'Суши Опаленнные', parentId: 'sushi', order: 0 },
    { id: 'rolls', name: 'Роллы', parentId: 'redbox', order: 1 },
  ];
  const app = await browser([response(200, { categories, items: [
    dish(),
    dish({ id: 'salmon', name: 'Суши лосось', category: 'sushi', order: 2, source:source('200') }),
    dish({ id: 'seared-salmon', name: 'Опалённый лосось', category: 'seared', image: '', order: 1, source:source('201') }),
    dish({ id: 'roll', name: 'Ролл', category: 'rolls', order: 3, source:source('202') }),
  ] })]);
  assert.equal(app.parts['menu-test-notice'].hidden, true);
  await app.filter('redbox');
  assert.deepEqual(app.names(), ['Суши лосось', 'Ролл', 'Опалённый лосось']);
  assert.equal(app.parts['menu-category-title'].textContent, 'Меню REDBOX');
  assert.equal(app.parts['menu-test-notice'].hidden, false);
  assert.deepEqual(app.parts['menu-subcategories'].children.map(button => button.dataset.menuFilter), ['redbox', 'sushi', 'rolls']);
  await app.filter('sushi');
  assert.deepEqual(app.names(), ['Суши лосось', 'Опалённый лосось']);
  assert.deepEqual(app.parts['menu-breadcrumbs'].children.map(crumb => crumb.textContent), ['Меню REDBOX', 'Суши']);
  assert.equal(app.parts['menu-breadcrumbs'].hidden, false);
  await app.filter('seared');
  assert.deepEqual(app.names(), ['Опалённый лосось']);
  assert.equal(app.parts['menu-category-title'].textContent, 'Суши Опаленнные');
  assert.equal(byTag(app.cards()[0], 'button')[0].disabled, true, 'A manually placed test dish remains unavailable for ordering');
  assert.deepEqual(app.parts['menu-subcategories'].children.map(button => button.dataset.menuFilter), ['sushi', 'seared']);
  assert.equal(app.parts['menu-subcategories'].children[1].getAttribute('aria-pressed'), 'true');
  await app.parts['menu-breadcrumbs'].children[0].dispatch('click');
  assert.equal(app.cards().length, 3);
  assert.equal(app.parts['menu-breadcrumbs'].hidden, true);
  assert.equal(app.requests.length, 1, 'Hierarchy navigation operates on the loaded snapshot');
});

test('cash-only dishes and old automatic source categories never appear in the guest menu', async () => {
  const source = externalId => ({ provider:'kds', organizationId:'test-organization', externalId });
  const imported = {id:'cash-coffee',name:'Кофе из кассы',parentId:null,order:2,source:source('10')};
  const app=await browser([response(200, { categories:[...menuCategories.DEFAULT_MENU_CATEGORIES,imported], sourceCategories:[imported], items:[
    dish(),
    dish({id:'old-import',name:'Старый импорт',category:'cash-coffee',source:{...source('100'),groupExternalId:'10'}}),
    dish({id:'new-import',name:'Новая позиция из кассы',category:null,source:{...source('101'),groupExternalId:'10'},published:false,availableForOrder:false}),
  ] })]);
  assert.deepEqual(app.filters.map(button=>button.dataset.menuFilter),['breakfast','dinner']);
  assert.deepEqual(app.names(),['Тост с яйцом']);
  assert.equal(app.parts['menu-retry'].hidden,true);
  assert.equal(app.window.cafeMenuSnapshot.items.length,1);
});

test('mapped dishes appear in their website category and empty source roots stay out of guest navigation', async () => {
  const source = { provider: 'kds', organizationId: 'baa06e7a-b091-4296-97bc-275bc22d9af9', externalId: '200' };
  const categories = [
    ...menuCategories.DEFAULT_MENU_CATEGORIES,
    { id: 'bar', name: 'Бар', parentId: null, order: 2, source },
    { id: 'coffee', name: 'Кофе', parentId: 'bar', order: 0, source: { ...source, externalId: '201' } },
    { id: 'drinks', name: 'Напитки', parentId: null, order: 3 },
  ];
  const app = await browser([response(200, { categories, items: [dish(), dish({ id: 'latte', name: 'Латте', category: 'drinks', source: { ...source, testOnly: true }, price: 0, availableForOrder: false, order: 2 })] })]);
  assert.deepEqual(app.parts['menu-roots'].children.map(button => button.dataset.menuFilter), ['breakfast', 'dinner', 'drinks']);
  await app.filter('drinks');
  assert.deepEqual(app.names(), ['Латте']);
  assert.equal(app.parts['menu-subcategories'].hidden, true);
  assert.equal(app.parts['menu-category-title'].textContent, 'Напитки');
  assert.equal(app.parts['menu-test-notice'].hidden, false, 'Mapped test items remain clearly marked in a local category');
  assert.match(byClass(app.cards()[0], 'dish-category')[0].textContent, /Тестовое блюдо/);
  assert.equal(byClass(app.cards()[0], 'dish-price')[0].textContent, 'Цена уточняется');
});

test('published imported dishes load without the private cash tree and retain runtime restrictions', async () => {
  const source = { provider:'kds', organizationId:'00000000-0000-4000-8000-000000000001', externalId:'101', groupExternalId:'10' };
  const payload = { categories:menuCategories.DEFAULT_MENU_CATEGORIES, items:[dish({category:'breakfast',source,availableForOrder:false})] };
  const app = await browser([response(200,payload)]);
  assert.deepEqual(app.names(),['Тост с яйцом']);
  assert.equal(app.parts['menu-retry'].hidden,true);
  assert.equal(byTag(app.cards()[0],'button')[0].disabled,true);
  assert.throws(()=>menuCategories.normalizeMenuData(payload),'Private catalog validation still requires its source tree');
  assert.throws(()=>menuCategories.normalizeMenuData({...payload,sourceCategories:[]},{allowOmittedSourceTree:true}),'Explicitly provided broken source trees remain invalid');
});

test('the saved group order chooses the first group on arrival and preserves a guest choice on refresh', async () => {
  const categories = [
    { id: 'dinner', name: 'Ужины', parentId: null, order: 0 },
    { id: 'breakfast', name: 'Завтраки', parentId: null, order: 1 },
  ];
  const payload = { categories, items: [dish(), dish({ id: 'dinner-dish', name: 'Ужин', category: 'dinner' })] };
  const app = await browser([response(200, payload), response(200, payload)]);
  assert.deepEqual(app.filters.map(button => button.dataset.menuFilter), ['dinner', 'breakfast']);
  assert.equal(app.parts['menu-category-title'].textContent, 'Ужины');
  assert.deepEqual(app.names(), ['Ужин']);
  await app.filter('breakfast');
  await app.window.dispatch('focus');
  assert.equal(app.parts['menu-category-title'].textContent, 'Завтраки');
});

test('a removed selected category falls back safely while surviving cards retain their state', async () => {
  const categories = [...menuCategories.DEFAULT_MENU_CATEGORIES, { id: 'drinks', name: 'Напитки', parentId: null, order: 2 }];
  const app = await browser([
    response(200, { categories, items: [dish(), dish({ id: 'latte', category: 'drinks' })] }),
    response(200, { categories: menuCategories.DEFAULT_MENU_CATEGORIES, items: [dish()] }),
  ]);
  await app.filter('drinks');
  await app.window.dispatch('focus');
  assert.equal(app.parts['menu-category-title'].textContent, 'Завтраки');
  assert.equal(app.cards().length, 1);
  assert.equal(app.parts['menu-retry'].hidden, true);
});
