import { createHmac, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function encodeBase32(bytes) {
  let bits = 0; let value = 0; let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; output += ALPHABET[(value >>> bits) & 31]; }
  }
  if (bits) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}
export function decodeBase32(input) {
  const text = input.toUpperCase().replace(/=+$/, '');
  if (!/^[A-Z2-7]+$/.test(text)) throw new Error('Invalid base32');
  let bits = 0; let value = 0; const output = [];
  for (const character of text) {
    value = (value << 5) | ALPHABET.indexOf(character); bits += 5;
    if (bits >= 8) { bits -= 8; output.push((value >>> bits) & 255); }
  }
  return Buffer.from(output);
}
export function totp(secret, { time = Date.now(), period = 30, digits = 6, algorithm = 'sha1', counter } = {}) {
  const step = counter ?? Math.floor(time / 1000 / period);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(step));
  const digest = createHmac(algorithm, typeof secret === 'string' ? decodeBase32(secret) : secret).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(number % (10 ** digits)).padStart(digits, '0');
}
export function verifyTotp(secret, code, { time = Date.now(), lastCounter = -1, window = 1 } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(time / 30_000);
  for (const offset of [0, -1, 1].filter((value) => Math.abs(value) <= window)) {
    const counter = current + offset;
    if (counter < 0 || counter <= lastCounter) continue;
    if (timingSafeEqual(Buffer.from(totp(secret, { counter })), Buffer.from(code))) return counter;
  }
  return null;
}
