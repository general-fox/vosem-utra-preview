import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDrink, orderedDrinkSections } from '../menu-drinks-model.js';
import { normalizeStoredMenu, validateItems } from '../server/menu-api.mjs';

const drink = { section: ' Кофе ', variants: [{ volumeMl: 250, price: 180.50 }, { volumeMl: 350, price: 230 }], addons: [{ name: ' Сироп ', price: 40 }], childFriendly: false };
const dish = { id: 'latte', name: 'Латте', description: '', price: 999, category: 'breakfast', image: '', published: true, availableForOrder: true, order: 1 };

test('drink normalization trims labels, drops unknown keys and leaves input untouched', () => {
  const input = structuredClone(drink);
  input.extra = true; input.variants[0].extra = true; input.addons[0].extra = true;
  const before = structuredClone(input);
  assert.deepEqual(normalizeDrink(input), { section: 'Кофе', variants: [{ volumeMl: 250, price: 180.5 }, { volumeMl: 350, price: 230 }], addons: [{ name: 'Сироп', price: 40 }], childFriendly: false });
  assert.deepEqual(input, before);
  assert.deepEqual(normalizeDrink({ section: 'Детское', variants: [{ volumeMl: 1, price: 0 }], childFriendly: true }), { section: 'Детское', variants: [{ volumeMl: 1, price: 0 }], addons: [], childFriendly: true });
  assert.equal(normalizeDrink(null), undefined);
  assert.equal(normalizeDrink(undefined), undefined);
});

test('subgroup ordering is optional and survives the stored menu contract at both bounds', () => {
  assert.equal(Object.hasOwn(normalizeDrink(drink), 'sectionOrder'), false);
  for (const sectionOrder of [0, 3, 10000]) {
    const ranked = { ...drink, sectionOrder };
    assert.equal(normalizeDrink(ranked).sectionOrder, sectionOrder);
    const saved = normalizeStoredMenu({ items: [{ ...dish, drink: ranked }], revision: 4 });
    assert.equal(saved.items[0].drink.sectionOrder, sectionOrder);
    assert.deepEqual(normalizeStoredMenu(JSON.parse(JSON.stringify(saved))), saved);
  }
});

test('invalid beverage bounds, repeated choices, controls and fractional cents are rejected', () => {
  const invalid = [
    false, [], {}, { ...drink, section: '' }, { ...drink, section: 'x'.repeat(81) }, { ...drink, section: 'Кофе\nЧай' }, { ...drink, section: 'Кофе\u0085Чай' },
    { ...drink, variants: [] }, { ...drink, variants: new Array(1) }, { ...drink, variants: Array.from({ length: 11 }, (_, i) => ({ volumeMl: i + 1, price: 10 })) },
    { ...drink, variants: [{ volumeMl: 250, price: 10 }, { volumeMl: 250, price: 20 }] },
    ...[0, 5001, 250.5, '250'].map(volumeMl => ({ ...drink, variants: [{ volumeMl, price: 10 }] })),
    ...[-1, 1000001, 1.001, 0.00000001, NaN, Infinity, '100'].map(price => ({ ...drink, variants: [{ volumeMl: 250, price }] })),
    { ...drink, addons: null }, { ...drink, addons: new Array(1) }, { ...drink, addons: Array.from({ length: 13 }, (_, i) => ({ name: `Добавка ${i}`, price: 10 })) },
    { ...drink, addons: [{ name: 'Сироп', price: 1 }, { name: ' Сироп ', price: 2 }] },
    { ...drink, addons: [{ name: 'x'.repeat(81), price: 0 }] }, { ...drink, addons: [{ name: 'Сироп', price: 1.001 }] },
    { ...drink, childFriendly: null }, { ...drink, childFriendly: 'true' },
    ...[-1, 10001, 1.5, '1', null, undefined, true, NaN, Infinity].map(sectionOrder => ({ ...drink, sectionOrder })),
  ];
  for (const value of invalid) assert.throws(() => normalizeDrink(value));
  assert.doesNotThrow(() => normalizeDrink({ section: 'x'.repeat(80), variants: [{ volumeMl: 5000, price: 1000000 }, { volumeMl: 1, price: 0.29 }] }));
});

test('stored and public item validation preserves metadata, canonical price and disabled ordering', () => {
  const item = validateItems([{ ...dish, drink }])[0];
  assert.equal(item.price, 180.5);
  assert.equal(item.availableForOrder, false);
  assert.deepEqual(item.drink, normalizeDrink(drink));
  const saved = normalizeStoredMenu({ items: [{ ...dish, drink }], revision: 4 });
  assert.deepEqual(normalizeStoredMenu(JSON.parse(JSON.stringify(saved))), saved);
  assert.ok(saved.categories.every(category => category.parentId === null));
  assert.equal(saved.items[0].availableForOrder, false);
  const legacy = validateItems([dish])[0];
  assert.equal(legacy.price, 999);
  assert.equal(Object.hasOwn(legacy, 'drink'), false);
  assert.equal(legacy.availableForOrder, true);
  assert.throws(() => validateItems([{ ...dish, drink: { ...drink, variants: [{ volumeMl: 250, price: -1 }] } }]), { code: 'invalid_drink' });
});

test('legacy subgroups keep Coffee first and otherwise use encounter order without mutating items', () => {
  const tea = { drink: { ...drink, section: 'Чай' } };
  const coffee = { drink: { ...drink, section: 'Кофе' } };
  const secondTea = { drink: { ...drink, section: 'Чай' } };
  const milk = { drink: { ...drink, section: 'С молоком' } };
  const items = [tea, dish, coffee, secondTea, milk, null, { drink: {} }];
  const before = structuredClone(items);
  assert.deepEqual(orderedDrinkSections(items), [
    { name: 'Кофе', order: 0, items: [coffee] },
    { name: 'Чай', order: 1, items: [tea, secondTea] },
    { name: 'С молоком', order: 2, items: [milk] },
  ]);
  assert.equal(orderedDrinkSections(items)[1].items[0], tea);
  assert.deepEqual(items, before);
  assert.deepEqual(orderedDrinkSections([dish, { drink: null }]), []);
});

test('explicit subgroup order uses the smallest member rank, with stable ties and unranked groups last', () => {
  const beverage = (section, sectionOrder) => ({ drink: { ...drink, section, ...(sectionOrder !== undefined ? { sectionOrder } : {}) } });
  const items = [beverage('Кофе'), beverage('Чай', 9), beverage('С молоком', 2), beverage('Чай', 0), beverage('Авторские', 2), beverage('Холодные')];
  const sections = orderedDrinkSections(items);
  assert.deepEqual(sections.map(({ name, order }) => ({ name, order })), [
    { name: 'Чай', order: 0 }, { name: 'С молоком', order: 1 }, { name: 'Авторские', order: 2 },
    { name: 'Кофе', order: 3 }, { name: 'Холодные', order: 4 },
  ]);
  assert.deepEqual(sections[0].items, [items[1], items[3]]);
  assert.equal(sections[0].items[1], items[3]);
});

test('invalid ranks do not override the legacy subgroup order', () => {
  const items = [{ drink: { ...drink, section: 'Чай', sectionOrder: -1 } },
    { drink: { ...drink, section: 'Кофе', sectionOrder: '0' } }];
  assert.deepEqual(orderedDrinkSections(items).map(section => section.name), ['Кофе', 'Чай']);
});
