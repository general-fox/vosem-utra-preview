import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as menuCategories from '../menu-categories.js';
import { orderedDrinkSections } from '../menu-drinks-model.js';
import { setupMobileCategoryRail } from '../menu-mobile-navigation.js';
import { createDrinkAddonsDialog } from '../drink-addons-dialog.js';
import { setupMenuHeader } from '../menu-header.js';
import { menuImages } from '../menu-images.js';
import { createMenuGallery } from '../menu-gallery.js';
import { createDishDetails, dishInformation, bindDishCardDetails } from '../dish-details.js';

const script = readFileSync(new URL('../menu.js', import.meta.url), 'utf8').replace(/^import .*?;\r?\n/gm, '');

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
    this.style = { setProperty(name, value) { this[name] = String(value); }, removeProperty(name) { delete this[name]; } };
  }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  append(...children) {
    for (const child of children) {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    this.text = '';
    for (const child of [...this.children]) child.remove();
    this.append(...children);
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  get ownerDocument() { return this.document ?? this.parentElement?.ownerDocument ?? null; }
  get isConnected() { return this.ownerDocument?.contains(this) ?? false; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  get classList() {
    const element = this;
    return {
      contains(name) { return element.className.split(/\s+/).includes(name); },
      add(...names) { element.className = [...new Set([...element.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove(...names) { element.className = element.className.split(/\s+/).filter(name => name && !names.includes(name)).join(' '); },
      toggle(name, force) {
        const add = force ?? !this.contains(name);
        if (add) this.add(name); else this.remove(name);
        return add;
      },
    };
  }
  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once: options.once });
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(entry => entry.listener !== listener)); }
  scrollTo(options) { this.scrollOptions = options; this.scrollLeft = options.left; void this.dispatch('scroll'); }
  focus(options) {
    this.focused = true;
    this.focusOptions = options;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  showModal() {
    assert.equal(this.tagName, 'DIALOG', 'Only a native dialog enters the modal top layer');
    assert.equal(this.isConnected, true, 'The native dialog is attached before it opens');
    this.open = true;
    this.modalOpenCount = (this.modalOpenCount ?? 0) + 1;
  }
  close() {
    if (!this.open) return;
    this.open = false;
    void this.dispatch('close');
  }
  async dispatch(type, event = {}) {
    const listeners = [...(this.listeners.get(type) ?? [])];
    this.listeners.set(type, listeners.filter((entry) => !entry.once));
    let prevented = false;
    const dispatched = { target: this, currentTarget: this, ...event,
      preventDefault() { prevented = true; event.preventDefault?.(); },
      get defaultPrevented() { return prevented; },
    };
    await Promise.all(listeners.map(({ listener }) => listener(dispatched)));
    if (type === 'cancel' && this.tagName === 'DIALOG' && !prevented) this.close();
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
async function openDrinkAddons(app, card) {
  const trigger = byClass(card, 'drink-addons-title')[0];
  assert.ok(trigger, 'The drink offers additions');
  assert.equal(trigger.tagName, 'BUTTON');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(byClass(card, 'drink-addon-check').length, 0, 'Choices never expand the card in the grid');
  trigger.focus();
  await trigger.dispatch('click');
  const dialogs = byTag(app.document, 'dialog');
  assert.equal(dialogs.length, 1, 'All drinks share one modal');
  const dialog = dialogs[0];
  assert.equal(dialog.open, true);
  assert.equal(trigger.getAttribute('aria-controls'), dialog.id);
  return dialog;
}
const closeDrinkAddons = dialog => byClass(dialog, 'drink-addons-done')[0].dispatch('click');
function assertDishPlaceholder(card) {
  const visuals = byClass(card, 'dish-visual');
  assert.equal(visuals.length, 1, 'Every ordinary dish reserves the same image area');
  assert.equal(visuals[0].hidden, false, 'The decorative area keeps its place in the common grid');
  const placeholder = visuals[0];
  assert.equal(placeholder.classList.contains('dish-placeholder'), true);
  const marks = byClass(placeholder, 'dish-placeholder-mark');
  assert.equal(marks.length, 1, 'The decorative visual contains just one shared brand mark');
  const mark = marks[0];
  assert.equal(mark.tagName, 'SPAN');
  assert.equal(mark.textContent, '');
  assert.equal(placeholder.getAttribute('aria-hidden'), 'true');
  assert.equal(mark.getAttribute('aria-hidden'), 'true');
  assert.equal(byTag(placeholder, 'img').length, 0, 'The decorative background never produces a broken-image browser icon or redundant alt text');
  assert.doesNotMatch(normalizedText(card), /Без фотографии|Фото скоро появится/);
  assert.equal(card.classList.contains('dish-card'), true);
  assert.equal(card.classList.contains('dish-card-text'), false, 'Missing photos no longer select a compact text-row layout');
  return { visual: visuals[0], placeholder, mark };
}
function assertDrinkPlaceholder(card) {
  const visuals = byClass(card, 'drink-visual');
  assert.equal(visuals.length, 1, 'Every drink keeps one square visual in the card shell');
  const visual = visuals[0];
  assert.equal(visual.hidden, false);
  assert.equal(visual.classList.contains('drink-placeholder'), true);
  assert.equal(visual.classList.contains('dish-visual'), false, 'Drinks keep their own card styles');
  assert.equal(visual.getAttribute('aria-hidden'), 'true');
  const marks = byClass(visual, 'dish-placeholder-mark');
  assert.equal(marks.length, 1);
  assert.equal(marks[0].tagName, 'SPAN');
  assert.equal(marks[0].textContent, '');
  assert.equal(marks[0].getAttribute('aria-hidden'), 'true');
  assert.equal(byTag(visual, 'img').length, 0);
  assert.doesNotMatch(normalizedText(card), /Без фотографии|Фото скоро появится/);
  assert.equal(card.classList.contains('drink-card'), true);
  assert.equal(card.parentElement.classList.contains('drink-photo-list'), true);
  return { visual, mark: marks[0] };
}

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

async function browser(replies, href = 'https://cafe.example/index.html', device = null, profile = 'delivery') {
  const root = new Element('section');
  const parts = Object.fromEntries([
    'dish-grid', 'dish-extras', 'extra-section', 'menu-empty', 'menu-count', 'menu-roots', 'menu-subcategories',
    'menu-breadcrumbs', 'menu-category-title', 'menu-test-notice',
    'menu-status', 'menu-retry', 'menu-filters', 'menu-nav-shell', 'menu-drink-nav', 'drinks-menu',
  ].map((name) => [name, new Element()]));
  for (const name of ['extra-section', 'menu-empty', 'menu-retry', 'menu-filters', 'menu-breadcrumbs', 'menu-subcategories', 'menu-test-notice', 'menu-drink-nav']) parts[name].hidden = true;
  parts['menu-filters'].append(parts['menu-roots'], parts['menu-subcategories'], parts['menu-drink-nav']);
  parts['menu-nav-shell'].append(parts['menu-filters']);
  root.append(parts['menu-nav-shell'], parts['drinks-menu'], parts['dish-grid'], parts['dish-extras']);
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
  const scrolls = [];
  window.scrollTo = options => scrolls.push(options);
  const dispatched = [];
  window.dispatchEvent = event => { dispatched.push(event); void window.dispatch(event.type, event); return true; };
  const media = new Element();
  const intersections = [];
  if (device) {
    media.matches = device.mobile;
    window.matchMedia = query => {
      if (query.includes('prefers-reduced-motion')) return { matches:false };
      assert.match(query, /max-width:\s*650px/);
      return media;
    };
    if (device.intersection !== false) window.IntersectionObserver = class {
      constructor(callback, options) { this.callback = callback; this.options = options; intersections.push(this); }
      observe(target) { this.target = target; }
      emit(isIntersecting) { this.callback([{ target:this.target, isIntersecting }]); }
    };
  }
  const requests = [];
  const document = new Element('document');
  document.document = document;
  document.documentElement = new Element('html');
  document.body = new Element('body');
  document.querySelector = (selector) => selector === '[data-breakfast-menu]' ? root : selector === 'meta[name="cafe-profile"]' && profile ? { content:profile } : null;
  document.createElement = (tag) => {
    const element = Object.assign(new Element(tag), { document });
    if (tag === 'dialog') element.getBoundingClientRect = () => ({ left:40, right:360, top:80, bottom:600 });
    return element;
  };
  document.body.append(root);
  document.documentElement.append(document.body);
  document.append(document.documentElement);
  const context = vm.createContext({
    document, window, location: new URL(href), URL, Intl, AbortSignal, ...menuCategories, orderedDrinkSections,
    setupMobileCategoryRail: menuRoot => setupMobileCategoryRail(menuRoot, window),
    createDrinkAddonsDialog, menuImages, createMenuGallery, createDishDetails, dishInformation, bindDishCardDetails,
    setupMenuHeader: menuRoot => setupMenuHeader(menuRoot, window),
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
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
    root, parts, get filters() { return filters(); }, requests, window, document, cards, media, intersections, dispatched, scrolls,
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

test('groups keep photo and no-photo dishes in one ordered grid and announce an empty dinner', async () => {
  const app = await browser([response(200, { items: [
    dish(),
    dish({ id: 'syrniki', name: 'Сырники', category: 'sweet', order: 3 }),
    dish({ id: 'porridge', name: 'Каша', category: 'porridge', image: '', order: 2 }),
    dish({ id: 'draft', name: 'Черновик', category: 'signature', published: false }),
  ] })]);
  assert.equal(app.cards().length, 3);
  assert.deepEqual(app.names(), ['Тост с яйцом', 'Каша', 'Сырники']);
  assert.equal(app.parts['dish-grid'].children.length, 3);
  assert.equal(app.parts['dish-extras'].children.length, 0);
  assert.equal(app.parts['extra-section'].hidden, true);
  assertDishPlaceholder(app.cards()[1]);
  assert.deepEqual(app.filters.map(button => button.dataset.menuFilter), ['breakfast', 'dinner']);
  assert.deepEqual(app.filters.map(button => button.textContent), ['Завтраки', 'Ужины']);
  assert.deepEqual(app.filters.map(button => button.getAttribute('aria-label')), ['Завтраки', 'Ужины']);
  assert.ok(app.filters.every(button => byClass(button, 'menu-category-count').length === 0));
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
  assert.equal(app.parts['dish-grid'].children.length, 3);
  assert.equal(app.parts['dish-extras'].children.length, 0);
  assert.equal(app.parts['extra-section'].hidden, true);
  assert.equal(app.parts['menu-count'].textContent, '3 блюда');
  assert.equal(app.requests.length, 1, 'Filtering the loaded menu requires no extra request');
});

test('photo edits replace only the card visual without moving a dish to a separate list', async () => {
  const text = dish({ image: '' });
  const app = await browser([
    response(200, { items: [text] }),
    response(200, { items: [text] }),
    response(200, { items: [dish()] }),
    response(200, { items: [text] }),
    response(200, { items: [] }),
  ]);
  const card = app.parts['dish-grid'].children[0];
  assert.equal(app.parts['dish-grid'].children.length, 1);
  assert.equal(app.parts['dish-extras'].children.length, 0);
  assert.equal(app.parts['extra-section'].hidden, true);
  assertDishPlaceholder(card);
  assert.equal(app.parts['menu-empty'].hidden, true);
  assert.equal(app.parts['menu-count'].textContent, '1 блюдо');
  await app.window.dispatch('focus');
  assert.equal(app.parts['dish-grid'].children[0], card, 'Unchanged placeholder cards keep their live nodes');
  await app.window.dispatch('focus');
  assert.equal(app.parts['dish-grid'].children.length, 1);
  assert.equal(app.parts['dish-extras'].children.length, 0);
  assert.equal(app.parts['extra-section'].hidden, true);
  assert.deepEqual(app.names(), ['Тост с яйцом']);
  assert.equal(byClass(app.cards()[0], 'dish-photo').length, 1);
  assert.equal(app.cards()[0].dataset.revealKey, card.dataset.revealKey, 'Changing a photo preserves the key used by the shared reveal observer');
  await app.window.dispatch('focus');
  assert.equal(app.parts['dish-grid'].children.length, 1);
  assert.equal(app.parts['dish-extras'].children.length, 0);
  assert.equal(app.parts['extra-section'].hidden, true);
  assert.deepEqual(app.names(), ['Тост с яйцом']);
  assertDishPlaceholder(app.cards()[0]);
  await app.window.dispatch('focus');
  assert.equal(app.cards().length, 0);
  assert.equal(app.parts['extra-section'].hidden, true);
  assert.equal(app.parts['menu-empty'].hidden, false);
});

test('missing photos at the beginning, middle and end never change the saved dish order', async () => {
  const app = await browser([response(200, { items: [
    dish({ id: 'last', name: 'Последнее блюдо', order: 5, image: '' }),
    dish({ id: 'photo-two', name: 'Второе фото', order: 4 }),
    dish({ id: 'first', name: 'Первое блюдо', order: 1, image: '' }),
    dish({ id: 'middle', name: 'Среднее блюдо', order: 3, image: '' }),
    dish({ id: 'photo-one', name: 'Первое фото', order: 2 }),
  ] })]);
  assert.deepEqual(app.names(), ['Первое блюдо', 'Первое фото', 'Среднее блюдо', 'Второе фото', 'Последнее блюдо']);
  assert.equal(app.parts['dish-grid'].children.length, 5);
  assert.equal(app.parts['dish-extras'].children.length, 0);
  for (const index of [0, 2, 4]) assertDishPlaceholder(app.cards()[index]);
  for (const card of app.cards()) {
    assert.equal(card.parentElement, app.parts['dish-grid']);
    assert.equal(byClass(card, 'dish-visual').length, 1);
    assert.equal(card.classList.contains('dish-card-text'), false);
  }
});

test('a failed real dish image shows the same decorative placeholder without changing card, order or controls', async () => {
  const items = [dish(), dish({ id: 'porridge', name: 'Каша', image: '', order: 2 })];
  const app = await browser([response(200, { items }), response(200, { items })]);
  const card = app.cards()[0];
  const photo = byClass(card, 'dish-photo')[0];
  const visual = byClass(card, 'dish-visual')[0];
  const body = byClass(card, 'dish-body')[0];
  const actions = byClass(card, 'dish-cart-actions')[0];
  card.dataset.revealState = 'shown';
  assert.equal(photo.src, 'https://cafe.example/menu-images/eggs.webp');
  assert.equal(photo.alt, 'Тост с яйцом');
  await photo.dispatch('error');
  const failed = assertDishPlaceholder(card);
  const missing = assertDishPlaceholder(app.cards()[1]);
  assert.equal(failed.visual, visual, 'An image failure does not remove or resize the visual container');
  assert.equal(failed.mark.className, missing.mark.className, 'Missing and broken photos share the same CSS-backed decorative mark');
  assert.equal(photo.hidden === true || !visual.contains(photo), true, 'A broken-image browser icon is never left visible');
  assert.equal(byClass(card, 'dish-body')[0], body);
  assert.equal(byClass(card, 'dish-cart-actions')[0], actions);
  assert.deepEqual(app.names(), ['Тост с яйцом', 'Каша']);
  assert.equal(card.dataset.revealState, 'shown');
  await app.window.dispatch('focus');
  await app.filter('dinner');
  await app.filter('breakfast');
  assert.equal(app.cards()[0], card);
  assert.equal(assertDishPlaceholder(card).placeholder, failed.placeholder, 'Unchanged refresh and filtering do not restart a failed request or replace the fallback');
  assert.equal(card.dataset.revealState, 'shown');
  assert.equal(byClass(card, 'dish-cart-actions')[0], actions);
  await photo.dispatch('error');
  assert.equal(byClass(visual, 'dish-placeholder-mark').length, 1, 'A repeated error cannot append duplicate placeholders');
});

test('both static preview layouts render decorative placeholders using the shared stylesheet asset', async () => {
  const base = 'https://general-fox.github.io/vosem-utra-preview/';
  for (const sourcePreview of [false, true]) {
    const replies = [response(404), ...(sourcePreview ? [response(404)] : []), response(200, { items: [dish({ image: '' })] })];
    const app = await browser(replies, `${base}index.html#menu`);
    assertDishPlaceholder(app.cards()[0]);
    assert.equal(app.parts['dish-grid'].children.length, 1);
    assert.equal(app.parts['dish-extras'].children.length, 0);
    assert.equal(app.parts['extra-section'].hidden, true);
  }
  const css = readFileSync(new URL('../menu.css', import.meta.url), 'utf8');
  assert.match(css, /\.dish-placeholder-mark\s*\{[^}]*url\(\s*['"]?\.\/assets\/dish-placeholder\.svg['"]?\s*\)/);
  const svg = readFileSync(new URL('../assets/dish-placeholder.svg', import.meta.url), 'utf8');
  assert.match(svg, /<svg\b/);
  assert.doesNotMatch(svg, /<text\b|<foreignObject\b|<image\b/);
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
  const items = [dish(), dish({ id: 'sweet', category: 'sweet', image: '', order: 2 })];
  const app = await browser([response(200, { items }), response(200, { items })]);
  const card = app.cards()[0];
  const placeholderCard = app.cards()[1];
  const placeholder = assertDishPlaceholder(placeholderCard).placeholder;
  assert.equal(card.dataset.reveal, 'visual');
  assert.equal(card.dataset.revealKey, 'dish:eggs');
  assert.equal(byClass(card, 'dish-cart-actions')[0].dataset.cartItem, 'eggs');
  card.dataset.revealState = 'shown';
  placeholderCard.dataset.revealState = 'shown';
  assert.equal(placeholderCard.dataset.reveal, 'visual');
  assert.equal(placeholderCard.dataset.revealKey, 'dish:sweet');
  const placeholderActions = byClass(placeholderCard, 'dish-cart-actions')[0];
  assert.equal(placeholderActions.dataset.cartItem, 'sweet');
  const breakfastButton = app.filters[0];
  await app.window.dispatch('focus');
  assert.equal(app.cards()[0], card);
  assert.equal(app.cards()[1], placeholderCard);
  assert.equal(app.filters[0], breakfastButton, 'An unchanged refresh keeps the focused category button');
  await app.filter('dinner'); await app.filter('breakfast');
  assert.equal(app.cards()[0], card);
  assert.equal(card.dataset.revealState, 'shown');
  assert.equal(app.cards()[1], placeholderCard);
  assert.equal(placeholderCard.dataset.revealState, 'shown');
  assert.equal(assertDishPlaceholder(placeholderCard).placeholder, placeholder);
  assert.equal(byClass(placeholderCard, 'dish-cart-actions')[0], placeholderActions);
  assert.equal(app.dispatched.filter(event => event.type === 'cafe:menu-rendered').length, 4, 'Shared reveal notification still follows initial load, refresh and both filter changes');
});


test('live menu availability disables cart controls independently of publication for photo and placeholder dishes', async () => {
  const app = await browser([response(200, { revision: 23, items: [
    dish({ id: 'legacy-photo' }),
    dish({ id: 'available-text', image: '', availableForOrder: true }),
    dish({ id: 'unavailable-photo', name: 'Тост & сыр', availableForOrder: false }),
    dish({ id: 'unavailable-text', image: '', availableForOrder: false }),
    dish({ id: 'test-only', availableForOrder: true, source: { provider: 'kds', organizationId: 'baa06e7a-b091-4296-97bc-275bc22d9af9', externalId: '100', testOnly: true } }),
    dish({ id: 'hidden-dish', published: false, availableForOrder: true }),
  ] })]);
  const buttons = app.cards().flatMap(card => byClass(card, 'dish-order-button'));
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
  assert.deepEqual(app.names(), ['Опалённый лосось', 'Суши лосось', 'Ролл']);
  assert.equal(app.parts['menu-category-title'].textContent, 'Меню REDBOX');
  assert.equal(app.parts['menu-test-notice'].hidden, false);
  assert.deepEqual(app.parts['menu-subcategories'].children.map(button => button.dataset.menuFilter), ['redbox', 'sushi', 'rolls']);
  await app.filter('sushi');
  assert.deepEqual(app.names(), ['Опалённый лосось', 'Суши лосось']);
  assert.deepEqual(app.parts['menu-breadcrumbs'].children.map(crumb => crumb.textContent), ['Меню REDBOX', 'Суши']);
  assert.equal(app.parts['menu-breadcrumbs'].hidden, false);
  await app.filter('seared');
  assert.deepEqual(app.names(), ['Опалённый лосось']);
  assert.equal(app.parts['menu-category-title'].textContent, 'Суши Опаленнные');
  assert.equal(byClass(app.cards()[0], 'dish-order-button')[0].disabled, true, 'A manually placed test dish remains unavailable for ordering');
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
  assert.equal(byClass(app.cards()[0],'dish-order-button')[0].disabled,true);
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

const drinkDish = (patch = {}) => dish({ id:'cappuccino', name:'Капучино', category:'drinks', image:'', price:230,
  availableForOrder:false, description:'', drink:{section:'С молоком', variants:[{volumeMl:230,price:230},{volumeMl:370,price:370}], addons:[{name:'Альтернативное молоко',price:160}]}, ...patch });
const withDrinks = items => ({ categories:[...menuCategories.DEFAULT_MENU_CATEGORIES, {id:'drinks',name:'Напитки',parentId:null,order:2}], items });

test('drinks keep one visual card per drink and update price from volume and optional additions', async () => {
  const app = await browser([response(200, withDrinks([drinkDish()]))]);
  await app.filter('drinks');
  const panel = app.parts['drinks-menu'];
  assert.equal(panel.hidden, false);
  assert.equal(app.cards().length, 0, 'Drinks do not duplicate into ordinary dish cards');
  assert.equal(byClass(panel, 'drink-card').length, 1);
  assertDrinkPlaceholder(byClass(panel, 'drink-card')[0]);
  assert.equal(byClass(panel, 'drink-list').length, 0);
  const price = byClass(panel, 'drink-price')[0];
  assert.equal(normalizedText(price), '230 ₽');
  const volumes = byClass(panel, 'drink-volume');
  await volumes[1].dispatch('click');
  assert.equal(normalizedText(price), '370 ₽');
  assert.equal(volumes[1].getAttribute('aria-pressed'), 'true');
  assert.equal(volumes[0].getAttribute('aria-pressed'), 'false');
  const dialog = await openDrinkAddons(app, byClass(panel, 'drink-card')[0]);
  const extra = byClass(dialog, 'drink-addon-check')[0];
  extra.checked = true;
  await extra.dispatch('change');
  assert.equal(normalizedText(price), '530 ₽');
  assert.equal(normalizedText(byClass(dialog, 'drink-addons-total-value')[0]), '530 ₽');
  await closeDrinkAddons(dialog);
  await volumes[0].dispatch('click');
  assert.equal(normalizedText(price), '390 ₽');
  await openDrinkAddons(app, byClass(panel, 'drink-card')[0]);
  assert.equal(extra.checked, true, 'Reopening preserves the choice');
  assert.equal(normalizedText(byClass(dialog, 'drink-addons-total-value')[0]), '390 ₽');
  extra.checked = false;
  await extra.dispatch('change');
  assert.equal(normalizedText(price), '230 ₽');
  await closeDrinkAddons(dialog);
  assert.equal(byClass(panel, 'dish-order-button').length, 0);
});

test('many drink additions use a named native modal with a scrollable list and exact live totals', async () => {
  const addons=Array.from({length:12},(_,index)=>({name:index===0?'Сироп <b>ваниль</b>':`Добавка ${index+1}`,price:index===0?10.1:index===11?10.2:20}));
  const item=drinkDish({drink:{...drinkDish().drink,addons}});
  const without=drinkDish({id:'espresso',name:'Эспрессо',drink:{section:'С молоком',variants:[{volumeMl:40,price:170}],addons:[]}});
  const app=await browser([response(200,withDrinks([item,without]))]);
  await app.filter('drinks');
  const cards=byClass(app.parts['drinks-menu'],'drink-card');
  assert.equal(byTag(app.document,'dialog').length,0,'The closed menu does not create twelve inline inputs per card');
  assert.equal(byClass(cards[1],'drink-addons-title').length,0,'A drink without extras has no empty action');
  const count=byClass(cards[0],'drink-addons-count')[0];
  assert.equal(count.hidden,true);
  await byClass(cards[0],'drink-volume')[1].dispatch('click');
  const dialog=await openDrinkAddons(app,cards[0]);
  assert.equal(dialog.modalOpenCount,1);
  assert.equal(app.root.contains(dialog),false,'The modal is outside the card grid and its clipping/stacking contexts');
  assert.equal(dialog.parentElement,app.document.body);
  assert.equal(dialog.getAttribute('aria-labelledby'),byClass(dialog,'drink-addons-dialog-title')[0].id);
  assert.equal(dialog.getAttribute('aria-describedby'),byClass(dialog,'drink-addons-dialog-context')[0].id);
  assert.equal(normalizedText(byClass(dialog,'drink-addons-dialog-context')[0]),'Капучино · 370 мл');
  const options=byClass(dialog,'drink-addon-options')[0];
  const footer=byClass(dialog,'drink-addons-dialog-footer')[0];
  assert.equal(options.parentElement,dialog);
  assert.equal(footer.parentElement,dialog,'Done and the total remain outside the scrolling options');
  assert.equal(options.getAttribute('role'),'group');
  assert.equal(byClass(options,'drink-addon-check').length,12,'Every supported option remains available');
  assert.equal(byTag(options,'b').length,0,'Author text remains literal in the modal');
  const checks=byClass(options,'drink-addon-check');
  for (const index of [0,11]) {
    assert.equal(checks[index].parentElement.tagName,'LABEL');
    checks[index].checked=true;
    await checks[index].dispatch('change');
  }
  assert.equal(normalizedText(byClass(cards[0],'drink-price')[0]),'390,3 ₽');
  assert.equal(normalizedText(byClass(dialog,'drink-addons-total-value')[0]),'390,3 ₽');
  assert.equal(byClass(dialog,'drink-addons-total-value')[0].getAttribute('aria-live'),'polite');
  assert.equal(count.hidden,false);
  assert.equal(count.textContent,'2');
  assert.match(byClass(cards[0],'drink-addons-title')[0].getAttribute('aria-label'),/выбрано 2/);
  await closeDrinkAddons(dialog);
  await byClass(cards[0],'drink-volume')[0].dispatch('click');
  await openDrinkAddons(app,cards[0]);
  assert.equal(normalizedText(byClass(dialog,'drink-addons-total-value')[0]),'250,3 ₽');
  for (const index of [0,11]) { checks[index].checked=false; await checks[index].dispatch('change'); }
  assert.equal(count.hidden,true);
  assert.equal(byClass(cards[0],'drink-price')[0].dataset.includesAddons,'false');
  const css=readFileSync(new URL('../menu.css',import.meta.url),'utf8');
  assert.match(css,/\.drink-addons-dialog\[open\]\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/);
  assert.match(css,/\.drink-addons-dialog\s*\{[^}]*max-height:\s*calc\(100dvh/);
  assert.match(css,/\.drink-addons-dialog\s+\.drink-addon-options\s*\{[^}]*overflow-y:\s*auto/);
});

test('Done, native Escape, close button and backdrop preserve choices and restore focus and page scroll', async () => {
  const app=await browser([response(200,withDrinks([drinkDish()]))]);
  await app.filter('drinks');
  const card=byClass(app.parts['drinks-menu'],'drink-card')[0];
  const trigger=byClass(card,'drink-addons-title')[0];
  const previous={position:'relative',top:'7px',left:'9px',width:'98%',overflow:'auto',paddingRight:'4px'};
  Object.assign(app.document.body.style,previous);
  app.document.documentElement.style.overflow='visible';
  app.document.documentElement.clientWidth=375;
  app.window.innerWidth=390;
  app.window.getComputedStyle=()=>({paddingRight:'4px'});
  app.window.scrollX=10;
  app.window.scrollY=1200;
  const dialog=await openDrinkAddons(app,card);
  assert.equal(app.document.activeElement,byClass(dialog,'drink-addons-close')[0]);
  assert.equal(app.document.body.style.position,'fixed');
  assert.equal(app.document.body.style.top,'-1200px');
  assert.equal(app.document.body.style.paddingRight,'19px');
  assert.equal(app.document.documentElement.style.overflow,'hidden');
  const check=byClass(dialog,'drink-addon-check')[0];
  check.checked=true; await check.dispatch('change');
  const assertClosed=()=>{
    assert.equal(dialog.open,false);
    assert.equal(app.document.activeElement,trigger);
    assert.equal(trigger.focusOptions.preventScroll,true);
    for(const [name,value] of Object.entries(previous)) assert.equal(app.document.body.style[name],value,`Restore ${name}`);
    assert.equal(app.document.documentElement.style.overflow,'visible');
    assert.equal(normalizedText(byClass(card,'drink-price')[0]),'390 ₽');
    assert.equal(app.scrolls.at(-1).top,1200);
    assert.equal(app.scrolls.at(-1).left,10);
  };
  await closeDrinkAddons(dialog);
  assertClosed();
  await openDrinkAddons(app,card);
  assert.equal(check.checked,true);
  await dialog.dispatch('cancel');
  assertClosed();
  await openDrinkAddons(app,card);
  await byClass(dialog,'drink-addons-close')[0].dispatch('click');
  assertClosed();
  await openDrinkAddons(app,card);
  await dialog.dispatch('pointerdown',{clientX:100,clientY:100});
  await dialog.dispatch('click',{clientX:1,clientY:1});
  assert.equal(dialog.open,true,'A drag ending outside must not dismiss the selection');
  await dialog.dispatch('pointerdown',{target:check,clientX:1,clientY:1});
  await dialog.dispatch('click',{target:check,clientX:1,clientY:1});
  assert.equal(dialog.open,true,'Clicking the contents does not count as a backdrop click');
  await dialog.dispatch('pointerdown',{clientX:1,clientY:1});
  await dialog.dispatch('click',{clientX:1,clientY:1});
  assertClosed();
  await openDrinkAddons(app,card);
  const restoredBefore=app.scrolls.length;
  await dialog.dispatch('close');
  assert.equal(dialog.open,true,'A delayed close event from a previous opening cannot close the current modal');
  assert.equal(app.scrolls.length,restoredBefore,'A stale close event cannot unlock the page behind the new modal');
  assert.equal(app.document.body.style.position,'fixed');
  dialog.close();
  assertClosed();
});

test('an unchanged menu refresh preserves an open additions modal, checkbox focus and scroll position', async () => {
  const payload=withDrinks([drinkDish(),drinkDish({id:'latte',name:'Латте'})]);
  const app=await browser([response(200,payload),response(200,payload)]);
  await app.filter('drinks');
  const panel=app.parts['drinks-menu'];
  const card=byClass(panel,'drink-card')[0];
  await byClass(card,'drink-volume')[1].dispatch('click');
  const dialog=await openDrinkAddons(app,card);
  const checkbox=byClass(dialog,'drink-addon-check')[0];
  checkbox.checked=true; await checkbox.dispatch('change');
  checkbox.focus();
  const options=byClass(dialog,'drink-addon-options')[0];
  options.scrollTop=180;
  await app.window.dispatch('focus');
  assert.equal(byClass(panel,'drink-card')[0],card);
  assert.equal(byTag(app.document,'dialog')[0],dialog);
  assert.equal(dialog.open,true);
  assert.equal(dialog.modalOpenCount,1,'Refreshing does not replay opening or move focus');
  assert.equal(byClass(dialog,'drink-addon-check')[0],checkbox);
  assert.equal(checkbox.checked,true);
  assert.equal(app.document.activeElement,checkbox);
  assert.equal(options.scrollTop,180);
  assert.equal(normalizedText(byClass(dialog,'drink-addons-total-value')[0]),'530 ₽');
  await closeDrinkAddons(dialog);
  const other=byClass(panel,'drink-card')[1];
  await openDrinkAddons(app,other);
  assert.equal(byClass(dialog,'drink-addon-check')[0].checked,false,'The shared modal does not copy choices between drinks');
  assert.equal(normalizedText(byClass(dialog,'drink-addons-total-value')[0]),'230 ₽');
  await closeDrinkAddons(dialog);
  await app.filter('breakfast');
  await app.filter('drinks');
  await openDrinkAddons(app,card);
  assert.equal(byClass(dialog,'drink-addon-check')[0].checked,true);
  assert.equal(normalizedText(byClass(dialog,'drink-addons-total-value')[0]),'530 ₽');
  assert.equal(byClass(card,'drink-addons-count')[0].textContent,'1');
});

test('live edits reconcile an open additions modal by name and volume without retaining removed extras', async () => {
  const initial=drinkDish({drink:{...drinkDish().drink,addons:[{name:'Молоко',price:160},{name:'Сироп',price:30}]}});
  const changed={...initial,drink:{...initial.drink,variants:[{volumeMl:230,price:250},{volumeMl:370,price:400}],addons:[{name:'Молоко',price:170},{name:'Вода',price:0}]}};
  const noAddons={...changed,drink:{...changed.drink,addons:[]}};
  const app=await browser([response(200,withDrinks([initial])),response(200,withDrinks([changed])),response(200,withDrinks([noAddons]))]);
  await app.filter('drinks');
  const panel=app.parts['drinks-menu'];
  let card=byClass(panel,'drink-card')[0];
  await byClass(card,'drink-volume')[1].dispatch('click');
  const dialog=await openDrinkAddons(app,card);
  for(const checkbox of byClass(dialog,'drink-addon-check')) { checkbox.checked=true; await checkbox.dispatch('change'); }
  byClass(dialog,'drink-addon-check')[0].focus();
  assert.equal(normalizedText(byClass(dialog,'drink-addons-total-value')[0]),'560 ₽');
  await app.window.dispatch('focus');
  card=byClass(panel,'drink-card')[0];
  assert.equal(dialog.open,true);
  assert.equal(normalizedText(byClass(dialog,'drink-addons-dialog-context')[0]),'Капучино · 370 мл');
  assert.deepEqual(byClass(dialog,'drink-addon-check').map(checkbox=>[checkbox.dataset.addonName,checkbox.checked]),[['Молоко',true],['Вода',false]]);
  assert.equal(app.document.activeElement,byClass(dialog,'drink-addon-check')[0],'An edited list keeps focus on the same surviving option');
  assert.equal(normalizedText(byClass(card,'drink-price')[0]),'570 ₽');
  assert.equal(normalizedText(byClass(dialog,'drink-addons-total-value')[0]),'570 ₽');
  assert.equal(byClass(card,'drink-addons-count')[0].textContent,'1');
  await closeDrinkAddons(dialog);
  assert.equal(app.document.activeElement,byClass(card,'drink-addons-title')[0],'Close returns to the replacement card, not its detached predecessor');
  await openDrinkAddons(app,card);
  await app.window.dispatch('focus');
  assert.equal(dialog.open,false,'Removing every addition closes the obsolete dialog');
  assert.equal(byClass(byClass(panel,'drink-card')[0],'drink-addons-title').length,0);
  assert.equal(normalizedText(byClass(byClass(panel,'drink-card')[0],'drink-price')[0]),'400 ₽');
});

test('changing the main menu category or unpublishing an active drink closes its additions modal', async () => {
  const item=drinkDish();
  const app=await browser([response(200,withDrinks([dish(),item])),response(200,withDrinks([dish(),{...item,published:false}]))]);
  await app.filter('drinks');
  const card=byClass(app.parts['drinks-menu'],'drink-card')[0];
  const dialog=await openDrinkAddons(app,card);
  await app.filter('breakfast');
  assert.equal(dialog.open,false);
  assert.notEqual(app.document.body.style.position,'fixed');
  await app.filter('drinks');
  await openDrinkAddons(app,card);
  await app.window.dispatch('focus');
  assert.equal(dialog.open,false);
  assert.notEqual(app.document.body.style.position,'fixed');
  assert.equal(app.parts['drinks-menu'].hidden,true);
});

test('drink subgroup filtering preserves selection across refresh without hiding other menu categories', async () => {
  const payload = withDrinks([dish(), drinkDish(), drinkDish({id:'tea',name:'Чай',drink:{section:'Чай',variants:[{volumeMl:350,price:210}],addons:[]}})]);
  const app = await browser([response(200,payload), response(200,payload)]);
  await app.filter('drinks');
  const panel = app.parts['drinks-menu'];
  const row = byClass(panel,'drink-card')[0];
  await byClass(panel,'drink-volume')[1].dispatch('click');
  await byClass(panel,'drinks-filter').find(button=>button.dataset.drinkSection==='С молоком').dispatch('click');
  assert.deepEqual(byClass(panel,'drink-section').map(section=>section.hidden), [false,true]);
  assert.equal(app.parts['menu-count'].textContent,'1 напиток');
  await app.window.dispatch('focus');
  assert.equal(app.parts['menu-count'].textContent,'1 напиток');
  assert.equal(byClass(panel,'drink-card')[0],row);
  assert.equal(normalizedText(byClass(row,'drink-price')[0]),'370 ₽');
  await app.filter('breakfast');
  assert.equal(panel.hidden,true);
  assert.equal(app.cards().length,1);
  await app.filter('drinks');
  assert.equal(panel.hidden,false);
  assert.equal(app.parts['menu-count'].textContent,'1 напиток');
});

test('hidden drinks stay private; single-volume tea and zero-cost water render as plain safe text', async () => {
  const tea = drinkDish({id:'tea',name:'<script>Чай</script>',drink:{section:'<b>Чай</b>',variants:[{volumeMl:600,price:350.5}],addons:[{name:'Вода',price:0}]}});
  const app = await browser([response(200,withDrinks([tea,drinkDish({hiddenOnSite:true})]))]);
  await app.filter('drinks');
  const panel=app.parts['drinks-menu'];
  assert.equal(byClass(panel,'drink-card').length,1);
  assert.equal(byClass(panel,'drink-volume').length,0);
  assert.equal(byClass(panel,'drink-volume-single')[0].textContent,'600 мл');
  assert.equal(byTag(panel,'script').length,0);
  const dialog=await openDrinkAddons(app,byClass(panel,'drink-card')[0]);
  assert.equal(byClass(dialog,'drink-addon-price')[0].textContent,'Бесплатно');
  assert.equal(byTag(dialog,'script').length,0);
  assert.equal(byTag(dialog,'b').length,0);
  const water=byClass(dialog,'drink-addon-check')[0]; water.checked=true; await water.dispatch('change');
  assert.equal(normalizedText(byClass(panel,'drink-price')[0]),'350,5 ₽');
  assert.equal(normalizedText(byClass(dialog,'drink-addons-total-value')[0]),'350,5 ₽');
});

test('desktop and compact drink navigation stay in sync and compact choices close with focus restored', async () => {
  const payload = withDrinks([drinkDish(), drinkDish({id:'tea',name:'Чай',drink:{section:'Чай',variants:[{volumeMl:600,price:350}],addons:[]}})]);
  const app = await browser([response(200,payload), response(200,{...payload,items:[drinkDish()]})]);
  await app.filter('drinks');
  const panel=app.parts['drinks-menu'];
  const navigation=app.parts['menu-drink-nav'];
  const picker=byClass(navigation,'drinks-picker')[0];
  const summary=byClass(navigation,'drinks-picker-summary')[0];
  const compact=byClass(navigation,'drinks-picker-options')[0];
  const sections=byClass(panel,'drinks-sections')[0];
  const scrolled=[];
  sections.getBoundingClientRect=()=>({top:210});
  sections.scrollIntoView=options=>scrolled.push(options.block);
  app.parts['menu-filters'].getBoundingClientRect=()=>({bottom:230});
  picker.getBoundingClientRect=()=>({bottom:230});
  assert.equal(navigation.hidden,false);
  assert.equal(app.parts['menu-filters'].contains(picker),true,'The compact picker shares the main menu navigation');
  assert.equal(byClass(panel,'drinks-picker').length,0,'The compact picker does not leave a separate bar in the drink content');
  picker.open=true;
  await byClass(compact,'drinks-filter').find(button=>button.dataset.drinkSection==='Чай').dispatch('click');
  assert.equal(picker.open,false);
  assert.equal(summary.focused,true);
  assert.equal(summary.focusOptions.preventScroll,true);
  assert.equal(byClass(navigation,'drinks-picker-value')[0].textContent,'Чай');
  assert.deepEqual(byClass(panel,'drink-section').map(section=>section.hidden),[true,false]);
  assert.deepEqual([...byClass(panel,'drinks-filter'),...byClass(navigation,'drinks-filter')].filter(button=>button.getAttribute('aria-pressed')==='true').map(button=>button.dataset.drinkSection),['Чай','Чай']);
  assert.deepEqual(scrolled,['start'],'The selected section clears the sticky compact picker');
  picker.open=true; let prevented=false;
  await picker.dispatch('keydown',{key:'Escape',preventDefault:()=>{prevented=true;}});
  assert.equal(picker.open,false); assert.equal(prevented,true);
  await app.window.dispatch('focus');
  assert.equal(byClass(navigation,'drinks-picker-value')[0].textContent,'С молоком','A removed section falls back to the first remaining section');
  assert.deepEqual(byClass(panel,'drink-section').map(section=>section.hidden),[false]);
});

test('drink navigation starts with coffee and exposes names without counters or an all-drinks choice', async () => {
  const payload=withDrinks([
    dish(),
    drinkDish({id:'tea',name:'Чай',drink:{section:'Чай',variants:[{volumeMl:600,price:350}],addons:[]}}),
    drinkDish(),
    drinkDish({id:'espresso',name:'Эспрессо',drink:{section:'Кофе',variants:[{volumeMl:40,price:170}],addons:[]}}),
  ]);
  const app=await browser([response(200,payload),response(200,payload)]);
  await app.filter('drinks');
  const panel=app.parts['drinks-menu'];
  const navigation=app.parts['menu-drink-nav'];
  const desktop=byClass(panel,'drinks-filters')[0];
  const compact=byClass(navigation,'drinks-picker-options')[0];
  assert.equal(byClass(navigation,'drinks-picker-value')[0].textContent,'Кофе');
  assert.deepEqual(byClass(panel,'drink-section').filter(section=>!section.hidden).map(section=>byTag(section,'h4')[0].textContent),['Кофе']);
  for(const list of [desktop,compact]) {
    const buttons=byClass(list,'drinks-filter');
    assert.equal(buttons[0].textContent,'Кофе','Coffee is first even when another section precedes it in the payload');
    assert.deepEqual(buttons.map(button=>button.textContent).sort(),['Кофе','С молоком','Чай']);
    assert.ok(buttons.every(button=>button.dataset.drinkSection && button.textContent===button.getAttribute('aria-label')));
    assert.equal(byClass(list,'drinks-filter-count').length,0);
    assert.equal(buttons.some(button=>button.textContent==='Все напитки'),false);
  }
  assert.doesNotMatch(navigation.textContent,/Подгруппа/i);
  assert.match(byClass(navigation,'drinks-picker-summary')[0].textContent,/Выбрать/);
  await byClass(desktop,'drinks-filter').find(button=>button.dataset.drinkSection==='Чай').dispatch('click');
  assert.equal(byClass(navigation,'drinks-picker-value')[0].textContent,'Чай');
  await app.window.dispatch('focus');
  assert.equal(byClass(navigation,'drinks-picker-value')[0].textContent,'Чай','Refreshing preserves the guest’s section instead of resetting to coffee');
  await app.filter('breakfast');
  assert.equal(navigation.hidden,true);
  await app.filter('drinks');
  assert.equal(navigation.hidden,false);
  assert.equal(byClass(navigation,'drinks-picker-value')[0].textContent,'Чай');
});

test('saved drink section order and renames refresh both navigation layouts while keeping card choices', async () => {
  const coffee = drinkDish({id:'espresso',name:'Эспрессо',drink:{section:'Кофе',sectionOrder:2,variants:[{volumeMl:40,price:170}],addons:[]}});
  const milk = drinkDish();
  milk.drink.sectionOrder = 0;
  const tea = drinkDish({id:'tea',name:'Чай',drink:{section:'Чай',sectionOrder:1,variants:[{volumeMl:600,price:350}],addons:[]}});
  const initial = withDrinks([coffee,milk,tea]);
  const reordered = withDrinks([
    {...coffee,drink:{...coffee.drink,sectionOrder:1}},
    {...milk,drink:{...milk.drink,sectionOrder:2}},
    {...tea,drink:{...tea.drink,sectionOrder:0}},
  ]);
  const renamed = {...reordered,items:reordered.items.map(item=>item.id===milk.id
    ? {...item,drink:{...item.drink,section:'Молочные напитки'}} : item)};
  const app = await browser([response(200,initial),response(200,reordered),response(200,renamed)]);
  await app.filter('drinks');
  const panel = app.parts['drinks-menu'];
  const navigation = app.parts['menu-drink-nav'];
  const sectionNames = () => byClass(panel,'drink-section').map(section=>byTag(section,'h4')[0].textContent);
  const assertNavigation = expected => {
    assert.deepEqual(sectionNames(),expected);
    for (const target of [panel,navigation]) assert.deepEqual(byClass(target,'drinks-filter').map(button=>button.textContent),expected);
  };
  assertNavigation(['С молоком','Чай','Кофе']);
  assert.equal(byClass(navigation,'drinks-picker-value')[0].textContent,'С молоком','The saved first section takes precedence over the legacy coffee default');
  const card = byClass(panel,'drink-card').find(card=>card.dataset.drinkId===milk.id);
  await byClass(card,'drink-volume')[1].dispatch('click');
  const dialog = await openDrinkAddons(app,card);
  const addon = byClass(dialog,'drink-addon-check')[0];
  addon.checked = true;
  await addon.dispatch('change');
  assert.equal(normalizedText(byClass(card,'drink-price')[0]),'530 ₽');
  await closeDrinkAddons(dialog);

  await app.window.dispatch('focus');
  assertNavigation(['Чай','Кофе','С молоком']);
  assert.equal(byClass(navigation,'drinks-picker-value')[0].textContent,'С молоком','A reorder preserves the guest’s current section');
  assert.equal(byClass(panel,'drink-card').find(node=>node.dataset.drinkId===milk.id),card);
  assert.equal(normalizedText(byClass(card,'drink-price')[0]),'530 ₽');

  await app.window.dispatch('focus');
  assertNavigation(['Чай','Кофе','Молочные напитки']);
  assert.equal(byClass(navigation,'drinks-picker-value')[0].textContent,'Чай','A removed section name falls back to the new saved first section');
  await byClass(navigation,'drinks-filter').find(button=>button.dataset.drinkSection==='Молочные напитки').dispatch('click');
  assert.deepEqual(byClass(panel,'drink-section').filter(section=>!section.hidden).map(section=>byTag(section,'h4')[0].textContent),['Молочные напитки']);
  assert.equal(byClass(panel,'drink-card').find(node=>node.dataset.drinkId===milk.id),card);
  assert.equal(normalizedText(byClass(card,'drink-price')[0]),'530 ₽','Renaming only its section also preserves the drink selection');
  await byClass(card,'drink-volume')[0].dispatch('click');
  assert.equal(normalizedText(byClass(card,'drink-price')[0]),'390 ₽');
  await openDrinkAddons(app,card);
  assert.equal(addon.checked,true);
  addon.checked = false;
  await addon.dispatch('change');
  assert.equal(normalizedText(byClass(card,'drink-price')[0]),'230 ₽');
});

test('the compact drink picker closes on an outside pointer interaction, outside focus, and another main group', async () => {
  const app=await browser([response(200,withDrinks([dish(),drinkDish()]))]);
  await app.filter('drinks');
  const navigation=app.parts['menu-drink-nav'];
  const picker=byClass(navigation,'drinks-picker')[0];
  const summary=byClass(picker,'drinks-picker-summary')[0];
  picker.open=true;
  await app.document.dispatch('pointerdown',{target:summary});
  assert.equal(picker.open,true,'Clicks inside the picker are handled by its native controls');
  await app.document.dispatch('pointerdown',{target:app.parts['drinks-menu']});
  assert.equal(picker.open,false);
  picker.open=true;
  await app.document.dispatch('focusin',{target:app.parts['menu-roots']});
  assert.equal(picker.open,false,'Keyboard navigation out of the picker closes its choices');
  picker.open=true;
  await app.filter('breakfast');
  assert.equal(navigation.hidden,true);
  assert.equal(picker.open,false,'Returning to drinks must not reopen a stale popover');
});

test('bottom navigation is active only while the menu is visible on a phone and selected sections return into view', async () => {
  const payload=withDrinks([dish(),drinkDish(),drinkDish({id:'coffee',name:'Эспрессо',drink:{section:'Кофе',variants:[{volumeMl:40,price:170}],addons:[]}})]);
  const app=await browser([response(200,payload)],undefined,{mobile:true});
  assert.equal(app.root.dataset.mobileMenuReady,'true');
  assert.equal(app.intersections.length,1);
  const observer=app.intersections[0];
  assert.equal(observer.target,app.root,'Bottom controls follow the menu section, not the whole document');
  observer.emit(false);
  assert.equal(app.root.dataset.menuDocked,'false');
  observer.emit(true);
  assert.equal(app.root.dataset.menuDocked,'true');
  const heading=app.parts['menu-category-title'];
  const scrolled=[];
  heading.getBoundingClientRect=()=>({top:400});
  heading.scrollIntoView=options=>scrolled.push({target:'heading',block:options.block});
  app.parts['menu-filters'].getBoundingClientRect=()=>({bottom:300});
  await app.filter('drinks');
  assert.deepEqual(scrolled,[{target:'heading',block:'start'}],'A bottom-menu selection returns to the selected content even when its heading was below the top toolbar');
  const panel=app.parts['drinks-menu'];
  const picker=byClass(app.parts['menu-drink-nav'],'drinks-picker')[0];
  const sections=byClass(panel,'drinks-sections')[0];
  sections.getBoundingClientRect=()=>({top:600});
  sections.scrollIntoView=options=>scrolled.push({target:'drinks',block:options.block});
  await byClass(picker,'drinks-filter').find(button=>button.dataset.drinkSection==='С молоком').dispatch('click');
  assert.deepEqual(scrolled[1],{target:'drinks',block:'start'});
  picker.open=true;
  observer.emit(false);
  assert.equal(app.root.dataset.menuDocked,'false');
  assert.equal(picker.open,false,'Leaving the menu removes an open drink picker with its bottom controls');
  observer.emit(true);
  picker.open=true;
  app.media.matches=false;
  await app.media.dispatch('change');
  assert.equal(app.root.dataset.menuDocked,'false','A wide viewport uses normal navigation even when the menu is visible');
  assert.equal(picker.open,false,'Changing the responsive layout closes its old popup');
  await app.filter('breakfast');
  assert.equal(scrolled.length,2,'Desktop filtering does not unexpectedly scroll a visible result heading');
});

test('a phone without intersection observation keeps working navigation without enabling a permanent bottom bar', async () => {
  const app=await browser([response(200,withDrinks([drinkDish()]))],undefined,{mobile:true,intersection:false});
  assert.notEqual(app.root.dataset.mobileMenuReady,'true');
  assert.notEqual(app.root.dataset.menuDocked,'true');
  await app.filter('drinks');
  assert.equal(app.parts['menu-drink-nav'].hidden,false);
  assert.equal(byClass(app.parts['drinks-menu'],'drink-card').length,1);
});

test('drinks with optional photos share one ordered grid and failed images preserve the card controls', async () => {
  const description='<script>описание</script> с молоком';
  const pictured=drinkDish({id:'latte',name:'Латте',image:'/uploads/latte.webp',description,order:2});
  const plain=drinkDish({order:1});
  const noDescription=drinkDish({id:'flat-white',name:'Флэт уайт',image:'/menu-images/flat-white.webp',order:3});
  const app=await browser([
    response(200,withDrinks([noDescription,plain,pictured])),
    response(200,withDrinks([plain,{...pictured,image:''},noDescription])),
  ]);
  await app.filter('drinks');
  const panel=app.parts['drinks-menu'];
  const grid=byClass(panel,'drink-photo-list')[0];
  assert.deepEqual(grid.children.map(card=>card.dataset.drinkId),['cappuccino','latte','flat-white']);
  assert.equal(byClass(panel,'drink-list').length,0);
  assert.equal(byClass(panel,'drink-card').length,3);
  const plainCard=grid.children[0];
  const picturedCard=grid.children[1];
  const picturedBody=byClass(picturedCard,'drink-body')[0];
  const plainPlaceholder=assertDrinkPlaceholder(plainCard);
  assert.equal(byClass(picturedCard,'drink-description')[0].textContent,description);
  assert.equal(byTag(panel,'script').length,0);
  assert.equal(byClass(grid.children[2],'drink-description').length,0);
  const photo=byTag(picturedCard,'img')[0];
  assert.equal(photo.src,'https://cafe.example/uploads/latte.webp');
  assert.equal(photo.alt,'Латте'); assert.equal(photo.loading,'lazy');
  await byClass(picturedCard,'drink-volume')[1].dispatch('click');
  const dialog=await openDrinkAddons(app,picturedCard);
  const addon=byClass(dialog,'drink-addon-check')[0];
  addon.checked=true;
  await addon.dispatch('change');
  assert.equal(normalizedText(byClass(picturedCard,'drink-price')[0]),'530 ₽');
  await photo.dispatch('error');
  const failed=assertDrinkPlaceholder(picturedCard);
  assert.equal(failed.mark.className,plainPlaceholder.mark.className);
  assert.equal(byClass(picturedCard,'drink-body')[0],picturedBody);
  assert.equal(normalizedText(byClass(picturedCard,'drink-price')[0]),'530 ₽','A broken photo does not reset the chosen volume or additions');
  assert.equal(byClass(dialog,'drink-addon-check')[0],addon);
  assert.equal(addon.checked,true);
  assert.equal(grid.children[1],picturedCard);
  await photo.dispatch('error');
  assert.equal(byClass(failed.visual,'dish-placeholder-mark').length,1);
  await closeDrinkAddons(dialog);
  await byClass(plainCard,'drink-volume')[1].dispatch('click');
  await app.window.dispatch('focus');
  const refreshed=byClass(panel,'drink-photo-list')[0];
  assert.deepEqual(refreshed.children.map(card=>card.dataset.drinkId),['cappuccino','latte','flat-white']);
  assert.equal(byClass(panel,'drink-list').length,0);
  assert.equal(byClass(panel,'drink-card').length,3);
  assertDrinkPlaceholder(refreshed.children[1]);
  assert.equal(refreshed.children[0],plainCard);
  assert.equal(assertDrinkPlaceholder(plainCard).mark,plainPlaceholder.mark);
  assert.equal(normalizedText(byClass(plainCard,'drink-price')[0]),'370 ₽','Photo edits preserve another drink’s selected size');
});

test('static preview resolves drink photos inside the hosted repository directory', async () => {
  const app=await browser([response(404),response(200,withDrinks([drinkDish({image:'/menu-images/coffee.webp'})]))], 'https://general-fox.github.io/vosem-utra-preview/');
  await app.filter('drinks');
  assert.equal(byTag(app.parts['drinks-menu'],'img')[0].src,'https://general-fox.github.io/vosem-utra-preview/menu-images/coffee.webp');
  assert.equal(byClass(app.parts['drinks-menu'],'drink-photo-list')[0].children.length,1);
  assert.equal(byClass(app.parts['drinks-menu'],'drink-list').length,0);
});

test('a drink section containing only missing photos still renders complete landscape-placeholder cards', async () => {
  const items=[
    drinkDish({id:'last',name:'Последний напиток',order:3}),
    drinkDish({id:'first',name:'Первый напиток',order:1}),
    drinkDish({id:'middle',name:'Средний напиток',order:2}),
  ];
  const payload=withDrinks(items);
  const app=await browser([response(200,payload),response(200,payload)]);
  await app.filter('drinks');
  const panel=app.parts['drinks-menu'];
  const grid=byClass(panel,'drink-photo-list')[0];
  assert.equal(grid.hidden,false);
  assert.deepEqual(grid.children.map(card=>card.dataset.drinkId),['first','middle','last']);
  assert.equal(byClass(panel,'drink-list').length,0);
  const cards=[...grid.children];
  const marks=cards.map(card=>assertDrinkPlaceholder(card).mark);
  await byClass(cards[1],'drink-volume')[1].dispatch('click');
  await app.window.dispatch('focus');
  await app.filter('breakfast');
  await app.filter('drinks');
  assert.deepEqual(byClass(panel,'drink-photo-list')[0].children,cards);
  for(let index=0;index<cards.length;index++) assert.equal(assertDrinkPlaceholder(cards[index]).mark,marks[index]);
  assert.equal(normalizedText(byClass(cards[1],'drink-price')[0]),'370 ₽');
  const css=readFileSync(new URL('../menu.css',import.meta.url),'utf8');
  assert.match(css,/\.drink-visual\s*\{[^}]*aspect-ratio:\s*4\/3(?:;|\})/);
  assert.match(css,/\.drink-placeholder\s*\{[^}]*place-items:\s*center/);
});

test('gallery photos resolve in order for live, built and source-folder catalogs', async () => {
  const item=dish({images:['/menu-images/second.webp','/uploads/first.webp'],image:'/menu-images/old.webp'});
  for(const mode of ['live','built','source']) {
    const replies=[...(mode!=='live'?[response(404)]:[]),...(mode==='source'?[response(404)]:[]),response(200,{items:[item]})];
    const app=await browser(replies,'https://cafe.example/preview/',null,'catalog');
    const card=app.cards()[0];
    const prefix=`https://cafe.example/preview/${mode==='source'?'public/':''}`;
    assert.deepEqual(byTag(card,'img').map(image=>image.src),[prefix+'menu-images/second.webp',prefix+'uploads/first.webp']);
    assert.equal(byClass(card,'menu-gallery-dot').length,2);
    assert.equal(byClass(card,'dish-cart-actions').length,0,'Gallery does not enable ordering');
    assert.equal(byClass(card,'menu-gallery-dot')[0].getAttribute('aria-pressed'),'true');
  }
});

test('card gallery keeps dots, native scrolling and keyboard without arrow buttons', async () => {
  const app=await browser([response(200,{items:[dish({images:['/menu-images/a.webp','/menu-images/b.webp','/menu-images/c.webp']})]})]);
  const card=app.cards()[0], track=byClass(card,'menu-gallery-track')[0];track.clientWidth=300;
  const dots=byClass(card,'menu-gallery-dot');
  assert.equal(byClass(card,'menu-gallery-arrow').length,0,'Desktop card navigation uses hover and dots');
  await dots[1].dispatch('click');assert.equal(track.scrollLeft,300);assert.equal(dots[1].getAttribute('aria-pressed'),'true');
  await dots[2].dispatch('click');assert.equal(track.scrollLeft,600);
  track.scrollLeft=0;await track.dispatch('scroll');assert.equal(dots[0].getAttribute('aria-pressed'),'true');
  await track.dispatch('keydown',{key:'End'});assert.equal(track.scrollLeft,600);
  await track.dispatch('keydown',{key:'ArrowLeft'});assert.equal(track.scrollLeft,300);
  app.window.matchMedia=()=>({matches:true});
  await track.dispatch('keydown',{key:'Home'});assert.equal(track.scrollOptions.behavior,'instant');
  assert.equal(track.scrollLeft,0);
});

test('desktop hover selects horizontal photo zones instantly and resets only a hovered preview', async () => {
  const app=await browser([response(200,{items:[dish({images:['/menu-images/a.webp','/menu-images/b.webp','/menu-images/c.webp']})]})]);
  app.window.matchMedia=query=>({matches:query.includes('hover')});
  const card=app.cards()[0], visual=byClass(card,'dish-visual')[0],track=byClass(card,'menu-gallery-track')[0];track.clientWidth=300;
  visual.getBoundingClientRect=()=>({left:100,width:300});
  const hover=x=>visual.dispatch('pointermove',{pointerType:'mouse',clientX:x,buttons:0,target:track});
  await hover(350);assert.equal(track.scrollLeft,600);assert.equal(track.scrollOptions.behavior,'instant');
  assert.equal(visual.dataset.galleryIndex,'2');
  await hover(200);assert.equal(track.scrollLeft,300,'Zone boundary selects the next image');
  await hover(90);assert.equal(visual.dataset.galleryIndex,'0','Out-of-range coordinates clamp');
  await hover(410);assert.equal(visual.dataset.galleryIndex,'2');
  assert.equal(byClass(app.document,'dish-details-dialog').length,0,'Hover never opens the modal');
  await visual.dispatch('pointerleave');assert.equal(track.scrollLeft,0);
  await byClass(card,'menu-gallery-dot')[2].dispatch('click');await visual.dispatch('pointerleave');
  assert.equal(track.scrollLeft,600,'Leaving after a deliberate dot selection preserves it');
  await track.dispatch('keydown',{key:'ArrowLeft'});await hover(390);await visual.dispatch('pointerleave');
  assert.equal(track.scrollLeft,300,'Keyboard navigation takes precedence over a stationary mouse');
});

test('touch and coarse pointers keep native gallery scrolling, never hover or reset on leave', async () => {
  const app=await browser([response(200,{items:[dish({images:['/menu-images/a.webp','/menu-images/b.webp']})]})]);
  const card=app.cards()[0], visual=byClass(card,'dish-visual')[0],track=byClass(card,'menu-gallery-track')[0];track.clientWidth=300;
  visual.getBoundingClientRect=()=>({left:0,width:300});app.window.matchMedia=()=>({matches:true});
  await visual.dispatch('pointermove',{pointerType:'touch',clientX:290});assert.equal(visual.dataset.galleryIndex,'0');
  await visual.dispatch('pointermove',{pointerType:'pen',clientX:290});assert.equal(visual.dataset.galleryIndex,'0');
  app.window.matchMedia=()=>({matches:false});await visual.dispatch('pointermove',{pointerType:'mouse',clientX:290});assert.equal(visual.dataset.galleryIndex,'0');
  await track.dispatch('pointerdown',{pointerType:'touch'});track.scrollLeft=300;await track.dispatch('scroll');await visual.dispatch('pointerleave');
  assert.equal(visual.dataset.galleryIndex,'1');assert.equal(track.scrollLeft,300);
});

test('dish detail photos load eagerly and keep hover, dots and real slide positions without arrows', async () => {
  const app=await browser([response(200,{items:[dish({images:['/menu-images/a.webp','/menu-images/b.webp']})]})]);
  app.window.matchMedia=query=>({matches:query.includes('hover')});
  const trigger=byClass(app.cards()[0],'dish-details-button')[0];await trigger.dispatch('click');
  const dialog=byClass(app.document,'dish-details-dialog')[0],visual=byClass(dialog,'dish-details-photos')[0];
  const track=byClass(dialog,'menu-gallery-track')[0];track.clientWidth=300;
  track.children[0].offsetLeft=0;track.children[1].offsetLeft=301;
  visual.getBoundingClientRect=()=>({left:0,width:300});
  const photos=byTag(visual,'img');assert.ok(photos.every(photo=>photo.loading==='eager'));
  assert.equal(byClass(dialog,'menu-gallery-arrow').length,0);
  await visual.dispatch('pointermove',{pointerType:'mouse',clientX:290,buttons:0,target:track});
  assert.equal(track.scrollLeft,301,'Use the real slide position including its gap');
  await visual.dispatch('pointerleave');assert.equal(track.scrollLeft,0);
  await byClass(dialog,'menu-gallery-dot')[1].dispatch('click');assert.equal(track.scrollLeft,301,'Use the real slide position including its gap');
  await byClass(dialog,'dish-details-close')[0].dispatch('click');
  assert.equal(track.listeners.get('scroll').length,0,'Closing releases the old gallery listeners');
  await trigger.dispatch('click');const current=byTag(visual,'img');
  assert.ok(current.every(photo=>photo.loading==='eager'));
  await current[1].dispatch('error');
  assert.equal(byTag(visual,'img').length,1,'A failed photo keeps the other photo available');
  assert.equal(byClass(dialog,'menu-gallery-dot').length,2);
});

test('only prepared wide images receive the filled-background display marker', async () => {
  const app=await browser([response(200,{items:[dish({images:['/menu-images/a.webp','/menu-images/a-wide-filled.webp']})]})]);
  const photos=byTag(app.cards()[0],'img');
  assert.equal(photos[0].classList.contains('menu-photo-filled'),false);
  assert.equal(photos[1].classList.contains('menu-photo-filled'),true);
});

test('gallery preserves order on refresh, updates reordered photos, and clears to a placeholder', async () => {
  const images=['/menu-images/a.webp','/menu-images/b.webp'];
  const original={items:[dish({images})]};
  const app=await browser([response(200,original),response(200,original),response(200,{items:[dish({images:[...images].reverse()})]}),response(200,{items:[dish({images:[]})]})]);
  const card=app.cards()[0], track=byClass(card,'menu-gallery-track')[0];track.clientWidth=300;
  await byClass(card,'menu-gallery-dot')[1].dispatch('click');
  await app.window.dispatch('focus');assert.equal(app.cards()[0],card);assert.equal(track.scrollLeft,300);
  await app.window.dispatch('focus');assert.notEqual(app.cards()[0],card);assert.equal(byTag(app.cards()[0],'img')[0].src,'https://cafe.example/menu-images/b.webp');
  assert.equal(track.listeners.get('scroll').length,0,'Replaced gallery disposes its listeners');
  await app.window.dispatch('focus');assertDishPlaceholder(app.cards()[0]);
});

test('one missing gallery image does not hide other photographs or shift the card', async () => {
  const app=await browser([response(200,{items:[dish({images:['/menu-images/a.webp','/menu-images/b.webp']})]})]);
  const card=app.cards()[0], visual=byClass(card,'dish-visual')[0], images=byTag(card,'img');
  await images[0].dispatch('error');
  assert.equal(byClass(card,'dish-visual')[0],visual);
  assert.deepEqual(byTag(card,'img'),[images[1]]);
  assert.equal(byClass(card,'menu-gallery-dot').length,2);
  assert.equal(byClass(card,'dish-placeholder-mark').length,1);
});

test('drink galleries retain square visuals and additions when images are reordered', async () => {
  const images=['/menu-images/a.webp','/menu-images/b.webp'];
  const app=await browser([response(200,withDrinks([drinkDish({images})])),response(200,withDrinks([drinkDish({images:[...images].reverse()})]))],undefined,null,'catalog');
  await app.filter('drinks');
  let card=byClass(app.parts['drinks-menu'],'drink-card')[0];
  assert.equal(byClass(card,'drink-visual').length,1);assert.equal(byClass(card,'dish-visual').length,0);
  assert.equal(byClass(card,'menu-gallery-dot').length,2);
  const volume=byClass(card,'drink-volume')[1];if(volume)await volume.dispatch('click');
  await app.window.dispatch('focus');
  card=byClass(app.parts['drinks-menu'],'drink-card')[0];
  assert.equal(byTag(card,'img')[0].src,'https://cafe.example/menu-images/b.webp');
  if(volume)assert.equal(byClass(card,'drink-volume')[1].getAttribute('aria-pressed'),'true');
  assert.ok(byClass(card,'drink-addons-title').length);
});


test('catalog dish details separate composition, nutrition and confirmed allergens without enabling ordering', async () => {
  const info = dish({ images:['/menu-images/eggs.webp','/menu-images/eggs-wide.webp'], description:'Яйцо, хлеб и зелень.\nКБЖУ: 450/20/15/40', allergens:'Яйца, пшеница' });
  const app = await browser([response(200, {items:[info]})], 'https://cafe.example/', null, 'catalog');
  const card = app.cards()[0];
  assert.equal(byClass(card, 'dish-description')[0].textContent, 'Яйцо, хлеб и зелень.');
  assert.equal(byClass(card, 'dish-order-button').length, 0);
  const trigger = byClass(card, 'dish-details-button')[0];
  trigger.focus(); await trigger.dispatch('click');
  const dialog = byClass(app.document, 'dish-details-dialog')[0];
  assert.equal(dialog.open, true);
  assert.equal(byClass(dialog, 'dish-details-title')[0].textContent, info.name);
  assert.equal(byClass(dialog, 'dish-details-nutrition')[0].textContent, 'КБЖУ450/20/15/40');
  assert.equal(byClass(dialog, 'dish-details-allergens')[0].textContent, 'АллергеныЯйца, пшеница');
  assert.equal(byTag(dialog, 'img').length, 2);
  assert.equal(app.document.body.style.position, 'fixed');
  await dialog.dispatch('cancel');
  assert.equal(dialog.open, false);
  assert.ok(app.document.activeElement === trigger, 'Focus returns to the details button');
  assert.notEqual(app.document.body.style.position, 'fixed');
  const allergen = byClass(card, 'dish-allergen-button')[0];
  await allergen.dispatch('click');
  assert.equal(allergen.getAttribute('aria-expanded'), 'true');
  assert.equal(dialog.open, false, 'Allergen tap only shows the tooltip');
  await allergen.dispatch('blur');
  assert.equal(allergen.getAttribute('aria-expanded'), 'false');
});

test('dish cards do not invent allergens or nutrition and exclude swipes and gallery controls from modal opening', async () => {
  const app = await browser([response(200, {items:[dish({images:['/menu-images/eggs.webp','/menu-images/eggs-wide.webp']})]})]);
  const card = app.cards()[0];
  assert.equal(byClass(card,'dish-allergen-button').length,0);
  const track = byClass(card,'menu-gallery-track')[0];
  await card.dispatch('pointerdown',{clientX:200,clientY:150});
  await card.dispatch('pointermove',{clientX:80,clientY:153});
  await card.dispatch('pointerup',{clientX:80,clientY:153});
  await card.dispatch('click',{target:track});
  assert.equal(byClass(app.document,'dish-details-dialog').length,0);
  await card.dispatch('click',{target:byClass(card,'menu-gallery-dot')[0]});
  assert.equal(byClass(app.document,'dish-details-dialog').length,0);
  await byClass(card,'dish-details-button')[0].dispatch('click');
  const dialog=byClass(app.document,'dish-details-dialog')[0];
  assert.equal(dialog.open,true,'Explicit details remains usable after a swipe');
  assert.equal(byClass(dialog,'dish-details-allergens').length,0);
  assert.equal(byClass(dialog,'dish-details-nutrition').length,0);
  await dialog.dispatch('pointerdown',{clientX:1,clientY:1});
  await dialog.dispatch('click',{clientX:1,clientY:1});
  assert.equal(dialog.open,false,'Only a click beginning and ending on the backdrop closes it');
});

test('dish details use separate nutrition in preference to a legacy description tail', () => {
  assert.deepEqual(dishInformation({description:'Творог. кБЖУ: 500/10/20/30',nutrition:'КБЖУ: 450/20/15/40'}), {
    composition:'Творог.', nutrition:'450/20/15/40',allergens:''
  });
});


test('explicitly cleared nutrition does not return from the legacy description tail', () => {
  assert.deepEqual(dishInformation({description:'Творог. КБЖУ: 500/10/20/30',nutrition:''}), {composition:'Творог.',nutrition:'',allergens:''});
});
