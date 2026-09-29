import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Socket } from 'node:net';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { enrollmentQr, MAX_ENROLLMENT_URI_BYTES } from '../server/qr.mjs';

// Public synthetic test value only; never read real enrollment state or .data.
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
function uriFor(label = 'Восемь утра:admin@example.test', issuer = 'Восемь утра') {
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${SECRET}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function decodePng(dataUrl) {
  assert.match(dataUrl, /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
  const encoded = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
  assert.deepEqual([...encoded.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(encoded.length < 64 * 1024, 'The bounded QR stays a small inline image');
  const png = PNG.sync.read(encoded);
  assert.equal(png.width, 400);
  assert.equal(png.height, 400);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height, { inversionAttempts: 'dontInvert' });
  assert.ok(decoded, 'Independent jsQR decoder can read the generated PNG');
  return { png, decoded };
}

test('independent PNG/QR decoders recover the exact Cyrillic TOTP enrollment URI', async () => {
  const uri = uriFor();
  const { png, decoded } = decodePng(await enrollmentQr(uri));
  assert.equal(decoded.data, uri);
  const parsed = new URL(decoded.data);
  assert.equal(decodeURIComponent(parsed.pathname.slice(1)), 'Восемь утра:admin@example.test');
  assert.equal(parsed.searchParams.get('secret'), SECRET);
  assert.equal(parsed.searchParams.get('issuer'), 'Восемь утра');
  assert.equal(parsed.searchParams.get('algorithm'), 'SHA1');
  assert.equal(parsed.searchParams.get('digits'), '6');
  assert.equal(parsed.searchParams.get('period'), '30');
  // A white quiet zone remains around the whole symbol, not just at one corner.
  for (let offset = 0; offset < 400; offset++) {
    for (const [x, y] of [[offset, 0], [offset, 399], [0, offset], [399, offset]]) {
      const index = (y * 400 + x) * 4;
      assert.deepEqual([...png.data.subarray(index, index + 4)], [255, 255, 255, 255]);
    }
  }
});

test('long valid account labels round-trip with UTF-8 and percent-encoded characters intact', async () => {
  const uri = uriFor(`Восемь утра:${'a'.repeat(240)}+tag@example.test`, 'Восемь утра & кофе');
  assert.ok(Buffer.byteLength(uri) < MAX_ENROLLMENT_URI_BYTES);
  assert.equal(decodePng(await enrollmentQr(uri)).decoded.data, uri);
});

test('the maximum accepted URI remains readable and one extra byte is rejected', async () => {
  const labelBytes = MAX_ENROLLMENT_URI_BYTES - Buffer.byteLength(uriFor(''));
  const uri = uriFor('x'.repeat(labelBytes));
  assert.equal(Buffer.byteLength(uri), MAX_ENROLLMENT_URI_BYTES);
  assert.equal(decodePng(await enrollmentQr(uri)).decoded.data, uri);
  await assert.rejects(enrollmentQr(`${uri}&`), /Некорректная ссылка/);
});

test('QR generation is in-memory with no network requests, file writes or secret logs', async (t) => {
  const forbidden = () => { throw new Error('Unexpected external side effect'); };
  const socket = t.mock.method(Socket.prototype, 'connect', forbidden);
  const fetch = t.mock.method(globalThis, 'fetch', forbidden);
  const write = t.mock.method(fs, 'writeFile', forbidden);
  const writeSync = t.mock.method(fs, 'writeFileSync', forbidden);
  const log = t.mock.method(console, 'log', forbidden);
  const warn = t.mock.method(console, 'warn', forbidden);
  const error = t.mock.method(console, 'error', forbidden);
  assert.equal(decodePng(await enrollmentQr(uriFor())).decoded.data, uriFor());
  for (const mock of [socket, fetch, write, writeSync, log, warn, error]) assert.equal(mock.mock.callCount(), 0);
});

test('invalid or oversized enrollment input is rejected without exposing its secret', async () => {
  const invalid = [
    undefined, null, 42, {}, '', 'not a uri', `https://example.test/?secret=${SECRET}`,
    uriFor().replace('otpauth://totp/', 'otpauth://hotp/'),
    `otpauth://totp/?secret=${SECRET}`, `otpauth://totp/label?secret=short`,
    `otpauth://totp/label?secret=${SECRET}&secret=${SECRET}`,
    `otpauth://totp/label?secret=${SECRET}#fragment`,
    `otpauth://user:password@totp/label?secret=${SECRET}`,
    `otpauth://totp/label?secret=${SECRET}\n`,
    `otpauth://totp/%0Alabel?secret=${SECRET}`,
    uriFor('x'.repeat(MAX_ENROLLMENT_URI_BYTES)),
    uriFor().replace(SECRET, 'A'.repeat(129)),
  ];
  for (const value of invalid) {
    await assert.rejects(enrollmentQr(value), (error) => {
      assert.equal(error.message, 'Некорректная ссылка настройки приложения-аутентификатора.');
      assert.ok(!String(error).includes(SECRET));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});
