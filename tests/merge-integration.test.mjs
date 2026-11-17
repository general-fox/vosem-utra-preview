import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');

test('merged homepage keeps cookies, menu and cart with one entry per module', async () => {
  const html = await read('index.html');
  assert.doesNotMatch(html, /^(?:<<<<<<<|=======|>>>>>>>)/m);
  for (const name of ['cookies.js', 'menu.js', 'cart.js']) {
    const sources = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1].split('?')[0]);
    assert.equal(sources.filter(source => source === name).length, 1, name);
  }
  assert.equal((html.match(/\bdata-cookie-settings\b/g) || []).length, 1);
  assert.match(html, /name="robots" content="noindex, nofollow"/);
  assert.doesNotMatch(html, /rel="canonical"/);
  assert.match(html, /id="menu"/);
  assert.match(html, /id="club"/);
});

test('imported catalog policy documents registration and FlashCall without disabled order storage', async () => {
  const html = await read('privacy.html');
  assert.doesNotMatch(html, /^(?:<<<<<<<|=======|>>>>>>>)/m);
  assert.equal((html.match(/id="cookies"/g) || []).length, 1);
  for (const key of ['vosem_cookie_choice', 'vosem_loyalty', '_GRECAPTCHA', 'vosem_admin']) {
    assert.ok(html.includes(key), key);
  }
  assert.doesNotMatch(html, /vosem_cart_v1|vosem_order_guest/);
  assert.match(html, /id="phone-verification"/);
  assert.match(html, /FlashCall/);
  assert.match(html, /Только необходимые/);
  assert.match(html, /name="robots" content="noindex, nofollow"/);
});

test('REG build does not inject a second copy of the homepage cookie module', async () => {
  const source = await read('scripts/build-reg.mjs');
  assert.doesNotMatch(source, /html\s*=\s*html\.replace\([^\n]*cookies\.js/);
  assert.doesNotMatch(source, /html\s*=\s*html\.replace\([^\n]*data-cookie-settings/);
});
