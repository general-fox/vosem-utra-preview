import test from 'node:test';
import assert from 'node:assert/strict';
import { kdsStatusView, trackingIdFromHash } from '../kds-status.js';

test('only confirmed KDS states claim acceptance; uncertain results never encourage resubmission', () => {
  for (const state of ['queued', 'preparing', 'sending', 'Pending']) {
    const view = kdsStatusView({ state }); assert.equal(view.poll, true); assert.doesNotMatch(view.title, /^Принят/);
  }
  assert.equal(kdsStatusView({ state: 'Accepted' }).title, 'Принят в КДС');
  for (const state of ['unknown', 'missing', 'blocked', 'Canceled', 'Closed']) assert.equal(kdsStatusView({ state }).poll, false);
  assert.match(kdsStatusView({ state: 'unknown' }).description, /повторная отправка остановлена/);
  assert.equal(kdsStatusView({ state: 'unrecognized' }).poll, true);
});
test('reload references accept only local random order IDs, without guest data or external credentials', () => {
  const id = '1234567890abcdef1234567890abcdef';
  assert.equal(trackingIdFromHash(`#order=${id}`), id);
  for (const hash of ['', '#order=6', '#order=../api/admin', `#order=${id}&password=anything`, '#menu']) assert.equal(trackingIdFromHash(hash), null);
});
