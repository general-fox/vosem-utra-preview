import test from 'node:test';
import assert from 'node:assert/strict';
import { syncDishCartControls } from '../dish-cart.js';
import { createCartStore } from '../cart-store.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.className = ''; this.hidden = false; this.disabled = false; this.attributes = {}; this.textContent = ''; }
  append(...elements) { for (const element of elements) { element.parent = this; this.children.push(element); } }
  setAttribute(key, value) { this.attributes[key] = value; }
  get classList() { return { toggle: (name, enabled) => { const names = new Set(this.className.split(' ')); enabled ? names.add(name) : names.delete(name); this.className = [...names].join(' '); } }; }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    const data = selector.match(/^\[data-([a-z-]+)(?:="([^"]+)")?\]$/);
    if (data) { const key = data[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()); return key in this.dataset && (data[2] === undefined || this.dataset[key] === data[2]); }
    return this.tagName === selector;
  }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); }
  querySelectorAll(selector) {
    const parts = selector.split(' ');
    if (parts.length > 1) return this.querySelectorAll(parts[0]).flatMap(element => element.querySelectorAll(parts.slice(1).join(' ')));
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function fixture(t, disabled = false) {
  const previous = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const root = new Element('main'), card = new Element('article'), name = new Element('h3'), actions = new Element('div'), add = new Element('button');
  card.className = 'dish-card'; name.textContent = 'Завтрак с яйцом';
  actions.dataset.cartItem = 'toast'; add.dataset.cartAdd = 'toast'; add.disabled = disabled;
  actions.append(add); card.append(name, actions); root.append(card);
  const store = createCartStore();
  store.subscribe(lines => syncDishCartControls(root, lines));
  syncDishCartControls(root, store.lines);
  return { root, card, actions, add, store, selected: actions.querySelector('.dish-cart-selected'),
    minus: actions.querySelector('[data-dish-delta="-1"]'), plus: actions.querySelector('[data-dish-delta="1"]'), count: actions.querySelector('.dish-quantity-value') };
}

test('card quantity follows the shared cart, keeps existing controls and restores add at zero', t => {
  const f = fixture(t);
  assert.equal(f.selected.hidden, true); assert.equal(f.add.hidden, false);
  f.store.add('toast');
  assert.equal(f.add.hidden, true); assert.equal(f.selected.hidden, false); assert.equal(f.count.textContent, '1');
  assert.match(f.card.className, /is-in-cart/);
  f.store.setQuantity('toast', 3);
  assert.equal(f.count.textContent, '3');
  assert.equal(f.actions.querySelector('.dish-cart-selected'), f.selected, 'No node replacement on a quantity update');
  assert.equal(f.actions.querySelectorAll('.dish-cart-selected').length, 1);
  assert.equal(f.plus.attributes['aria-label'], 'Увеличить количество: Завтрак с яйцом');
  f.store.setQuantity('toast', 99);
  assert.equal(f.plus.disabled, true); assert.equal(f.minus.disabled, false);
  f.store.clear();
  assert.equal(f.selected.hidden, true); assert.equal(f.add.hidden, false);
  assert.doesNotMatch(f.card.className, /is-in-cart/);
});

test('a sold-out item remains removable but cannot be increased', t => {
  const f = fixture(t, true);
  syncDishCartControls(f.root, [{ id: 'toast', qty: 2 }]);
  assert.equal(f.count.textContent, '2'); assert.equal(f.plus.disabled, true); assert.equal(f.minus.disabled, false);
  assert.equal(f.selected.querySelector('.dish-in-cart span').textContent, 'В корзине · нет в наличии');
});
