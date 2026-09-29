import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanLines, createCartStore, cartSummary, CART_KEY } from '../cart-store.js';

function storage(initial = '[]') {
  let saved = initial;
  return { getItem: key => key === CART_KEY ? saved : null, setItem: (key, value) => { assert.equal(key, CART_KEY); saved = value; }, get saved() { return JSON.parse(saved); } };
}
const dish = patch => ({ id: 'toast', name: 'Тост', price: 450, published: true, availableForOrder: true, ...patch });
test('basket persists only identifiers and quantities and survives a new store', () => {
  const disk = storage(JSON.stringify([{ id: 'toast', qty: 2, phone: '+70000000000', price: 1, address: 'ignored' }]));
  const cart = createCartStore(disk); cart.add('toast'); cart.add('porridge');
  assert.deepEqual(disk.saved, [{ id: 'toast', qty: 3 }, { id: 'porridge', qty: 1 }]);
  assert.deepEqual(createCartStore(disk).lines, disk.saved);
  cart.setQuantity('toast', 0); assert.deepEqual(cart.lines, [{ id: 'porridge', qty: 1 }]);
});
test('basket enforces 50 lines and 99 portions and sanitizes corrupt storage', () => {
  assert.deepEqual(cleanLines([{ id: '<script>', qty: 1 }, { id: 'a', qty: -1 }, { id: 'a', qty: 2.5 }, { id: 'a', qty: 98 }, { id: 'a', qty: 3 }]), [{ id: 'a', qty: 99 }]);
  const cart = createCartStore(storage(JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: `dish-${i}`, qty: i === 0 ? 99 : 1 })))));
  assert.throws(() => cart.add('other'), /50/); assert.throws(() => cart.add('dish-0'), /99/); assert.throws(() => cart.setQuantity('dish-0', 1.2));
  assert.equal(cart.lines.length, 50);
});
test('storage failures keep a usable in-memory basket without claiming persistence', () => {
  const cart = createCartStore({ getItem() { throw Error(); }, setItem() { throw Error(); } });
  cart.add('toast'); assert.equal(cart.persisted, false); assert.deepEqual(cart.lines, [{ id: 'toast', qty: 1 }]);
});
test('new catalog prices and removed or unavailable dishes remain visible for review', () => {
  const summary = cartSummary([{ id: 'toast', qty: 2 }, { id: 'removed', qty: 1 }, { id: 'hidden', qty: 1 }], [dish({ price: 475.5 }), dish({ id: 'hidden', availableForOrder: false })], [dish(), dish({ id: 'removed', name: 'Каша' })]);
  assert.equal(summary.rows[0].previousMinor, 45000); assert.equal(summary.rows[0].unitMinor, 47550); assert.equal(summary.rows[0].lineMinor, 95100);
  assert.equal(summary.rows[1].item.name, 'Каша'); assert.equal(summary.rows[1].available, false); assert.equal(summary.rows[1].unitMinor, null);
  assert.equal(summary.rows[2].available, false); assert.equal(summary.unavailable, true);
});
test('success removes only ordered quantities and preserves concurrent additions', () => {
  const cart = createCartStore(storage('[{"id":"toast","qty":4},{"id":"porridge","qty":1}]'));
  cart.consume([{ id: 'toast', quantity: 2 }]);
  assert.deepEqual(cart.lines, [{ id: 'toast', qty: 2 }, { id: 'porridge', qty: 1 }]);
});
