import test from 'node:test';
import assert from 'node:assert/strict';
import { permissions, editableOrder, createEditor, acceptanceProblems, integrationText, createAcceptance, createVisiblePoll } from '../staff-model.js';
import { StaffError } from '../staff-client.js';

const actor = { id: '42', name: 'Тестовый сотрудник', role: 'employee' };
const manager = { id: '7', name: 'Тестовый руководитель', role: 'manager' };
const slot = '2030-05-15T12:00:00+03:00';
const order = patch => ({ id: 'a'.repeat(32), number: 'TEST-1', version: 2, status: 'processing', assignee: actor, createdAt: '2030-05-15T06:00:00Z', contact: { phone: '+70000000000', name: 'Тест' },
  fulfilment: { type: 'pickup', timing: 'asap', requestedAt: null, address: null, courierInstructions: '', confirmedAt: slot }, items: [{ id: 'toast', name: 'Тост', quantity: 1, unitPriceMinor: 10000, lineTotalMinor: 10000 }], currency: 'RUB', subtotalMinor: 10000, deliveryFeeMinor: 0, totalMinor: 10000, staffNote: '', fulfillmentComment: '', orderComment: 'Исходный комментарий', ...patch });
const detail = patch => ({ order: order(patch), history: [], integration: null });
const catalog = [{ id: 'toast', name: 'Тост', price: 100, published: true, availableForOrder: true }];

test('role rules require ownership; managers explicitly reassign before editing another employee order', () => {
  assert.equal(permissions(order(), actor).edit, true); assert.equal(permissions(order(), manager).edit, false); assert.equal(permissions(order(), manager).reassign, true);
  assert.equal(permissions(order({ status: 'new', assignee: null }), actor).claim, true); assert.equal(permissions(order({ status: 'new', assignee: null }), actor).cancel, false); assert.equal(permissions(order({ status: 'new', assignee: null }), manager).cancel, true);
  for (const status of ['accepted', 'cancelled']) { const rights = permissions(order({ status }), actor); assert.equal(rights.edit, false); assert.equal(rights.accept, false); assert.equal(rights.cancel, false); }
  assert.ok(Object.values(permissions(order({ status: 'new', assignee: null }), null)).every(value => value === false));
});
test('dirty drafts survive polling conflicts and are replaced only by explicit discard', () => {
  const editor = createEditor(); editor.open(detail()); const draft = editableOrder(editor.detail.order); draft.staffNote = 'Не терять правку'; editor.edit(draft);
  assert.equal(editor.dirty, true);
  const fresh = detail({ version: 3, staffNote: 'Чужая сохранённая правка', assignee: manager });
  assert.equal(editor.receive(fresh), 'conflict'); assert.equal(editor.draft.staffNote, 'Не терять правку'); assert.equal(editor.detail.order.version, 2); assert.equal(editor.incoming.order.version, 3);
  editor.discard(); assert.equal(editor.detail.order.version, 3); assert.equal(editor.draft.staffNote, 'Чужая сохранённая правка'); assert.equal(editor.dirty, false); assert.equal(editor.conflict, false);
});
test('poll responses cannot replace another order or an older saved version; field order does not cause phantom dirtiness', () => {
  const editor = createEditor(); editor.open(detail()); const draft = editableOrder(editor.detail.order); draft.fulfilment = Object.fromEntries(Object.entries(draft.fulfilment).reverse()); editor.edit(draft);
  assert.equal(editor.dirty, false); assert.equal(editor.receive(detail({ id: 'b'.repeat(32), version: 5 })), 'ignored'); assert.equal(editor.receive(detail({ version: 1 })), 'ignored');
  assert.equal(editor.receive(detail({ version: 3, staffNote: 'Saved' })), 'updated'); assert.equal(editor.draft.staffNote, 'Saved');
});
test('a delayed response cannot downgrade the newest pending conflict while a local draft is dirty', () => {
  const editor = createEditor(); editor.open(detail()); editor.edit({ ...editor.draft, staffNote: 'Local draft' });
  assert.equal(editor.receive(detail({ version: 4, staffNote: 'Newest saved draft' })), 'conflict');
  assert.equal(editor.receive(detail({ version: 3, staffNote: 'Older saved draft' })), 'ignored');
  assert.equal(editor.incoming.order.version, 4); assert.equal(editor.draft.staffNote, 'Local draft');
  editor.discard(); assert.equal(editor.detail.order.version, 4); assert.equal(editor.draft.staffNote, 'Newest saved draft');
});
test('acceptance requires saved and agreed specific time, known delivery, current menu and owner', () => {
  const options = { catalog, now: Date.parse('2030-05-15T07:00:00Z'), agreed: true, availability: { pickup: { slots: [slot] } } };
  assert.deepEqual(acceptanceProblems(order(), actor, options), []);
  assert.ok(acceptanceProblems(order(), actor, { ...options, dirty: true }).some(text => /сохраните/.test(text)));
  assert.ok(acceptanceProblems(order(), actor, { ...options, conflict: true }).some(text => /версия/.test(text)));
  assert.ok(acceptanceProblems(order(), actor, { ...options, agreed: false }).some(text => /Подтвердите/.test(text)));
  assert.ok(acceptanceProblems(order({ fulfilment: { ...order().fulfilment, confirmedAt: null } }), actor, options).some(text => /конкретное/.test(text)));
  assert.ok(acceptanceProblems(order(), actor, { ...options, availability: { pickup: { slots: [] } } }).some(text => /расписании/.test(text)));
  assert.ok(acceptanceProblems(order({ deliveryFeeMinor: null, totalMinor: null }), actor, options).some(text => /стоимость/.test(text)));
  assert.ok(acceptanceProblems(order(), actor, { ...options, catalog: [{ ...catalog[0], availableForOrder: false }] }).some(text => /недоступное/.test(text)));
  assert.ok(acceptanceProblems(order(), actor, { ...options, catalog: [{ ...catalog[0], price: 110 }] }).some(text => /Цены/.test(text)));
});
test('accept timeout preserves exact body and header key and ignores changed retry parameters', async () => {
  const calls = []; let attempt = 0;
  const accepted = { ...detail({ status: 'accepted', version: 3 }), integration: { eventId: 'event-1', status: 'waiting_configuration' } };
  const command = createAcceptance(async (id, body, key) => { calls.push({ id, body, key }); if (++attempt === 1) throw new StaffError('timeout', { uncertain: true }); return accepted; }, () => 'unique-key');
  await assert.rejects(command.run('a'.repeat(32), 2)); assert.ok(command.pending);
  await command.run('b'.repeat(32), 99); assert.deepEqual(calls[1], calls[0]); assert.equal(JSON.parse(calls[0].body).idempotencyKey, calls[0].key); assert.equal(command.pending, null);
});
test('malformed 2xx never confirms acceptance and subsequent 403 keeps the original request pending', async () => {
  let attempt = 0; const command = createAcceptance(async () => { if (++attempt === 1) return {}; throw new StaffError('denied', { status: 403 }); }, () => 'key');
  await assert.rejects(command.run('a'.repeat(32), 2), error => error.uncertain === true); const frozen = command.pending.body;
  await assert.rejects(command.run('a'.repeat(32), 3)); assert.equal(command.pending.body, frozen);
  assert.equal(command.observe({ ...detail({ status: 'accepted', version: 3 }), integration: { eventId: 'saved-event' } }), true); assert.equal(command.pending, null);
});
test('double-click accepts only once and an accepted response needs its committed event', async () => {
  let release; let calls = 0;
  const command = createAcceptance(() => { calls++; return new Promise(resolve => { release = resolve; }); }, () => 'key');
  const first = command.run('a'.repeat(32), 2); await assert.rejects(command.run('a'.repeat(32), 2), /Дождитесь/); assert.equal(calls, 1);
  release(detail({ status: 'accepted' })); await assert.rejects(first, error => error.uncertain === true); assert.ok(command.pending);
});
test('uncertain acceptance can be superseded only by a committed newer non-accepted revision of that order', async () => {
  const command = createAcceptance(async () => { throw new StaffError('timeout', { uncertain: true }); }, () => 'key');
  await assert.rejects(command.run('a'.repeat(32), 2));
  assert.equal(command.superseded(detail({ version: 2 })), false);
  assert.equal(command.superseded(detail({ id: 'b'.repeat(32), version: 3 })), false);
  assert.equal(command.superseded(detail({ version: 3, status: 'accepted' })), false);
  assert.ok(command.pending);
  assert.equal(command.superseded(detail({ version: 3, status: 'processing' })), true); assert.equal(command.pending, null);
});
test('polling refreshes only while visible, keeps running after failure and stops cleanly', async () => {
  let visible = true; let calls = 0; let next; let clears = 0;
  const poll = createVisiblePoll(async () => { calls++; if (calls === 1) throw new Error('network'); }, { isVisible: () => visible, set: callback => { next = callback; return 1; }, clear: () => { clears++; }, interval: 15000 });
  poll.start(); await next(); assert.equal(calls, 1); visible = false; await next(); assert.equal(calls, 1);
  visible = true; await poll.wake(); assert.equal(calls, 2); poll.stop(); await next(); assert.equal(calls, 2); assert.ok(clears >= 1);
});
test('integration receipt never claims the cash register created or paid an order', () => {
  assert.match(integrationText({ status: 'waiting_configuration', cashRegisterStatus: 'not_configured' }).delivery, /Ожидает подключения/);
  const received = integrationText({ status: 'delivered', cashRegisterStatus: 'unconfirmed' }); assert.equal(received.delivery, 'Данные доставлены интегратору.'); assert.match(received.cashRegister, /нет подтверждения/);
  assert.match(integrationText({ status: 'failed' }).delivery, /требуется внимание/);
});
