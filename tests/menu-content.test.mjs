import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateItems } from '../server/menu-api.mjs';
import { normalizeMenuData } from '../menu-categories.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const readSeed = async (name) => JSON.parse(await readFile(path.join(root, `public/data/${name}.json`), 'utf8'));
const soupCategory = 'site-c394b3bb-c729-4727-b515-49b77a93119c';
const sandwichCategory = 'site-cb5a5fbf-8253-4c3f-8646-c3cb53986dbd';

// Confirmed against the supplied server backup, menu revision 105. These tests
// exercise the checked-in public snapshot; no private runtime or archive is needed.
test('the public menu retains the server groups and only its 57 visible dishes', async () => {
  const menu = await readSeed('menu');
  const normalized = normalizeMenuData(menu);
  const items = validateItems(normalized.items, normalized.categories);
  assert.equal(items.length, 57);
  assert.equal(new Set(items.map(item => item.id)).size, 57);
  assert.deepEqual(menu.categories.map(({ id, name, parentId, order }) => ({ id, name, parentId, order })), [
    { id: 'breakfast', name: 'Завтраки', parentId: null, order: 0 },
    { id: 'dinner', name: 'Ужины', parentId: null, order: 1 },
    { id: 'drinks', name: 'Напитки', parentId: null, order: 2 },
    { id: soupCategory, name: 'Супы', parentId: null, order: 3 },
    { id: sandwichCategory, name: 'Сэндвичи/Вафли', parentId: null, order: 4 },
  ]);
  assert.deepEqual(Object.fromEntries(menu.categories.map(category => [category.id, items.filter(item => item.category === category.id).length])), {
    breakfast: 14, dinner: 6, drinks: 33, [soupCategory]: 3, [sandwichCategory]: 1,
  });
  for (const item of menu.items) {
    assert.equal(item.published, true, `${item.id}: public snapshot must not contain drafts`);
    assert.notEqual(item.hiddenOnSite, true, `${item.id}: hidden dishes stay private`);
    assert.notEqual(item.source?.testOnly, true);
    assert.ok(!item.id.startsWith('kds-test-'));
    assert.ok(item.price > 0);
  }
  const hiddenIds = [
    'ham-brioche', 'granola', 'vanilla-pancakes', 'fried-eggs', 'english-breakfast',
    'ea118d68-a633-4b66-ba37-c590ef510100', 'drink-iced-matcha', 'drink-juice-apple', 'drink-tea',
  ];
  for (const id of hiddenIds) assert.ok(!items.some(item => item.id === id), `${id}: must not leak through public JSON`);
});

test('the public menu preserves confirmed price edits, renamed dishes and new categories', async () => {
  const { items } = await readSeed('menu');
  const expected = [
    ['morning-eight', 'Завтрак «8 утра»', 1240, 'breakfast'],
    ['avocado-toast', 'Авокадо-тост с яйцом пашот и гуакамоле', 620, 'breakfast'],
    ['chef-syrniki', 'Сырники от шефа', 810, 'breakfast'],
    ['oatmeal-berries', 'Арахисовая овсянка с бананом', 450, 'breakfast'],
    ['green-buckwheat', 'Пророщеная гречка с трюфелем', 820, 'breakfast'],
    ['006c5f61-0eb0-45ba-9c98-7cdbb2e531ec', 'Аля греческий', 820, 'dinner'],
    ['e113c15a-2bb5-45dd-b8e8-f7675a4b50e5', 'Орзо с опаленным лососем', 1320, 'dinner'],
    ['38977528-a562-4194-945a-2e701588961b', 'Тыквенный суп с креветками', 660, soupCategory],
    ['bea2a42c-4113-464d-9267-1d5a1ddfd283', 'Куриный бульон', 560, soupCategory],
    ['4e020acc-da8a-4cf3-9e71-9a5c38e9e8ea', 'Финский суп', 660, soupCategory],
    ['c3521337-2cc0-4252-a3c3-912f150fad14', 'Сэндвич с ростбиф', 780, sandwichCategory],
    ['7be8b321-9243-4f21-9a39-26a5696a6641', 'Качо Э Пепе с медальоном', 1450, 'dinner'],
    ['ed1909de-035d-447b-96fb-50d9b9a60de6', 'Мергато', 1450, 'dinner'],
  ];
  for (const [id, name, price, category] of expected) {
    const item = items.find(item => item.id === id);
    assert.ok(item, `Missing confirmed dish: ${id}`);
    assert.deepEqual({ name: item.name, price: item.price, category: item.category }, { name, price, category });
  }
});

test('all 39 public photographs exist, including server uploads exported as static assets', async () => {
  const menu = await readSeed('menu');
  const items = validateItems(menu.items, menu.categories);
  const photographed = items.filter(item => item.image);
  assert.equal(photographed.length, 39);
  assert.equal(photographed.filter(item => item.image.startsWith('/menu-images/server-')).length, 31);
  for (const item of photographed) {
    assert.match(item.image, /^\/menu-images\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:jpe?g|png|webp)$/i);
    assert.ok(!item.image.includes('..'));
    const file = path.join(root, 'public', item.image.slice(1));
    const info = await stat(file);
    assert.ok(info.isFile() && info.size > 1000, `Photo exists: ${item.name}`);
  }
  assert.equal(items.find(item => item.id === 'oatmeal-berries').image, '/menu-images/server-81dff36d-3677-4e99-aed2-d5b6a76a772c.jpg');
  assert.equal(items.find(item => item.id === 'drink-cappuccino').image, '/menu-images/server-ed9b483f-c631-43a3-a70e-1014f12b0752.png');
});

test('the live drinks snapshot preserves author edits, photos, section order and size pairs', async () => {
  const menu = await readSeed('menu');
  const drinks = validateItems(menu.items, menu.categories).filter(item => item.drink);
  assert.equal(drinks.length, 33);
  assert.equal(drinks.filter(item => item.image).length, 17);
  assert.equal(drinks.reduce((total, item) => total + item.drink.variants.length, 0), 38);
  assert.equal(drinks.filter(item => item.drink.childFriendly).length, 4);
  const sections = new Map();
  for (const item of drinks) {
    assert.equal(item.price, item.drink.variants[0].price, `${item.id}: base price matches first volume`);
    assert.equal(item.category, 'drinks');
    assert.equal(item.availableForOrder, false);
    if (sections.has(item.drink.section)) assert.equal(item.drink.sectionOrder, sections.get(item.drink.section));
    sections.set(item.drink.section, item.drink.sectionOrder);
  }
  assert.deepEqual([...sections].sort((left, right) => left[1] - right[1]), [
    ['Авторские', 0], ['Кофе', 1], ['С молоком', 2], ['Холодные', 3],
    ['Домашние лимонады', 4], ['Свежевыжатые соки', 5], ['Строго 18−', 6], ['Не чай', 7],
  ]);
  const tea = drinks.find(item => item.id === 'drink-fruit-tea-seabuckthorn-mango');
  assert.equal(tea.name, 'Облепиховый Чай');
  assert.deepEqual(tea.drink.variants, [{ volumeMl: 350, price: 350 }, { volumeMl: 600, price: 580 }]);
  assert.deepEqual(tea.drink.addons.find(addon => addon.name === 'Вода'), { name: 'Вода', price: 0 });
  assert.deepEqual(drinks.find(item => item.id === 'drink-cappuccino').drink.variants, [{ volumeMl: 230, price: 230 }, { volumeMl: 370, price: 370 }]);
});

test('the independent PDF drinks import template retains all 36 original entries', async () => {
  const seed = await readSeed('drinks');
  const drinks = validateItems(seed.items, seed.categories);
  assert.equal(drinks.length, 36);
  assert.equal(new Set(drinks.map(item => item.drink.section)).size, 9);
  assert.equal(drinks.reduce((total, item) => total + item.drink.variants.length, 0), 42);
  assert.equal(drinks.filter(item => item.drink.childFriendly).length, 4);
  assert.deepEqual(drinks.find(item => item.id === 'drink-cappuccino').drink.variants, [{ volumeMl: 230, price: 230 }, { volumeMl: 370, price: 370 }]);
  assert.deepEqual(drinks.find(item => item.id === 'drink-milk-chocolate').drink.variants, [{ volumeMl: 280, price: 320 }, { volumeMl: 350, price: 440 }]);
  assert.deepEqual(drinks.find(item => item.id === 'drink-tea').drink.variants, [{ volumeMl: 350, price: 210 }, { volumeMl: 600, price: 350 }]);
  assert.deepEqual(drinks.find(item => item.id === 'drink-tea').drink.addons.find(addon => addon.name === 'Вода'), { name: 'Вода', price: 0 });
  assert.equal(drinks.find(item => item.id === 'drink-cappuccino').drink.addons[0].price, 160);
  assert.equal(drinks.find(item => item.id === 'drink-juice-carrot').drink.addons[0].price, 70);
  assert.deepEqual(drinks.find(item => item.id === 'drink-bumble').drink.addons, []);
  for (const item of drinks) {
    assert.equal(item.price, item.drink.variants[0].price, `${item.id}: base price matches first volume`);
    assert.equal(item.category, 'drinks');
    assert.equal(item.image, '');
    assert.equal(item.published, true);
    assert.equal(item.availableForOrder, false);
  }
});
