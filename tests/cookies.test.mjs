import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const source = read('cookies.js');
const KEY = 'vosem_cookie_choice';
function fixture(store = new Map()) {
  const elements = {};
  const element = name => elements[name] ??= {
    hidden: false, isConnected: true, dataset: {}, textContent: '', listeners: {}, offsetHeight: 150,
    addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute() {},
    focus() { context.document.activeElement = this; }, contains: target => Object.values(elements).includes(target),
    querySelector: selector => element(selector), querySelectorAll: () => [accept, decline],
  };
  const accept = element('accept'), decline = element('decline'), settings = element('settings');
  accept.dataset.cookieChoice = 'all'; decline.dataset.cookieChoice = 'necessary';
  const events = {};
  const context = {
    Set, Number, JSON, Promise, Date,
    localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    document: { activeElement: settings, hidden: false, createElement: () => element('banner'), querySelectorAll: () => [settings],
      documentElement: { style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {} } },
      body: { appendChild() {} }, addEventListener() {} },
    addEventListener: (type, fn) => events[type] = fn,
  };
  context.window = context;
  vm.runInNewContext(source.replace('export const cookieConsent =', 'globalThis.cookieConsent ='), context);
  return { api: context.cookieConsent, store, events, elements, banner: element('banner'),
    accept: () => accept.listeners.click(), decline: () => decline.listeners.click(),
    open: () => settings.listeners.click(), close: () => element('.cookie-banner-close').listeners.click() };
}

test('short cookie notice is identical locally and on hosting, with a same-site policy link', () => {
  assert.equal(source, read('hosting/legacy-public/cookies.js'));
  const markup = source.match(/banner.innerHTML = `([\s\S]*?)`;/)[1];
  assert.match(markup, /Мы используем cookie\. Подробнее — в/);
  assert.match(markup, /href="privacy.html#cookies"/);
  assert.doesNotMatch(markup, /IP-адрес|данные браузера|Google reCAPTCHA|github\.io/);
  assert.match(markup, /data-cookie-choice="necessary"/);
});

test('shortening copy preserves refusal, persistence, withdrawal and registration consent', async () => {
  let f = fixture();
  assert.equal(f.store.size, 0);
  assert.equal(f.api.allowed(), false);
  assert.equal(f.banner.hidden, false);
  f.decline(); assert.equal(f.banner.hidden, true); assert.equal(f.api.allowed(), false);
  f = fixture(f.store); assert.equal(f.banner.hidden, true);
  let pending = f.api.request();
  assert.match(f.elements['.cookie-banner-status'].textContent, /проверка Google/);
  f.close(); assert.equal(await pending, false);
  pending = f.api.request(); f.accept(); assert.equal(await pending, true);
  f = fixture(f.store); assert.equal(f.api.allowed(), true); assert.equal(f.banner.hidden, true);
  let allowed; f.api.subscribe(value => allowed = value);
  f.open(); f.decline(); assert.equal(allowed, false);
  pending = f.api.request();
  f.store.set(KEY, JSON.stringify({ ...JSON.parse(f.store.get(KEY)), choice: 'all' }));
  f.events.storage({ key: KEY });
  assert.equal(await pending, false, 'Consent in another tab must not submit a form');
});

test('both privacy pages distinguish public search indexing from visitor analytics', () => {
  for (const file of ['privacy.html', 'hosting/legacy-public/privacy.html']) {
    const policy = read(file);
    assert.match(policy, /href="#search-engines"/);
    assert.match(policy, /id="search-engines">10\./);
    assert.match(policy, /Яндексом, Google/);
    assert.match(policy, /Яндекс Метрика и Google Analytics на сайте не подключены/);
    assert.match(policy, /не публикует данные анкет гостей, заказов/);
    assert.match(policy, /id="final">11\./);
  }
});
