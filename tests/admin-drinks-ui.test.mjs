import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { normalizeMenuCategories, normalizeMenuData, categoryDescendantIds, categoryPath, orderedCategories } from '../menu-categories.js';
import { normalizeDrink, orderedDrinkSections } from '../menu-drinks-model.js';
import { createDrinkSectionManager, applyDrinkSectionEdits, drinkSectionOrderForItem } from '../admin-drink-sections.js';

const source = await readFile(new URL('../admin.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../admin.html', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const menu = () => ({ revision: 'r1', sourceCategories: [], categories: [
  { id: 'breakfast', name: 'Завтраки', parentId: null, order: 0 },
  { id: 'drinks', name: 'Напитки', parentId: null, order: 1 },
], items: [
  { id: 'breakfast-one', name: 'Каша', description: 'С ягодами', price: 400, category: 'breakfast', image: '', order: 0, published: true },
  { id: 'coffee', name: 'Капучино', description: 'Кофе с молоком', price: 250, category: 'drinks', image: 'menu-images/coffee.jpg', order: 7, hiddenOnSite: true, published: false,
    drink: { section: 'Кофе', variants: [{ volumeMl: 200, price: 250 }, { volumeMl: 350, price: 320 }], addons: [{ name: 'Сироп', price: 60 }], childFriendly: false } },
] });

function sectionMenu() {
  const data = menu();
  data.sourceCategories.push({ id: 'bar', name: 'Бар', parentId: null, order: 0,
    source: { provider: 'kds', organizationId: 'demo', externalId: 'bar' } });
  const coffee = data.items[1];
  coffee.drink.sectionOrder = 0;
  coffee.source = { provider: 'kds', organizationId: 'demo', externalId: 'coffee', groupExternalId: 'bar' };
  data.items.push({ ...plain(coffee), id: 'espresso', name: 'Эспрессо', image: '', hiddenOnSite: false, published: true,
    source: { ...coffee.source, externalId: 'espresso' }, drink: { ...plain(coffee.drink), variants: [{ volumeMl: 30, price: 150 }], addons: [] } });
  data.items.push({ ...plain(coffee), id: 'tea', name: 'Чёрный чай', hiddenOnSite: false, published: true,
    source: { ...coffee.source, externalId: 'tea' }, drink: { ...plain(coffee.drink), section: 'Чай', sectionOrder: 1 } });
  data.items.push({ ...plain(coffee), id: 'juice', name: 'Апельсиновый сок',
    source: { ...coffee.source, externalId: 'juice' }, drink: { ...plain(coffee.drink), section: 'Соки', sectionOrder: 2 } });
  data.items.push({ ...plain(coffee), id: 'breakfast-coffee', name: 'Кофе к завтраку', category: 'breakfast',
    source: { ...coffee.source, externalId: 'breakfast-coffee' } });
  return data;
}

// Run actual admin handlers against in-memory HTML nodes and a fake JSON API.
async function page(profile = 'catalog', { preparePhoto = async file => file } = {}) {
  const nodes = new Map(), calls = [], confirmations = [];
  const responses = [{ body: { authenticated: false, configured: true, authMode: 'password' } }];
  const document = { activeElement: null, visibilityState: 'visible', addEventListener() {}, querySelectorAll: selector => [...nodes.values()].flatMap(root => root.querySelectorAll(selector)),
    getElementById(id) { assert.ok(nodes.has(id), `Missing HTML element: ${id}`); return nodes.get(id); },
    createElement: tag => node(new Map(), tag), createElementNS: (_, tag) => node(new Map(), tag) };
  function node(attributes = new Map(), tag = 'div') {
    let value = attributes.get('value') || '';
    const handlers = new Map(), classes = new Set();
    const matches = (element, selector) => selector.split(',').some(part => {
      part = part.trim();
      const tagName = part.match(/^[a-z][a-z\d-]*/i)?.[0];
      if (tagName && element.tagName !== tagName.toUpperCase()) return false;
      const data = [...part.matchAll(/\[data-([\w-]+)(?:="([^"]*)")?\]/g)];
      if (data.some(([, raw, expected]) => {
        const key = raw.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
        return !Object.hasOwn(element.dataset, key) || (expected !== undefined && element.dataset[key] !== expected);
      })) return false;
      const className = part.match(/\.([\w-]+)/)?.[1];
      return !className || element.classList.contains(className);
    });
    const walk = current => current.children.flatMap(child => [child, ...walk(child)]);
    return { attributes, handlers, children: [], dataset: {}, tagName: tag.toUpperCase(), parentElement: null,
      hidden: false, disabled: false, checked: false, open: false, textContent: '',
      get value() { return value; }, set value(next) { value = String(next); },
      setAttribute(name, next) { attributes.set(name, String(next)); }, getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); }, toggleAttribute(name, force) { if (force) attributes.set(name, ''); else attributes.delete(name); },
      addEventListener(name, handler) { handlers.set(name, handler); }, focus() { document.activeElement = this; },
      close() { this.open = false; }, showModal() { this.open = true; }, reset() {},
      append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } },
      replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.append(...children); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      querySelectorAll(selector) { return walk(this).filter(current => matches(current, selector)); },
      closest(selector) { for (let current = this; current; current = current.parentElement) if (matches(current, selector)) return current; return null; },
      contains(element) { return this === element || walk(this).includes(element); },
      style: { removeProperty(name) { delete this[name]; } }, scrollTop: 0,
      classList: { toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
        add(...names) { names.forEach(name => classes.add(name)); }, remove(...names) { names.forEach(name => classes.delete(name)); }, contains: name => classes.has(name) } };
  }
  for (const match of html.matchAll(/<([a-z][a-z\d-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    nodes.set(match[3], node(new Map([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(entry => [entry[1], entry[2]])), match[1]));
  }
  nodes.get('site-profile').setAttribute('content', profile);
  class PreviewURL extends URL { static createObjectURL() { return 'blob:preview'; } static revokeObjectURL() {} }
  const context = vm.createContext({ document, Intl, URL: PreviewURL, AbortController, normalizeMenuCategories, normalizeMenuData,
    categoryDescendantIds, categoryPath, orderedCategories, orderedDrinkSections, createDrinkSectionManager, drinkSectionOrderForItem, crypto: { randomUUID: () => 'new-drink' },
    setTimeout: () => 1, clearTimeout() {}, location: { href: 'https://example.test/admin.html', origin: 'https://example.test' },
    window: { addEventListener() {}, confirm(text) { confirmations.push(text); return true; } },
    __loadDrinkModel: async () => ({ normalizeDrink, orderedDrinkSections }),
    __loadPhotoModel: async () => ({ prepareAdminPhoto: preparePhoto }),
    fetch: async (url, options) => {
      calls.push({ url, ...options, body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body });
      const response = responses.shift(); assert.ok(response, `Unexpected request: ${url}`);
      const status = response.status || 200;
      return { ok: status < 400, status, headers: { get: name => name === 'content-type' ? 'application/json' : null }, json: async () => response.body };
    } });
  const code = source.replace(/^import .* from '\.\/(?:menu-categories|menu-drinks-model|admin-drink-sections)\.js';\r?\n/gm, '')
    .replace("await import('./menu-drinks-model.js')", 'await __loadDrinkModel()')
    .replace("await import('./admin-photo.js')", 'await __loadPhotoModel()');
  const app = await new vm.Script(`(async () => {${code}\nreturn {state,draft,idle,drinkEditor,categoryDraft,validateMenu,openEditor,openCategoryManager,render};})()`)
    .runInContext(context);
  return { ...app, calls, responses, confirmations, document, node: id => document.getElementById(id),
    async trigger(id, name = 'click', values = {}) { const handler = document.getElementById(id).handlers.get(name); assert.ok(handler); await handler({ preventDefault() {}, ...values }); },
    async rowEvent(input, name = 'input') { await input.handlers.get(name)?.({}); },
    reply(data) { responses.push({ body: data }); } };
}

test('editing an existing drink retains variants, extras, image, group and hidden status while syncing its first price', async () => {
  const app = await page(); app.validateMenu(menu()); app.openEditor(app.state.items[1]);
  assert.equal(app.node('item-kind').value, 'drink'); assert.equal(app.node('price').disabled, true);
  assert.equal(app.node('drink-fields').hidden, false); assert.equal(app.node('drink-addons-details').open, true);
  assert.equal(app.drinkEditor.variants.length, 2); assert.equal(app.drinkEditor.addons.length, 1);
  assert.deepEqual(app.node('drink-sections').children.map(option => option.value), ['Кофе']);
  app.node('item-name').value = 'Капучино на овсяном'; app.drinkEditor.variants[0].price.value = '275.50';
  await app.rowEvent(app.drinkEditor.variants[0].price); assert.equal(app.node('price').value, '275.50');
  app.node('drink-child-friendly').checked = true;
  const expected = menu(); expected.items[1].name = 'Капучино на овсяном'; expected.items[1].price = 275.5;
  expected.items[1].drink.variants[0].price = 275.5; expected.items[1].drink.childFriendly = true;
  app.reply(expected); await app.trigger('item-form', 'submit');
  const saved = app.calls.at(-1).body.items[1];
  assert.equal(saved.price, 275.5); assert.deepEqual(saved.drink, expected.items[1].drink);
  assert.equal(saved.hiddenOnSite, true); assert.equal(saved.published, false); assert.equal(saved.category, 'drinks');
  assert.equal(saved.image, 'menu-images/coffee.jpg'); assert.equal(saved.order, 7); assert.equal(app.node('editor-dialog').open, false);
});

test('new drinks and repeatable rows have bounded counts; removing the first volume updates the base price', async () => {
  const app = await page(); app.validateMenu(menu()); app.openEditor(); app.node('price').value = '150';
  app.node('item-kind').value = 'drink'; await app.trigger('item-kind', 'change');
  assert.equal(app.drinkEditor.variants[0].price.value, '150'); assert.equal(app.drinkEditor.variants[0].remove.disabled, true);
  app.node('item-name').value = 'Какао'; app.node('drink-section').value = 'Для детей'; app.node('drink-child-friendly').checked = true;
  app.drinkEditor.variants[0].volumeMl.value = '200';
  await app.trigger('add-drink-variant'); app.drinkEditor.variants[1].volumeMl.value = '300'; app.drinkEditor.variants[1].price.value = '220';
  await app.rowEvent(app.drinkEditor.variants[0].remove, 'click'); assert.equal(app.node('price').value, '220');
  for (let i = 0; i < 12; i++) await app.trigger('add-drink-variant');
  assert.equal(app.drinkEditor.variants.length, 10); assert.equal(app.node('add-drink-variant').disabled, true);
  while (app.drinkEditor.variants.length > 1) await app.rowEvent(app.drinkEditor.variants.at(-1).remove, 'click');
  for (let i = 0; i < 15; i++) await app.trigger('add-drink-addon');
  assert.equal(app.drinkEditor.addons.length, 12); assert.equal(app.node('add-drink-addon').disabled, true);
  while (app.drinkEditor.addons.length) await app.rowEvent(app.drinkEditor.addons[0].remove, 'click');
  const expected = menu(); expected.items.push({ id: 'new-drink', name: 'Какао', description: '', price: 220, category: 'breakfast', order: 8,
    image: '', hiddenOnSite: false, published: true, drink: { section: 'Для детей', variants: [{ volumeMl: 300, price: 220 }], addons: [], childFriendly: true } });
  app.reply(expected); await app.trigger('item-form', 'submit');
  assert.equal(app.calls.at(-1).method, 'PUT'); assert.deepEqual(app.calls.at(-1).body.items.at(-1).drink, expected.items.at(-1).drink);
});

test('invalid drink input never sends a menu request and focuses the conflicting field', async () => {
  const app = await page(); app.validateMenu(menu()); app.openEditor(app.state.items[1]);
  const before = app.calls.length;
  app.drinkEditor.variants[1].volumeMl.value = '200'; await app.trigger('item-form', 'submit');
  assert.equal(app.calls.length, before); assert.match(app.node('editor-error').textContent, /повторяться/);
  assert.equal(app.document.activeElement, app.drinkEditor.variants[1].volumeMl);
  app.drinkEditor.variants[1].volumeMl.value = '350'; app.drinkEditor.variants[0].price.value = '';
  await app.trigger('item-form', 'submit'); assert.equal(app.calls.length, before); assert.match(app.node('editor-error').textContent, /цену/);
  app.drinkEditor.variants[0].price.value = '250'; app.node('drink-section').value = ' ';
  await app.trigger('item-form', 'submit'); assert.equal(app.calls.length, before); assert.match(app.node('editor-error').textContent, /Подгруппа/);
});

test('switching back to a dish clears beverage metadata without submitting hidden beverage fields', async () => {
  const app = await page(); app.validateMenu(menu()); app.openEditor(app.state.items[1]);
  app.node('item-kind').value = 'dish'; await app.trigger('item-kind', 'change');
  assert.equal(app.node('drink-fields').disabled, true); assert.equal(app.node('price').disabled, false);
  const result = menu(); delete result.items[1].drink; app.reply(result);
  await app.trigger('item-form', 'submit'); assert.equal(app.calls.at(-1).body.items[1].drink, undefined);
});

test('visibility changes and flat group reorder preserve the complete beverage metadata', async () => {
  const app = await page(); app.validateMenu(menu());
  const original = plain(app.state.items[1].drink); const shown = menu(); shown.items[1].hiddenOnSite = false; app.reply(shown);
  await app.trigger('items', 'click', { target: { closest: () => ({ dataset: { itemAction: 'visibility', itemId: 'coffee' } }) } });
  assert.deepEqual(app.calls.at(-1).body.items[1].drink, original);
  app.openCategoryManager();
  await app.trigger('category-sort-list', 'click', { target: { closest: selector => selector.includes('data-group-move') ? { dataset: { groupMove: 'drinks', direction: '-1' } } : null } });
  app.reply({ ...shown, categories: plain(app.categoryDraft.categories), revision: 'r2' });
  await app.trigger('categories-form', 'submit');
  assert.deepEqual(app.calls.at(-1).body.items[1].drink, original);
  assert.ok(app.calls.at(-1).body.categories.every(group => group.parentId === null));
  assert.equal(app.calls.at(-1).body.categories[0].id, 'drinks');
});

test('catalog import uses CSRF and revision, then hides its button; delivery and repeated imports are blocked', async () => {
  const initial = menu(); initial.items.pop();
  const app = await page(); app.validateMenu(initial); app.state.csrfToken = 'test-csrf'; app.render();
  assert.equal(app.node('import-drinks').hidden, false); app.reply(menu()); await app.trigger('import-drinks');
  const call = app.calls.at(-1); assert.equal(call.url, '/api/admin/menu/drinks-import'); assert.equal(call.method, 'POST');
  assert.deepEqual(call.body, { revision: 'r1' }); assert.equal(call.headers['X-CSRF-Token'], 'test-csrf');
  assert.match(app.confirmations[0], /36/); assert.equal(app.node('import-drinks').hidden, true);
  const count = app.calls.length; await app.trigger('import-drinks'); assert.equal(app.calls.length, count);
  const delivery = await page('delivery'); delivery.validateMenu(initial); delivery.render();
  assert.equal(delivery.node('import-drinks').hidden, true); const before = delivery.calls.length;
  await delivery.trigger('import-drinks'); assert.equal(delivery.calls.length, before);
});

test('the editor accepts a 100 MiB photo, prepares it while locked, and uploads only the prepared image', async () => {
  let start, finish;
  const started = new Promise(resolve => { start = resolve; });
  const prepared = { type: 'image/webp', size: 700000 };
  const original = { type: 'image/jpeg', size: 100 * 1024 * 1024 };
  const app = await page('catalog', { preparePhoto: file => {
    assert.equal(file, original); start(); return new Promise(resolve => { finish = resolve; });
  } });
  app.validateMenu(menu()); app.openEditor(app.state.items[0]);
  app.node('photo').files = [original]; await app.trigger('photo', 'change');
  assert.equal(app.draft.file, original); assert.equal(app.node('editor-error').hidden, true);
  const before = app.calls.length;
  const saving = app.trigger('item-form', 'submit'); await started;
  assert.equal(app.state.busy, true); assert.equal(app.node('editor-fields').disabled, true);
  assert.equal(app.node('close-editor').disabled, true); assert.equal(app.draft.file, original);
  await app.trigger('remove-photo'); await app.trigger('close-editor');
  app.node('photo').files = [{ type: 'image/png', size: 500 }]; await app.trigger('photo', 'change');
  assert.equal(app.draft.file, original); assert.equal(app.node('editor-dialog').open, true); assert.equal(app.calls.length, before);
  app.reply({ url: '/menu-images/prepared.webp' });
  const saved = menu(); saved.items[0].image = '/menu-images/prepared.webp'; app.reply(saved);
  finish(prepared); await saving;
  assert.equal(app.calls[before].url, '/api/admin/upload'); assert.equal(app.calls[before].body, prepared);
  assert.equal(app.calls[before].headers['Content-Type'], 'image/webp');
  assert.equal(app.calls.at(-1).body.items[0].image, '/menu-images/prepared.webp');
  assert.equal(app.draft.file, null); assert.equal(app.state.busy, false); assert.equal(app.node('editor-dialog').open, false);
});

test('rejected sources and failed preparation retain the original photo for retry without uploading', async () => {
  const original = { type: 'image/png', size: 8 * 1024 * 1024 };
  const app = await page('catalog', { preparePhoto: async () => { throw new Error('Не удалось прочитать фотографию.'); } });
  app.validateMenu(menu()); app.openEditor(app.state.items[0]);
  app.node('photo').files = [original]; await app.trigger('photo', 'change');
  app.node('photo').files = [{ type: 'image/png', size: 100 * 1024 * 1024 + 1 }]; await app.trigger('photo', 'change');
  assert.match(app.node('editor-error').textContent, /до 100 МБ/); assert.equal(app.draft.file, original);
  const before = app.calls.length; await app.trigger('item-form', 'submit');
  assert.equal(app.calls.length, before); assert.equal(app.draft.file, original);
  assert.match(app.node('editor-error').textContent, /прочитать фотографию/);
  assert.equal(app.state.busy, false); assert.equal(app.node('editor-dialog').open, true);
});

test('a logout during preparation prevents uploading or saving with the next session', async () => {
  let start, finish;
  const started = new Promise(resolve => { start = resolve; });
  const app = await page('catalog', { preparePhoto: () => { start(); return new Promise(resolve => { finish = resolve; }); } });
  app.validateMenu(menu()); app.openEditor(app.state.items[0]);
  const original = { type: 'image/jpeg', size: 20000000 };
  app.node('photo').files = [original]; await app.trigger('photo', 'change');
  const before = app.calls.length; const saving = app.trigger('item-form', 'submit'); await started;
  app.idle.generation++;
  finish({ type: 'image/webp', size: 500000 }); await saving;
  assert.equal(app.calls.length, before); assert.equal(app.draft.file, original);
  assert.match(app.node('editor-error').textContent, /Сессия закрыта/);
});

test('subgroup rename and order apply to hidden and visible drinks without changing any other menu fields', () => {
  const items = sectionMenu().items;
  const original = plain(items);
  const result = applyDrinkSectionEdits(items, 'drinks', [
    { originalName: 'Чай', name: 'Чай' }, { originalName: 'Кофе', name: 'Кофейные напитки' }, { originalName: 'Соки', name: 'Соки' },
  ]);
  assert.deepEqual(items, original, 'Previewing subgroup edits must not mutate the live menu');
  assert.deepEqual(orderedDrinkSections(result.filter(item => item.category === 'drinks')).map(section => section.name), ['Чай', 'Кофейные напитки', 'Соки']);
  for (const item of result) {
    const before = original.find(entry => entry.id === item.id);
    if (item.category !== 'drinks') {
      assert.deepEqual(item, before);
      continue;
    }
    const expected = plain(before);
    expected.drink.sectionOrder = before.drink.section === 'Кофе' ? 1 : before.drink.section === 'Чай' ? 0 : 2;
    if (before.drink.section === 'Кофе') expected.drink.section = 'Кофейные напитки';
    assert.deepEqual(item, expected, `Only the section name/order may change for ${item.id}`);
  }
});

test('subgroup edits reject blank names and case-insensitive duplicates', () => {
  const items = sectionMenu().items;
  assert.throws(() => applyDrinkSectionEdits(items, 'drinks', [
    { originalName: 'Кофе', name: '  ' }, { originalName: 'Чай', name: 'Чай' }, { originalName: 'Соки', name: 'Соки' },
  ]));
  assert.throws(() => applyDrinkSectionEdits(items, 'drinks', [
    { originalName: 'Кофе', name: 'ЧАЙ' }, { originalName: 'Чай', name: ' чай ' }, { originalName: 'Соки', name: 'Соки' },
  ]));
});

test('subgroup manager keeps a draft until save and cancel discards the draft', async () => {
  const app = await page(); app.validateMenu(sectionMenu()); app.state.siteCategory = 'drinks'; app.render();
  const original = plain(app.state.items), before = app.calls.length;
  assert.equal(app.node('manage-drink-sections').hidden, false);
  await app.trigger('manage-drink-sections');
  assert.equal(app.node('drink-sections-dialog').open, true);
  const input = app.node('drink-sections-list').querySelector('input[data-section-name="Кофе"]');
  assert.ok(input); input.value = 'Кофейные напитки'; await app.rowEvent(input);
  const move = app.node('drink-sections-list').querySelector('button[data-section-move="Чай"][data-direction="-1"]');
  assert.ok(move); await app.trigger('drink-sections-list', 'click', { target: move });
  assert.deepEqual(plain(app.state.items), original); assert.equal(app.calls.length, before);
  await app.trigger('cancel-drink-sections'); assert.equal(app.node('drink-sections-dialog').open, false);
  assert.deepEqual(plain(app.state.items), original); assert.equal(app.calls.length, before);
  await app.trigger('manage-drink-sections');
  assert.equal(app.node('drink-sections-list').querySelector('input[data-section-name="Кофе"]').value, 'Кофе');
  assert.deepEqual(app.node('drink-sections-list').querySelectorAll('input[data-section-name]').map(field => field.value), ['Кофе', 'Чай', 'Соки']);
});

test('subgroup save persists every affected drink with the current menu revision and CSRF token', async () => {
  const app = await page(); app.validateMenu(sectionMenu()); app.state.siteCategory = 'drinks'; app.state.csrfToken = 'section-csrf'; app.render();
  await app.trigger('manage-drink-sections');
  const input = app.node('drink-sections-list').querySelector('input[data-section-name="Кофе"]');
  input.value = 'Кофейные напитки'; await app.rowEvent(input);
  const move = app.node('drink-sections-list').querySelector('button[data-section-move="Чай"][data-direction="-1"]');
  await app.trigger('drink-sections-list', 'click', { target: move });
  const expected = applyDrinkSectionEdits(app.state.items, 'drinks', [
    { originalName: 'Чай', name: 'Чай' }, { originalName: 'Кофе', name: 'Кофейные напитки' }, { originalName: 'Соки', name: 'Соки' },
  ]);
  app.reply({ ...sectionMenu(), items: expected, revision: 'r2' });
  await app.trigger('drink-sections-form', 'submit');
  const saved = app.calls.at(-1);
  assert.equal(saved.method, 'PUT'); assert.equal(saved.url, '/api/admin/menu');
  assert.equal(saved.headers['X-CSRF-Token'], 'section-csrf'); assert.equal(saved.body.revision, 'r1');
  assert.deepEqual(saved.body.items, plain(expected)); assert.equal(app.node('drink-sections-dialog').open, false);
  assert.equal(app.state.revision, 'r2');
});

test('invalid subgroup names and a stale menu revision keep the dialog open without sending a request', async () => {
  const app = await page(); app.validateMenu(sectionMenu()); app.state.siteCategory = 'drinks'; app.render();
  await app.trigger('manage-drink-sections');
  let input = app.node('drink-sections-list').querySelector('input[data-section-name="Кофе"]');
  const before = app.calls.length;
  for (const value of [' ', 'ЧАЙ']) {
    input.value = value; await app.rowEvent(input); await app.trigger('drink-sections-form', 'submit');
    assert.equal(app.calls.length, before); assert.equal(app.node('drink-sections-dialog').open, true);
    assert.ok(app.node('drink-sections-error').textContent);
  }
  input.value = 'Кофейные напитки'; await app.rowEvent(input);
  app.state.revision = 'r2'; await app.trigger('drink-sections-form', 'submit');
  assert.equal(app.calls.length, before); assert.equal(app.node('drink-sections-dialog').open, true);
  assert.match(app.node('drink-sections-error').textContent, /измен|обнов/i);
});

test('editing a drink retains its subgroup rank and adopting another subgroup uses the destination rank', async () => {
  for (const section of ['Кофе', 'Чай']) {
    const app = await page(); app.validateMenu(sectionMenu()); app.openEditor(app.state.items[1]);
    app.node('drink-section').value = section;
    const expected = sectionMenu(); expected.items[1].drink.section = section;
    expected.items[1].drink.sectionOrder = section === 'Кофе' ? 0 : 1;
    app.reply(expected); await app.trigger('item-form', 'submit');
    assert.equal(app.calls.at(-1).method, 'PUT');
    const saved = app.calls.at(-1).body.items.find(item => item.id === 'coffee');
    assert.equal(saved.drink.sectionOrder, section === 'Кофе' ? 0 : 1); assert.equal(saved.drink.section, section);
    assert.deepEqual(saved.drink.variants, expected.items[1].drink.variants);
    assert.deepEqual(saved.drink.addons, expected.items[1].drink.addons);
    assert.deepEqual(saved.source, expected.items[1].source);
  }
});

test('subgroups can be reordered with the drag handle and keyboard without an accidental save', async () => {
  const app = await page(); app.validateMenu(sectionMenu()); app.state.siteCategory = 'drinks'; app.render();
  await app.trigger('manage-drink-sections');
  const list = app.node('drink-sections-list');
  const names = () => list.querySelectorAll('input[data-section-name]').map(input => input.value);
  const geometry = () => {
    list.getBoundingClientRect = () => ({ top: 0, bottom: 240, height: 240 });
    list.children.forEach((row, index) => { row.getBoundingClientRect = () => ({ top: index * 80, bottom: (index + 1) * 80, height: 80 }); });
  };
  const before = app.calls.length;
  geometry();
  let handle = list.querySelector('button[data-section-drag="Кофе"]');
  await app.trigger('drink-sections-list', 'pointerdown', { target: handle, pointerId: 1, clientY: 40, button: 0 });
  await app.trigger('drink-sections-list', 'pointermove', { pointerId: 1, clientY: 230 });
  assert.deepEqual(names(), ['Кофе', 'Чай', 'Соки'], 'Pointer movement previews the insertion before drop');
  await app.trigger('drink-sections-list', 'pointerup', { pointerId: 1 });
  assert.deepEqual(names(), ['Чай', 'Соки', 'Кофе']);
  assert.match(app.node('drink-sections-announcement').textContent, /место 3 из 3/);
  assert.equal(app.document.activeElement.dataset.sectionDrag, 'Кофе');
  geometry();
  handle = list.querySelector('button[data-section-drag="Кофе"]');
  await app.trigger('drink-sections-list', 'pointerdown', { target: handle, pointerId: 2, clientY: 200, button: 0 });
  await app.trigger('drink-sections-list', 'pointermove', { pointerId: 2, clientY: 10 });
  await app.trigger('drink-sections-list', 'pointercancel', { pointerId: 2 });
  assert.deepEqual(names(), ['Чай', 'Соки', 'Кофе'], 'Cancelled touch does not reorder the draft');
  await app.trigger('drink-sections-list', 'keydown', { target: handle, key: 'Home' });
  assert.deepEqual(names(), ['Кофе', 'Чай', 'Соки']);
  assert.equal(app.calls.length, before, 'Changing order requires explicit save');
});
