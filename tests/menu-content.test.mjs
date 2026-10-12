import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateItems } from '../server/menu-api.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('the complete breakfast seed has valid prices, categories and local original photos', async () => {
  const menu = JSON.parse(await readFile(path.join(root, 'public/data/menu.json'), 'utf8'));
  const sources = JSON.parse(await readFile(path.join(root, 'docs/menu-photo-sources.json'), 'utf8'));
  const items = validateItems(menu.items, menu.categories).filter(item => item.category === 'breakfast');
  assert.equal(items.length, 19);
  assert.equal(items.filter(item => item.image).length, 13);
  assert.equal(menu.source.checkedAt, '2026-09-28');
  for (const item of items) {
    assert.ok(item.price > 0);
    assert.equal(item.availableForOrder, true);
    assert.ok(!item.description.includes('Кафе Шелепиха'), 'No SEO boilerplate imported as ingredients');
    if (!item.image) continue;
    const file = path.join(root, 'public', item.image);
    assert.ok((await stat(file)).size > 1000, `Photo exists: ${item.name}`);
    assert.ok(sources.photos.some(source => source.id === item.id && source.url.startsWith('https://avatars.mds.yandex.net/get-sprav-products/')));
  }
  assert.equal(items.find(item => item.id === 'morning-eight').price, 1190);
  assert.equal(items.find(item => item.id === 'avocado-toast').price, 590);
  assert.equal(items.find(item => item.id === 'chef-syrniki').price, 810);
});

test('the PDF drinks seed retains all sections, size pairs and child marks', async () => {
  const menu = JSON.parse(await readFile(path.join(root, 'public/data/menu.json'), 'utf8'));
  const seed = JSON.parse(await readFile(path.join(root, 'public/data/drinks.json'), 'utf8'));
  const drinks = validateItems(menu.items, menu.categories).filter(item => item.drink);
  assert.equal(drinks.length, 36);
  assert.deepEqual(menu.items.filter(item => item.drink), seed.items, 'Static preview and additive import use the same drinks');
  assert.equal(new Set(drinks.map(item => item.drink.section)).size, 9);
  assert.equal(drinks.reduce((total, item) => total + item.drink.variants.length, 0), 42);
  assert.equal(drinks.filter(item => item.drink.childFriendly).length, 4);
  assert.deepEqual(drinks.find(item => item.id === 'drink-cappuccino').drink.variants, [{volumeMl:230, price:230}, {volumeMl:370, price:370}]);
  assert.deepEqual(drinks.find(item => item.id === 'drink-milk-chocolate').drink.variants, [{volumeMl:280, price:320}, {volumeMl:350, price:440}]);
  assert.deepEqual(drinks.find(item => item.id === 'drink-tea').drink.variants, [{volumeMl:350, price:210}, {volumeMl:600, price:350}]);
  assert.deepEqual(drinks.find(item => item.id === 'drink-tea').drink.addons.find(addon => addon.name === 'Вода'), {name:'Вода',price:0});
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
