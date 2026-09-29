import test from 'node:test';
import assert from 'node:assert/strict';
import { createStaffClient } from '../staff-client.js';
import { createDemoClient } from '../staff-demo.js';
import { readFileSync } from 'node:fs';
const token = 'a'.repeat(64); const now = Date.parse('2030-05-15T08:00:00Z');
const session = { token, expiresAt: '2030-05-15T10:00:00Z', staff: { id: '42', name: 'Тест', role: 'employee' } };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('raw Telegram data is exchanged once and opaque token goes only in Bearer header', async () => {
  const calls = []; const client = createStaffClient({ href: 'https://example.test/staff.html', now: () => now, fetcher: async (url, options) => { calls.push({ url: String(url), options }); return response(calls.length === 1 ? session : { orders: [], total: 0 }); } });
  await assert.rejects(client.login('')); assert.equal(calls.length, 0);
  await client.login('user=raw%26data&auth_date=123&hash=raw');
  assert.deepEqual(JSON.parse(calls[0].options.body), { initData: 'user=raw%26data&auth_date=123&hash=raw' }); assert.equal(calls[0].options.headers.Authorization, undefined);
  await client.request('api/staff/orders/search', { method: 'POST', body: { query: '+70000000000', page: 1 } });
  assert.equal(calls[1].url, 'https://example.test/api/staff/orders/search'); assert.equal(calls[1].options.headers.Authorization, `Bearer ${token}`); assert.equal(calls[1].options.credentials, 'omit'); assert.equal(calls[1].options.cache, 'no-store'); assert.ok(!calls[1].url.includes('7000'));
});
test('accept passes the frozen key in its header, while session expires after at most two hours', async () => {
  let current = now; const calls = []; const client = createStaffClient({ href: 'https://example.test/', now: () => current, fetcher: async (url, options) => { calls.push({ url: String(url), options }); return response(calls.length === 1 ? { ...session, expiresAt: '2030-05-16T10:00:00Z' } : {}); } });
  await client.login('raw'); await client.request('api/staff/orders/abc/accept', { method: 'POST', body: '{"idempotencyKey":"same"}', key: 'same', mutation: true });
  assert.equal(calls[1].options.headers['Idempotency-Key'], 'same'); current += 7200001;
  await assert.rejects(client.request('api/staff/orders/search'), error => error.status === 401); assert.equal(calls.length, 2);
});
test('401 and local logout forget the token without relying on persistent browser storage', async () => {
  let calls = 0; const client = createStaffClient({ href: 'https://example.test/', now: () => now, fetcher: async () => ++calls === 1 ? response(session) : response({ code: 'session_expired', error: 'Expired' }, 401) });
  await client.login('raw'); await assert.rejects(client.request('api/staff/session')); await assert.rejects(client.request('api/staff/session')); assert.equal(calls, 2);
  const source = readFileSync(new URL('../staff-client.js', import.meta.url), 'utf8') + readFileSync(new URL('../staff.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|initDataUnsafe/);
});
test('mutations treat network loss and non-JSON success as uncertain and preserve version conflict details', async () => {
  let calls = 0; const client = createStaffClient({ href: 'https://example.test/', now: () => now, fetcher: async () => { if (++calls === 1) return response(session); if (calls === 2) throw Error('lost'); if (calls === 3) return new Response('<html>', { headers: { 'Content-Type': 'text/html' } }); return response({ error: 'Changed', code: 'version_conflict', details: { current: { order: { version: 3 } } } }, 409); } });
  await client.login('raw'); await assert.rejects(client.request('api/staff/orders/abc', { method: 'PATCH', body: {}, mutation: true }), error => error.uncertain === true);
  await assert.rejects(client.request('api/staff/orders/abc', { method: 'PATCH', body: {}, mutation: true }), error => error.uncertain === true);
  await assert.rejects(client.request('api/staff/orders/abc', { method: 'PATCH', body: {}, mutation: true }), error => error.details.current.order.version === 3 && !error.uncertain);
});
test('standalone demo has no Telegram SDK and its local workflow uses no network', async t => {
  const original = globalThis.fetch; globalThis.fetch = () => { throw new Error('Demo must not contact a server'); }; t.after(() => { globalThis.fetch = original; });
  const html = readFileSync(new URL('../staff-demo.html', import.meta.url), 'utf8'); assert.doesNotMatch(html, /telegram\.org\/js/); assert.match(html, /data-staff-demo="true"/);
  const client = createDemoClient(); const { staff } = await client.login(); const settings = await client.request('api/staff/settings');
  const list = await client.request('api/staff/orders/search', { method: 'POST', body: { status: 'new', mine: false, date: null, query: '', page: 1, pageSize: 25 } });
  let detail = await client.request(`api/staff/orders/${list.orders[0].id}/claim`, { method: 'POST', body: { expectedVersion: 1 } }); assert.equal(detail.order.assignee.id, staff.id);
  const order = detail.order; const payload = { expectedVersion: order.version, items: order.items.map(({ id, quantity }) => ({ id, quantity })), contact: order.contact, fulfilment: { ...order.fulfilment, confirmedAt: settings.availability.pickup.slots[0] }, deliveryFeeMinor: 0, staffNote: 'Тестовая заметка', fulfillmentComment: '' };
  detail = await client.request(`api/staff/orders/${order.id}`, { method: 'PATCH', body: payload });
  const acceptance = { expectedVersion: detail.order.version, idempotencyKey: 'same-demo-key', agreed: true };
  const accepted = await client.request(`api/staff/orders/${order.id}/accept`, { method: 'POST', body: acceptance });
  assert.equal(accepted.order.status, 'accepted'); assert.equal(accepted.integration.status, 'waiting_configuration');
  const repeat = await client.request(`api/staff/orders/${order.id}/accept`, { method: 'POST', body: acceptance }); assert.deepEqual(repeat, accepted);
});
