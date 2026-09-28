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
  const items = validateItems(menu.items);
  assert.equal(items.length, 19);
  assert.equal(items.filter(item => item.image).length, 13);
  assert.equal(menu.source.checkedAt, '2026-09-28');
  for (const item of items) {
    assert.ok(item.price > 0);
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
