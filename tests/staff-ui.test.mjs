import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as model from '../staff-model.js';
import { StaffError } from '../staff-client.js';
import { money, normalizePhone, formatPhone } from '../order-client.js';

const source = await readFile(new URL('../staff.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../staff.html', import.meta.url), 'utf8');
const actor = { id: '42', name: 'Тестовый сотрудник', role: 'employee' };
const slot = '2035-05-15T12:00:00+03:00';
const catalog = [{ id: 'toast', name: 'Тост с длинным названием блюда', price: 100, published: true, availableForOrder: true }];
const fixture = patch => ({ order: { id: 'a'.repeat(32), number: 'TEST-1', version: 2, status: 'processing', assignee: actor, createdAt: '2035-05-15T06:00:00Z',
  contact: { phone: '+70000000000', name: 'Тест' }, fulfilment: { type: 'pickup', timing: 'asap', requestedAt: null, address: null, courierInstructions: '', confirmedAt: slot },
  items: [{ id: 'toast', name: catalog[0].name, quantity: 1, unitPriceMinor: 10000, lineTotalMinor: 10000 }], currency: 'RUB', subtotalMinor: 10000, deliveryFeeMinor: 0, totalMinor: 10000,
  staffNote: '', fulfillmentComment: '', orderComment: 'Комментарий гостя', ...patch }, history: [], integration: null });
const settings = { timezone: 'Europe/Moscow', delivery: { mode: 'confirm_by_phone' }, maxLines: 50, maxQuantity: 99, availability: { pickup: { slots: [slot] }, delivery: { slots: [slot] } } };

async function page() {
  const nodes = new Map(); const calls = []; const responses = []; const documentHandlers = new Map();
  const document = {
    hidden: false, activeElement: null,
    getElementById(id) { if (!id) return null; assert.ok(nodes.has(id), `Unknown HTML id ${id}`); return nodes.get(id); },
    querySelectorAll() { return []; }, querySelector() { return null; },
    createElement(tag) { return makeNode(tag); }, addEventListener(type, handler) { documentHandlers.set(type, handler); },
  };
  function makeNode(tag, attributes = new Map()) {
    let value = attributes.get('value') || ''; const handlers = new Map();
    return { tagName: tag.toUpperCase(), id: attributes.get('id') || '', attributes, handlers, children: [], textContent: '', dataset: {}, className: '', hidden: attributes.has('hidden'), disabled: attributes.has('disabled'), checked: false,
      get value() { return value; }, set value(next) { value = String(next); },
      setAttribute(name, next) { attributes.set(name, String(next)); }, removeAttribute(name) { attributes.delete(name); },
      addEventListener(type, handler) { handlers.set(type, handler); },
      append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; },
      focus() { document.activeElement = this; }, reset() {}, showModal() { this.open = true; }, close() { this.open = false; },
      classList: { toggle() {} },
    };
  }
  document.body = makeNode('body');
  for (const match of html.matchAll(/<([a-z][a-z\d-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const attributes = new Map([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(entry => [entry[1], entry[2]]));
    if (/\bhidden\b/.test(match[2])) attributes.set('hidden', '');
    if (/\bdisabled\b/.test(match[2])) attributes.set('disabled', '');
    nodes.set(match[3], makeNode(match[1], attributes));
  }
  const client = { forget() {}, async request(path, options = {}) {
    calls.push({ path, ...options }); const result = responses.shift(); assert.ok(result, `Unexpected request: ${path}`);
    if (result instanceof Error) throw result;
    if (typeof result === 'function') return result(path, options);
    return structuredClone(result);
  } };
  const context = vm.createContext({ ...model, StaffError, money, normalizePhone, formatPhone, createStaffClient: () => client,
    document, window: { addEventListener() {} }, location: { href: 'https://example.test/staff.html', pathname: '/staff.html' },
    Intl, Date, URL, URLSearchParams, structuredClone, console, confirm: () => true, setTimeout: () => 1, clearTimeout() {},
    crypto: { randomUUID: () => 'unique-test-key' },
    Option: function (text, value) { const item = makeNode('option'); item.textContent = text; item.value = value; return item; },
    __actor: actor, __settings: settings, __catalog: catalog,
  });
  const runtime = new vm.Script(`${source.replace(/^import .*;\r?\n/gm, '')}\n;({editor, acceptance, failure, save, refreshDetail, sync, renderDetail,
    setup(data) { actor=structuredClone(__actor); settings=structuredClone(__settings); catalog=structuredClone(__catalog); editor.open(data); priceReview=null; renderDetail(); },
    get priceReview(){return priceReview;}, get catalog(){return catalog;}})`, { filename: 'staff.js' }).runInContext(context);
  runtime.setup(fixture());
  return { ...runtime, runtime, calls, responses, node: id => document.getElementById(id),
    async trigger(id, type = 'click', event = {}) { const target = document.getElementById(id); const handler = target.handlers.get(type); assert.ok(handler, `${id}/${type} handler`); return handler({ target, preventDefault() {}, ...event }); },
    async dispatch(target, type, event = {}) { const handler = target.handlers.get(type); assert.ok(handler, `${target.tagName}/${type} handler`); return handler({ target, preventDefault() {}, ...event }); },
  };
}
const updatedPrices = () => fixture({ version: 3, items: [{ ...fixture().order.items[0], unitPriceMinor: 12500, lineTotalMinor: 12500 }], subtotalMinor: 12500, totalMinor: 12500 });
const changedPrices = () => new StaffError('Цены изменились', { status: 409, code: 'prices_changed', details: { priceConfirmationToken: 'price-token', preview: updatedPrices().order, changes: [{ id: 'toast', name: catalog[0].name, previousUnitPriceMinor: 10000, currentUnitPriceMinor: 12500 }] } });

test('a clean claim conflict renders the winning employee, status and saved version immediately', async () => {
  const app = await page(); app.runtime.setup(fixture({ status: 'new', assignee: null }));
  app.responses.push(new StaffError('Уже взят', { status: 409, code: 'already_claimed', details: { current: fixture({ version: 3, assignee: { id: '7', name: 'Другой сотрудник' } }) } }));
  await app.trigger('claim-order'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.editor.detail.order.version, 3); assert.equal(app.node('detail-status').textContent, 'На согласовании');
  assert.match(app.node('detail-owner').textContent, /Другой сотрудник/); assert.match(app.node('detail-version').textContent, /3/);
  assert.equal(app.node('claim-order').hidden, true); assert.equal(app.node('edit-fields').disabled, true);
});

test('totals note follows quantity/add/remove edits and resets after a confirmed save and acceptance', async () => {
  const app = await page();
  const quantity = app.node('edit-items').children[0].children.find(item => item.className === 'staff-item-actions').children[1];
  quantity.value = '2'; await app.dispatch(quantity, 'input');
  assert.match(app.node('totals-note').textContent, /Есть правки/);
  const saved = fixture({ version: 3, items: [{ ...fixture().order.items[0], quantity: 2, lineTotalMinor: 20000 }], subtotalMinor: 20000, totalMinor: 20000 });
  app.responses.push(saved, { items: catalog }); await app.save();
  assert.equal(app.editor.dirty, false); assert.match(app.node('totals-note').textContent, /^Суммы рассчитаны/);
  app.node('guest-agreed').checked = true; app.sync();
  app.responses.push({ ...saved, order: { ...saved.order, status: 'accepted', version: 4 }, integration: { eventId: 'saved-event', status: 'waiting_configuration' } });
  await app.trigger('accept-order'); assert.equal(app.editor.detail.order.status, 'accepted'); assert.match(app.node('totals-note').textContent, /^Суммы рассчитаны/);
  app.runtime.setup(fixture()); await app.dispatch(app.node('menu-results').children[0], 'click'); assert.match(app.node('totals-note').textContent, /Есть правки/);
  app.runtime.setup(fixture()); const remove = app.node('edit-items').children[0].children.find(item => item.className === 'staff-item-actions').children[2];
  await app.dispatch(remove, 'click'); assert.match(app.node('totals-note').textContent, /Есть правки/);
});

test('pickup to delivery does not silently reuse free pickup as an explicitly agreed delivery fee', async () => {
  const app = await page(); const type = app.node('fulfilment-type');
  assert.equal(app.node('delivery-fee').value, '0'); type.value = 'delivery';
  await app.trigger('edit-fields', 'input', { target: type }); await app.trigger('edit-fields', 'change', { target: type });
  assert.equal(app.node('delivery-fee').value, ''); assert.equal(app.editor.draft.deliveryFeeMinor, null);
  assert.equal(app.node('delivery-fee').disabled, false);
  app.node('delivery-fee').value = '0'; await app.trigger('edit-fields', 'input', { target: app.node('delivery-fee') }); assert.equal(app.editor.draft.deliveryFeeMinor, 0);
});

test('approved price save refreshes the menu before enabling the next separate acceptance', async () => {
  const app = await page(); app.node('guest-agreed').checked = true; app.responses.push(changedPrices());
  await app.trigger('accept-order'); assert.equal(app.acceptance.pending, null); assert.equal(app.node('price-review').hidden, false);
  app.node('price-agreed').checked = true; app.sync(); app.responses.push(updatedPrices(), { items: [{ ...catalog[0], price: 125 }] });
  await app.trigger('approve-prices');
  assert.equal(app.runtime.catalog[0].price, 125); assert.equal(app.editor.detail.order.items[0].unitPriceMinor, 12500);
  assert.equal(app.node('price-review').hidden, true); assert.equal(app.node('guest-agreed').checked, false);
  app.node('guest-agreed').checked = true; app.sync(); assert.equal(app.node('accept-order').disabled, false);
  assert.equal(app.calls.at(-1).path, 'api/menu'); assert.equal(app.calls.filter(call => call.path.endsWith('/accept')).length, 1);
});

test('uncertain acceptance keeps its original retry available and can be superseded only by a committed price save', async () => {
  const app = await page(); app.node('guest-agreed').checked = true;
  app.responses.push(new StaffError('Нет ответа', { uncertain: true })); await app.trigger('accept-order'); const original = app.acceptance.pending.body;
  app.responses.push(changedPrices()); await app.trigger('accept-order'); assert.equal(app.acceptance.pending.body, original);
  assert.equal(app.node('accept-order').disabled, false); assert.equal(app.node('approve-prices').disabled, true);
  app.responses.push(changedPrices()); await app.trigger('accept-order'); assert.equal(app.calls.at(-1).body, original);
  app.node('price-agreed').checked = true; app.sync(); assert.equal(app.node('approve-prices').disabled, false);
  app.responses.push(updatedPrices(), { items: [{ ...catalog[0], price: 125 }] }); await app.trigger('approve-prices');
  assert.equal(app.acceptance.pending, null); assert.equal(app.editor.detail.order.version, 3); assert.equal(app.node('guest-agreed').checked, false);
  const patch = app.calls.find(call => call.method === 'PATCH'); assert.equal(patch.body.expectedVersion, 2); assert.equal(patch.body.priceConfirmationToken, 'price-token');
  assert.equal(app.node('accept-order').disabled, true);
});

test('if the original acceptance wins the reprice race, its committed result is rendered readonly', async () => {
  const app = await page(); app.node('guest-agreed').checked = true;
  app.responses.push(new StaffError('Нет ответа', { uncertain: true })); await app.trigger('accept-order');
  app.responses.push(changedPrices()); await app.trigger('accept-order'); app.node('price-agreed').checked = true;
  const accepted = { ...fixture({ version: 3, status: 'accepted' }), integration: { eventId: 'original-event', status: 'waiting_configuration' } };
  app.responses.push(new StaffError('Версия изменилась', { status: 409, code: 'version_conflict', details: { current: accepted } })); await app.trigger('approve-prices');
  assert.equal(app.acceptance.pending, null); assert.equal(app.node('detail-status').textContent, 'Принят'); assert.equal(app.node('edit-fields').disabled, true);
  assert.equal(app.node('integration-panel').hidden, false); assert.equal(app.node('price-review').hidden, true);
});
