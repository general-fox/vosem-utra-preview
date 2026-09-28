import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, formatPhone, createSubmission, OrderError, resolveApiBase } from '../order-client.js';
import { localSlot, validateDraft, validateQuote, validateReceipt } from '../checkout-model.js';
const slot = '2030-05-15T11:30:00+03:00';
const config = { settings: { timezone: 'Europe/Moscow', consent: { version: 'test-v1' }, maxLines: 50, maxQuantity: 99 }, availability: { pickup: { asap: true, slots: [slot] }, delivery: { asap: true, slots: [slot] } } };
const fields = patch => ({ type: 'pickup', timing: 'asap', phone: '8 (900) 000-00-00', name: '', city: '', streetHouse: '', apartment: '', entrance: '', floor: '', intercom: '', courierInstructions: '', date: '', slot: '', orderComment: '', consent: true, ...patch });
const lines = [{ id: 'toast', qty: 2 }];
const instant = Date.parse('2030-05-15T06:00:00Z');
const quote = patch => ({ quoteId: 'quote-1', menuRevision: 2, expiresAt: '2030-05-15T08:40:00Z', currency: 'RUB', items: [{ id: 'toast', name: 'Тост', quantity: 2, unitPriceMinor: 45000, lineTotalMinor: 90000 }], subtotalMinor: 90000, deliveryFeeMinor: 0, totalMinor: 90000, fulfilment: { type: 'pickup', timing: 'asap', requestedAt: null, address: null }, ...patch });
test('pickup has null address, asap has null date, optional name is allowed', () => {
  const result = validateDraft(fields({ city: 'Old address', courierInstructions: 'private old note', date: '2030-05-15', slot }), lines, config, instant);
  assert.deepEqual(result.errors, {}); assert.equal(result.body.fulfilment.address, null); assert.equal(result.body.fulfilment.requestedAt, null); assert.equal(result.body.fulfilment.courierInstructions, ''); assert.equal(result.body.contact.name, ''); assert.equal(result.body.contact.phone, '+79000000000');
});
test('fulfilment is conscious, delivery requires address and comments stay separate', () => {
  assert.ok(validateDraft(fields({ type: '' }), lines, config, instant).errors.type);
  const invalid = validateDraft(fields({ type: 'delivery' }), lines, config, instant); assert.ok(invalid.errors.city); assert.ok(invalid.errors['street-house']);
  const valid = validateDraft(fields({ type: 'delivery', city: 'Тестовый город', streetHouse: 'Тестовая улица, 1', courierInstructions: 'Вход со двора', orderComment: 'Без соли' }), lines, config, instant);
  assert.deepEqual(valid.errors, {}); assert.equal(valid.body.fulfilment.courierInstructions, 'Вход со двора'); assert.equal(valid.body.orderComment, 'Без соли'); assert.equal(valid.body.fulfilment.address.apartment, '');
});
test('scheduled time requires explicit date and an allowed non-past server slot', () => {
  const missing = validateDraft(fields({ timing: 'scheduled' }), lines, config, instant); assert.ok(missing.errors['requested-date']); assert.ok(missing.errors['requested-time']);
  assert.ok(validateDraft(fields({ timing: 'scheduled', date: '2030-05-16', slot }), lines, config, instant).errors['requested-time']);
  assert.ok(validateDraft(fields({ timing: 'scheduled', date: '2030-05-15', slot }), lines, config, Date.parse(slot) + 1).errors['requested-time']);
  assert.ok(validateDraft(fields({ timing: 'scheduled', date: '2030-05-15', slot: '2030-05-15T12:30:00+03:00' }), lines, config, instant).errors['requested-time']);
  const valid = validateDraft(fields({ timing: 'scheduled', date: '2030-05-15', slot }), lines, config, instant); assert.deepEqual(valid.errors, {}); assert.equal(valid.body.fulfilment.requestedAt, slot);
  assert.deepEqual(localSlot(slot), { date: '2030-05-15', time: '11:30', label: '15.05.2030', value: slot });
});
test('closed asap, comment length, consent and configured technical limits reject before quoting', () => {
  assert.ok(validateDraft(fields(), lines, { ...config, availability: { pickup: { asap: false, slots: [] } } }, instant).errors.timing);
  assert.ok(validateDraft(fields({ orderComment: 'x'.repeat(1001), consent: false }), lines, config, instant).errors['order-comment']);
  assert.ok(validateDraft(fields({ consent: false }), lines, config, instant).errors.consent);
  assert.ok(validateDraft(fields(), lines, { ...config, settings: { ...config.settings, maxQuantity: 1 } }, instant).errors.basket);
});
test('Russian phone normalization and mask preserve unsupported explicit country codes as errors', () => {
  assert.equal(normalizePhone('+7 (900) 000-00-00'), '+79000000000'); assert.equal(normalizePhone('8 900 000 00 00'), '+79000000000'); assert.equal(normalizePhone('9000000000'), '+79000000000');
  assert.equal(normalizePhone('+44 20 7183 8750'), null); assert.equal(normalizePhone('+4420718387'), null); assert.equal(normalizePhone('123'), null);
  assert.equal(formatPhone('89000000000'), '+7 (900) 000-00-00'); assert.equal(formatPhone('+44 20'), '+44 20');
});
test('quote validates totals and keeps unknown delivery as null', () => {
  const draft = validateDraft(fields(), lines, config, instant).body; assert.equal(validateQuote(quote(), draft).totalMinor, 90000);
  assert.throws(() => validateQuote(quote({ totalMinor: 1 }), draft)); assert.throws(() => validateQuote(quote({ items: [] }), draft));
  const deliveryDraft = { ...draft, fulfilment: { type: 'delivery' } };
  const estimate = quote({ deliveryFeeMinor: null, totalMinor: null, fulfilment: { type: 'delivery' } }); assert.equal(validateQuote(estimate, deliveryDraft).totalMinor, null);
  assert.throws(() => validateQuote({ ...estimate, totalMinor: 90000 }, deliveryDraft));
});
test('malformed successful responses cannot confirm order persistence', () => {
  for (const bad of [{}, { order: {} }, { order: quote() }, { order: { ...quote(), number: '123', status: 'accepted' } }]) assert.throws(() => validateReceipt(bad), error => error.uncertain === true);
  assert.equal(validateReceipt({ order: { ...quote(), number: 'test-123', status: 'new', createdAt: '2030-05-15T08:30:00Z' } }).number, 'test-123');
});
test('uncertain retry freezes exact request and key; even subsequent 403 cannot unlock it', async () => {
  const sent = []; let attempt = 0; let keys = 0;
  const submission = createSubmission(async (body, key) => { sent.push({ body, key }); attempt++; if (attempt === 1) throw new OrderError('timeout', { uncertain: true }); if (attempt === 2) throw new OrderError('csrf', { status: 403 }); return { saved: true }; }, () => `key-${++keys}`);
  await assert.rejects(submission.submit({ quoteId: 'q1', contact: { phone: '+79000000000' } })); assert.equal(submission.pending, true);
  await assert.rejects(submission.submit({ quoteId: 'changed' })); assert.equal(submission.pending, true);
  assert.deepEqual(await submission.submit({ quoteId: 'changed-again' }), { saved: true }); assert.equal(submission.pending, false);
  assert.deepEqual(sent[1], sent[0]); assert.deepEqual(sent[2], sent[0]); assert.equal(keys, 1); assert.equal(JSON.parse(sent[0].body).idempotencyKey, 'key-1');
});
test('double-click submits once; known quote conflict permits a consciously revised request', async () => {
  let release; let calls = 0;
  const submission = createSubmission(() => { calls++; return new Promise(resolve => { release = resolve; }); }, () => 'key');
  const first = submission.submit({ quoteId: 'q1' }); await assert.rejects(submission.submit({ quoteId: 'q1' }), /Дождитесь/); assert.equal(calls, 1); release({ saved: true }); await first;
  let attempts = 0; const retry = createSubmission(async () => { if (++attempts === 1) throw new OrderError('changed', { status: 409, code: 'quote_changed' }); return {}; }, () => `key-${attempts}`);
  await assert.rejects(retry.submit({ quoteId: 'old' })); assert.equal(retry.pending, false); await retry.submit({ quoteId: 'reviewed' }); assert.equal(attempts, 2);
});
test('API base respects Pages prefix and rejects insecure or credential-bearing configuration', () => {
  assert.equal(resolveApiBase('https://example.github.io/cafe/checkout.html').href, 'https://example.github.io/cafe/');
  assert.equal(resolveApiBase('https://example.github.io/cafe/', 'https://api.example.test').href, 'https://api.example.test/');
  assert.throws(() => resolveApiBase('https://example.test/', 'http://api.example.test/')); assert.throws(() => resolveApiBase('https://example.test/', 'https://user:secret@example.test/'));
});
