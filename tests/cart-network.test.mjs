import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJson, fetchCatalog, createSubmission } from '../order-client.js';
import { validateReceipt } from '../checkout-model.js';

function environment(t, fetcher, configured = '') {
  const originals = Object.fromEntries(['document', 'location', 'fetch'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  globalThis.document = { querySelector: () => ({ content: configured }) };
  globalThis.location = new URL('https://example.github.io/cafe/checkout.html');
  globalThis.fetch = fetcher;
  t.after(() => { for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
test('API requests use explicit base, guest cookie, CSRF and the supplied exact body', async t => {
  const calls = [];
  environment(t, async (url, options) => { calls.push({ url: String(url), options }); return json({ order: {} }); }, 'https://api.example.test/');
  const body = '{"quoteId":"q","idempotencyKey":"same"}';
  await requestJson('api/orders', { method: 'POST', body, key: 'same', csrf: 'guest-csrf' });
  assert.equal(calls[0].url, 'https://api.example.test/api/orders'); assert.equal(calls[0].options.body, body); assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.headers['X-CSRF-Token'], 'guest-csrf'); assert.equal(calls[0].options.headers['Idempotency-Key'], 'same'); assert.equal(calls[0].options.cache, 'no-store');
});
test('static Pages menu is visibly unverified and keeps the project URL prefix', async t => {
  const requests = [];
  environment(t, async url => { requests.push(String(url)); return requests.length === 1 ? new Response('Not found', { status: 404 }) : json({ items: [{ id: 'toast' }] }); });
  const result = await fetchCatalog({ allowStatic: true }); assert.equal(result.live, false); assert.equal(result.revision, null);
  assert.deepEqual(requests, ['https://example.github.io/cafe/api/menu', 'https://example.github.io/cafe/data/menu.json']);
});
test('server failure never silently loads seed menu as fresh prices', async t => {
  let requests = 0;
  environment(t, async () => { requests++; return new Response('Server failed', { status: 500, headers: { 'Content-Type': 'text/html' } }); });
  await assert.rejects(fetchCatalog({ allowStatic: true })); assert.equal(requests, 1);
});
test('a timeout or malformed successful JSON cannot be taken as an order receipt', async t => {
  let attempt = 0;
  environment(t, async () => { if (attempt++ === 0) throw new TypeError('Connection lost'); return new Response('html', { headers: { 'Content-Type': 'text/html' } }); });
  await assert.rejects(requestJson('api/orders', { method: 'POST', body: '{}' }), error => error.uncertain === true);
  await assert.rejects(requestJson('api/orders', { method: 'POST', body: '{}' }), error => error.uncertain === true);
});
test('server field errors and fresh quote conflicts remain available for the form', async t => {
  let attempt = 0;
  environment(t, async () => attempt++ === 0 ? json({ error: 'Проверьте телефон', code: 'invalid_order', details: { field: 'phone' } }, 422) : json({ error: 'Сумма изменилась', code: 'quote_changed', details: { quote: { totalMinor: 12300 } } }, 409));
  await assert.rejects(requestJson('api/orders/quote', { method: 'POST', body: '{}' }), error => error.data.details.field === 'phone' && !error.uncertain);
  await assert.rejects(requestJson('api/orders', { method: 'POST', body: '{}' }), error => error.data.details.quote.totalMinor === 12300 && error.code === 'quote_changed');
});
test('a malformed 2xx retains idempotency until a valid saved receipt arrives', async t => {
  const bodies = [];
  const receipt = { number: 'TEST-1', status: 'new', createdAt: '2030-05-15T08:30:00Z', currency: 'RUB', items: [{ id: 'toast', name: 'Тост', quantity: 1, unitPriceMinor: 10000, lineTotalMinor: 10000 }], subtotalMinor: 10000, deliveryFeeMinor: 0, totalMinor: 10000, fulfilment: { type: 'pickup' } };
  environment(t, async (_url, options) => { bodies.push(options.body); return bodies.length === 1 ? json({}) : json({ order: receipt }); });
  const submission = createSubmission(async (body, key) => validateReceipt(await requestJson('api/orders', { method: 'POST', body, key, csrf: 'csrf' })), () => 'same-key');
  await assert.rejects(submission.submit({ quoteId: 'q1' }), error => error.uncertain); assert.equal(submission.pending, true);
  const saved = await submission.submit({ quoteId: 'different' }); assert.equal(saved.number, 'TEST-1'); assert.equal(submission.pending, false); assert.equal(bodies[0], bodies[1]);
});
