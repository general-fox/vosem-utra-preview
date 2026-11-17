import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { menuImages } from '../menu-images.js';
import { validateItems } from '../server/menu-api.mjs';
import { normalizeMenuData } from '../menu-categories.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const readSeed = async (name) => JSON.parse(await readFile(path.join(root, `public/data/${name}.json`), 'utf8'));
const soupCategory = 'site-c394b3bb-c729-4727-b515-49b77a93119c';
const sandwichCategory = 'site-cb5a5fbf-8253-4c3f-8646-c3cb53986dbd';

// Counts and prices retain the supplied server backup. Sections and compositions
// follow the approved live snapshot (revision 131), with the November 17 photo
// pairs and separate nutrition fields applied in revision 132, and uniform
// landscape photographs in revision 135. These checks use
// only checked-in public data; no private runtime or downloaded archive is needed.
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

test('all ordered public photographs resolve and the first photo remains the cover', async () => {
  const menu = await readSeed('menu');
  const items = validateItems(menu.items, menu.categories);
  assert.equal(items.filter(item => item.image).length,39);
  assert.equal(items.filter(item => menuImages(item).length === 2).length,19);
  for (const item of items) {
    const images = menuImages(item);
    assert.equal(item.image,images[0] || '', item.id + ': first photo is the cover');
    for (const image of images) {
      assert.match(image,/^\/menu-images\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:jpe?g|png|webp)$/i);
      assert.ok(!image.includes('..'));
      const info = await stat(path.join(root,'public',image.slice(1)));
      assert.ok(info.isFile() && info.size > 1000, item.name + ': photo exists at ' + image);
    }
  }
  assert.equal(items.find(item => item.id === 'oatmeal-berries').image, '/menu-images/oatmeal-berries-1-landscape.webp');
  assert.equal(items.find(item => item.id === 'drink-cappuccino').image, '/menu-images/drink-cappuccino-1-landscape.webp');
});

test('every imported photo pair matches its ordered source manifest and verified asset bytes', async () => {
  const menu = await readSeed('menu');
  const items = validateItems(menu.items,menu.categories);
  const manifest = JSON.parse(await readFile(path.join(root,'docs/menu-photo-pairs-2026-11-17.json'),'utf8'));
  assert.equal(manifest.pairs.length,23);
  assert.equal(new Set(manifest.pairs.map(pair => pair.id)).size,23);
  assert.equal(manifest.pairs.filter(pair => pair.published).length,19);
  const importedPaths = new Set();
  for (const pair of manifest.pairs) {
    assert.deepEqual(pair.photos.map(photo => photo.role),['close','wide'],pair.id + ': close-up comes before the wider shot');
    assert.notEqual(pair.photos[0].file,pair.photos[1].file,pair.id + ': two distinct source photographs');
    const item = items.find(item => item.id === pair.id);
    if (pair.published) {
      assert.ok(item,pair.id + ': published pair has a menu entry');
      assert.deepEqual(menuImages(item),pair.photos.map(photo => photo.image),pair.id + ': gallery order matches manifest');
    } else {
      assert.equal(item,undefined,pair.id + ': hidden pair stays out of public menu');
    }
    for (const photo of pair.photos) {
      assert.match(photo.image,/^\/menu-images\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.webp$/);
      assert.ok(!photo.image.includes('..'));
      assert.equal(importedPaths.has(photo.image),false,'Imported photo paths are unique');
      importedPaths.add(photo.image);
      assert.ok(Object.hasOwn(manifest.sources,photo.source),'Source folder is documented');
      assert.match(photo.sourceSha256,/^[a-f0-9]{64}$/);
      assert.ok(Number.isInteger(photo.width) && Number.isInteger(photo.height));
      assert.equal(photo.width / photo.height,4 / 3,photo.image + ': every angle has the same landscape proportions');
      assert.ok(Math.min(photo.width,photo.height) >= 1000 && Math.max(photo.width,photo.height) <= 1600,
        photo.image + ': web asset stays within the supported dimensions without upscaling');
      const bytes = await readFile(path.join(root,'public',photo.image.slice(1)));
      assert.equal(bytes.length,photo.bytes,photo.image + ': byte size matches manifest');
      assert.equal(bytes.toString('ascii',0,4),'RIFF');
      assert.equal(bytes.toString('ascii',8,12),'WEBP');
      assert.equal(createHash('sha256').update(bytes).digest('hex'),photo.sha256,photo.image + ': SHA-256 matches manifest');
      if (photo.edit) {
        assert.ok(['background-outpainting','landscape-outpainting'].includes(photo.edit.type));
        if (photo.edit.type === 'background-outpainting') {
          assert.equal(photo.role,'wide','The first background edit applied to the general view');
          assert.match(photo.image,/-wide-filled\.webp$/);
        } else {
          assert.match(photo.image,/-landscape\.webp$/);
        }
        assert.equal(photo.edit.tool,'image_gen');
        assert.equal(typeof photo.edit.prompt,'string');
        assert.ok(photo.edit.prompt.trim().length > 0,'The background edit is documented');
        assert.match(photo.edit.originalImage,/^\/menu-images\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.webp$/);
        assert.ok(!photo.edit.originalImage.includes('..'));
        assert.notEqual(photo.edit.originalImage,photo.image,'An edit never replaces the retained original');
        assert.match(photo.edit.originalSha256,/^[a-f0-9]{64}$/);
        const original = await readFile(path.join(root,'public',photo.edit.originalImage.slice(1)));
        assert.equal(createHash('sha256').update(original).digest('hex'),photo.edit.originalSha256,
          photo.edit.originalImage + ': the original photograph is preserved unchanged');
      }
    }
  }
  assert.equal(importedPaths.size,46);
  assert.deepEqual(items.filter(item => menuImages(item).length === 2).map(item => item.id).sort(),manifest.pairs.filter(pair => pair.published).map(pair => pair.id).sort());
});

test('the photo and nutrition update leaves all 24 existing food prices unchanged', async () => {
  const { items } = await readSeed('menu');
  const baselinePrices = {
    'morning-eight':1240, 'avocado-toast':620, 'chef-syrniki':810, 'feta-omelette':520,
    'oatmeal-berries':450, 'salmon-draniki':1250, 'shakshuka':850, 'salmon-brioche':1390,
    'green-buckwheat':820, 'wheat-porridge':280, 'omelette-scramble':370,
    'caramel-syrniki':720, 'cottage-casserole':550, 'sour-cream-pancakes':250,
    '006c5f61-0eb0-45ba-9c98-7cdbb2e531ec':820, '034a8e18-186c-4977-8cac-3c0509abfafe':1450,
    'e113c15a-2bb5-45dd-b8e8-f7675a4b50e5':1320, '5e95df95-b45a-4edb-9a22-dbdbbb5d2e46':1250,
    '38977528-a562-4194-945a-2e701588961b':660, 'bea2a42c-4113-464d-9267-1d5a1ddfd283':560,
    '4e020acc-da8a-4cf3-9e71-9a5c38e9e8ea':660, 'c3521337-2cc0-4252-a3c3-912f150fad14':780,
    '7be8b321-9243-4f21-9a39-26a5696a6641':1450, 'ed1909de-035d-447b-96fb-50d9b9a60de6':1450,
  };
  assert.deepEqual(Object.fromEntries(items.filter(item => !item.drink).map(item => [item.id,item.price])),baselinePrices);
});

test('13 published nutrition values are preserved separately without inferred allergens', async () => {
  const { items } = await readSeed('menu');
  const expected = {
    'morning-eight':'580/33/32.2/39.4', 'avocado-toast':'420/14.5/22/9/3',
    'chef-syrniki':'540/27.7/27.7/45', 'feta-omelette':'407/15.2/36.4/4.5',
    'oatmeal-berries':'486/14.1/18.3/66.1', 'salmon-draniki':'488/20.3/33.9/25.4',
    'shakshuka':'442/21.9/20.5/42.5', 'salmon-brioche':'771/22.7/61.9/30.8',
    'wheat-porridge':'504/11.8/24.1/60', 'omelette-scramble':'308/13/27.9/1.3',
    'caramel-syrniki':'540/27.7/27.7/45', 'cottage-casserole':'506/16.5/35.2/30.6',
    'sour-cream-pancakes':'433/9.9/22.2/48.3',
  };
  assert.deepEqual(Object.fromEntries(items.filter(item => item.nutrition).map(item => [item.id,item.nutrition])),expected);
  for (const item of items) {
    assert.doesNotMatch(item.description,/к\s*б\s*ж\s*у\s*:/iu,item.id + ': nutrition is not duplicated in the composition');
    assert.ok(!item.allergens,item.id + ': allergens require supplied facts');
  }
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
    ['Авторские', 0], ['Кофе', 1], ['Домашние лимонады/смузи', 2],
    ['Свежевыжатые соки', 3], ['Чай', 6],
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
