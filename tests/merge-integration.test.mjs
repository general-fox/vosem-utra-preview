import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { profileHtml } from '../scripts/site-profile.mjs';

const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');

test('homepage keeps cookies, menu and workshop once; cart requires an explicit delivery profile', async () => {
  const html = await read('index.html');
  assert.doesNotMatch(html, /^(?:<<<<<<<|=======|>>>>>>>)/m);
  for (const [name, page, delivery] of [['GitHub source', html, false], ['catalog build', profileHtml(html, false), false], ['delivery build', profileHtml(html, true), true]]) {
    const sources = [...page.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1].split('?')[0]);
    for (const module of ['cookies.js', 'menu.js', 'workshop.js']) assert.equal(sources.filter(source => source === module).length, 1, name + ': ' + module);
    assert.equal(sources.filter(source => source === 'cart.js').length, Number(delivery), name + ': cart script');
    assert.equal((page.match(/href="cart\.css"/g) || []).length, Number(delivery), name + ': cart stylesheet');
    assert.equal((page.match(/\bdata-cart-open\b/g) || []).length, Number(delivery), name + ': cart entry');
    assert.ok(page.includes('name="cafe-profile" content="' + (delivery ? 'delivery' : 'catalog') + '"'), name + ': profile');
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
