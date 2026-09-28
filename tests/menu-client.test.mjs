import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../menu.js', import.meta.url), 'utf8');

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
    'dish-grid', 'dish-extras', 'extra-section', 'menu-empty', 'menu-count',
    'menu-status', 'menu-retry', 'menu-filters',
  ].map((name) => [name, new Element()]));
  for (const name of ['extra-section', 'menu-empty', 'menu-retry', 'menu-filters']) parts[name].hidden = true;
  const filters = ['all', 'signature', 'eggs', 'porridge', 'sweet'].map((name) => {
    const button = new Element('button');
    button.dataset.menuFilter = name;
    return button;
  });
  root.querySelector = (selector) => {
    const name = selector.match(/^\[data-(.+)\]$/)?.[1];
    assert.ok(parts[name], `Unexpected DOM query: ${selector}`);
    return parts[name];
  };
  root.querySelectorAll = (selector) => {
    assert.equal(selector, '[data-menu-filter]');
    return filters;
  };
  const window = new Element();
  const requests = [];
  const document = {
    querySelector: (selector) => selector === '[data-breakfast-menu]' ? root : null,
    createElement: (tag) => new Element(tag),
  };
  const context = vm.createContext({
    document, window, location: new URL(href), URL, Intl, AbortSignal,
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
    root, parts, filters, requests, window, cards,
    names: () => cards().flatMap((card) => byTag(card, 'h3').map((heading) => heading.textContent)),
    filter: async (name) => {
      const button = filters.find((entry) => entry.dataset.menuFilter === name);
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

test('category controls filter both card types, announce empty results, and restore all dishes', async () => {
  const app = await browser([response(200, { items: [
    dish(),
    dish({ id: 'syrniki', name: 'Сырники', category: 'sweet', order: 3 }),
    dish({ id: 'porridge', name: 'Каша', category: 'porridge', image: '', order: 2 }),
    dish({ id: 'draft', name: 'Черновик', category: 'signature', published: false }),
  ] })]);
  assert.equal(app.cards().length, 3);
  await app.filter('sweet');
  assert.deepEqual(app.names(), ['Сырники']);
  assert.equal(app.parts['extra-section'].hidden, true);
  assert.equal(app.parts['menu-count'].textContent, '1 блюдо');
  assert.deepEqual(app.filters.filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.dataset.menuFilter), ['sweet']);
  await app.filter('signature');
  assert.equal(app.cards().length, 0);
  assert.equal(app.parts['menu-empty'].hidden, false);
  assert.equal(app.parts['menu-count'].textContent, '0 блюд');
  await app.filter('porridge');
  assert.deepEqual(app.names(), ['Каша']);
  assert.equal(app.parts['extra-section'].hidden, false);
  assert.equal(app.parts['menu-empty'].hidden, true);
  await app.filter('all');
  assert.equal(app.parts['dish-grid'].children.length, 2);
  assert.equal(app.parts['dish-extras'].children.length, 1);
  assert.equal(app.parts['menu-count'].textContent, '3 блюда');
  assert.equal(app.requests.length, 1, 'Filtering the loaded menu requires no extra request');
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


test('live menu availability disables cart controls independently of publication for photo and text dishes', async () => {
  const app = await browser([response(200, { revision: 23, items: [
    dish({ id: 'legacy-photo' }),
    dish({ id: 'available-text', image: '', availableForOrder: true }),
    dish({ id: 'unavailable-photo', name: 'Тост & сыр', availableForOrder: false }),
    dish({ id: 'unavailable-text', image: '', availableForOrder: false }),
    dish({ id: 'hidden-dish', published: false, availableForOrder: true }),
  ] })]);
  const buttons = app.cards().flatMap(card => byTag(card, 'button'));
  assert.equal(buttons.length, 4);
  for (const id of ['legacy-photo', 'available-text']) {
    const button = buttons.find(button => button.dataset.cartAdd === id);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'В корзину');
    assert.match(button.getAttribute('aria-label'), /^В корзину: /);
  }
  for (const id of ['unavailable-photo', 'unavailable-text']) {
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
