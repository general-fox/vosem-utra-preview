import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import QRCode from 'qrcode';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { normalizeMenuCategories, normalizeMenuData, categoryDescendantIds, categoryPath, orderedCategories } from '../menu-categories.js';

const source = await readFile(new URL('../admin.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../admin.html', import.meta.url), 'utf8');

// Exercise the real event handlers without opening a browser or making network calls.
async function page(session = { authenticated: false, configured: true, mfaRequired: true, production: true },
  { qrRenderer = QRCode.toDataURL, storage = new Map(), tabStorage = new Map(), responsesAfterSession = [], profile = 'delivery' } = {}) {
  let now = 2_000_000_000_000;
  const nodes = new Map();
  const calls = [];
  const responses = [{ body: session }, ...responsesAfterSession];
  const timers = new Map();
  const windowHandlers = new Map();
  const documentHandlers = new Map();
  const broadcasts = [];
  let channel;
  const qrCalls = [];
  const document = {
    activeElement: null,
    visibilityState: 'visible',
    addEventListener(name, handler) { documentHandlers.set(name, handler); },
    getElementById(id) {
      assert.ok(nodes.has(id), `Missing HTML element: ${id}`);
      return nodes.get(id);
    },
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    createElementNS: () => makeNode(),
  };
  function makeNode(attributes = new Map(), hidden = false) {
    const handlers = new Map();
    const classes = new Set();
    return {
      value: attributes.get('value') || '', type: attributes.get('type') || '', hidden, disabled: false, checked: false,
      textContent: '', open: false, dataset: {}, attributes, handlers, children: [],
      inputMode: attributes.get('inputmode') || '', autocomplete: attributes.get('autocomplete') || '',
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      toggleAttribute(name, force) { if (force) attributes.set(name, ''); else attributes.delete(name); },
      addEventListener(name, handler) { handlers.set(name, handler); },
      focus() { document.activeElement = this; },
      close() { this.open = false; },
      showModal() { this.open = true; },
      reset() {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      querySelector(selector) {
        const attributes = [...selector.matchAll(/\[data-item-(id|action)="([^"]+)"\]/g)];
        const walk = node => [node, ...node.children.flatMap(walk)];
        return walk(this).find(node => attributes.length && attributes.every(([, key, value]) => node.dataset[key === 'id' ? 'itemId' : 'itemAction'] === value)) || null;
      },
      style: { removeProperty(name) { delete this[name]; } },
      scrollTop: 0,
      classList: { toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); }, add(...names) { names.forEach(name => classes.add(name)); }, remove(...names) { names.forEach(name => classes.delete(name)); }, contains(name) { return classes.has(name); } },
    };
  }
  for (const match of html.matchAll(/<([a-z][a-z\d-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const attributes = new Map([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((entry) => [entry[1], entry[2]]));
    nodes.set(match[3], makeNode(attributes, /\bhidden\b/.test(match[2])));
  }
  nodes.get('site-profile').setAttribute('content', profile);
  const context = vm.createContext({
    document, Intl, URL, AbortController, normalizeMenuCategories, normalizeMenuData, categoryDescendantIds, categoryPath, orderedCategories,
    crypto: { randomUUID: () => 'new-dish-test-id' },
    Date: class extends Date { static now() { return now; } },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    sessionStorage: { getItem: (key) => tabStorage.get(key) ?? null, setItem: (key, value) => tabStorage.set(key, value), removeItem: (key) => tabStorage.delete(key) },
    BroadcastChannel: class { constructor() { channel = this; } postMessage(data) { broadcasts.push(data); } },
    setTimeout(callback, delay) { const id = Symbol(); timers.set(id, { callback, delay, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    location: { href: 'https://example.test/admin.html', origin: 'https://example.test' },
    window: { addEventListener(name, handler) { windowHandlers.set(name, handler); }, confirm: () => true },
    // Inject the installed renderer at the module-loading boundary; production uses a Vite local chunk.
    __loadLocalQr: async () => ({ default: { toDataURL: async (text, options) => { qrCalls.push({ text, options }); return qrRenderer(text, options); } } }),
    fetch: async (url, options) => {
      calls.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
      const response = responses.shift();
      assert.ok(response, `Unexpected request: ${url}`);
      if (response.wait) await response.wait;
      if (response.error) throw response.error;
      const status = response.status || 200;
      const body = response.body?.authenticated === true && !Object.hasOwn(response.body, 'session')
        ? { ...response.body, session: { idleTimeoutMs: 900000, idleExpiresAt: now + 900000, expiresAt: now + 28800000, serverNow: now } }
        : response.body;
      return { ok: status >= 200 && status < 300, status, headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/json' : response.headers?.[name.toLowerCase()] ?? null }, json: async () => body };
    },
  });
  const runtimeSource = source.replace(/^import .* from '\.\/menu-categories\.js';\r?\n/, '').replace("await import('qrcode')", 'await __loadLocalQr()');
  const runtime = await new vm.Script(`(async () => {\n${runtimeSource}\nreturn { state, auth, draft, categoryDraft, idle, sessionExpired, validUsername, validateMenu, openEditor, openCategoryManager, openCashGroup, setMenuMode, itemCard, render, loadMenu, lockSession, checkSession };\n})()`, { filename: 'admin.js' }).runInContext(context);
  async function settle() { for (let index = 0; index < 20; index += 1) await Promise.resolve(); }
  return {
    ...runtime, calls, responses, timers, qrCalls, broadcasts, document, storage, tabStorage,
    now: () => now,
    settle,
    async activity(type = 'pointerdown', isTrusted = true) { documentHandlers.get(type)?.({ isTrusted }); await settle(); },
    async documentEvent(type) { await documentHandlers.get(type)?.({}); await settle(); },
    async remote(data) { channel.onmessage?.({ data }); await settle(); },
    async advance(ms, { suspended = false } = {}) {
      const target = now + ms;
      if (!suspended) {
        while (true) {
          const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
          if (!next) break;
          now = next[1].at;
          timers.delete(next[0]);
          next[1].callback();
          await settle();
        }
      }
      now = target;
      await settle();
    },
    node: (id) => document.getElementById(id),
    async trigger(id, event = 'click', eventValues = {}) {
      const handler = document.getElementById(id).handlers.get(event);
      assert.ok(handler, `Missing handler: ${id}/${event}`);
      await handler({ preventDefault() {}, ...eventValues });
    },
    windowEvent(name) { return windowHandlers.get(name)?.({ preventDefault() {} }); },
    expireEnrollment() {
      const timer = [...timers.values()].find((value) => value.delay === 300000);
      assert.ok(timer, 'An enrollment expiry timer must be scheduled');
      timer.callback();
    },
  };
}

async function passwordStep(app, username = 'cafe-admin') {
  app.node('username').value = username;
  app.node('password').value = 'example-password-only-for-tests';
  app.responses.push({ status: 202, body: { mfaRequired: true, challengeToken: 'memory-only-challenge' } });
  await app.trigger('login-form', 'submit');
}

const passwordSession = { authenticated:false, configured:true, ready:true, production:true, mfaRequired:false, authMode:'password' };

test('password login opens the menu directly and logout returns to the password form', async () => {
  const app=await page(passwordSession);app.node('username').value='owner@example.test';app.node('password').value='fixture-password';
  assert.doesNotMatch(app.node('device-login-help').textContent,/приложения|Яндекс/);
  app.responses.push({body:{authenticated:true,authMode:'password',username:'owner@example.test',csrfToken:'password-csrf'}});
  app.responses.push({body:{items:[],revision:'r1'}});
  await app.trigger('login-form','submit');
  assert.equal(app.node('dashboard').hidden,false);assert.equal(app.node('verify-form').hidden,true);
  assert.equal(app.node('logout-forget').hidden,true);
  assert.equal(app.calls.some(call=>/\/verify|\/resume|\/enroll\//.test(call.url)),false);
  app.responses.push({body:passwordSession});await app.trigger('logout');
  assert.equal(app.node('login-form').hidden,false);assert.equal(app.node('verify-form').hidden,true);
  assert.equal(app.node('password').value,'');
});

test('password mode ignores stale device identity and handles first password replacement without QR', async () => {
  const app=await page({...passwordSession,trustedUsername:'owner@example.test'});
  assert.equal(app.node('login-form').hidden,false);
  app.node('username').value='owner@example.test';app.node('password').value='temporary-fixture-password';
  app.responses.push({status:202,body:{authMode:'password',passwordChangeRequired:true,passwordToken:'a'.repeat(64)}});
  await app.trigger('login-form','submit');
  assert.equal(app.node('reset-password-form').hidden,false);assert.equal(app.node('dashboard').hidden,true);
  assert.equal(app.node('enrollment-form').hidden,true);assert.equal(app.tabStorage.size,0);
  app.node('reset-password').value='new-test-password';app.node('reset-password-confirm').value='new-test-password';
  app.responses.push({body:{passwordChanged:true}});await app.trigger('reset-password-form','submit');
  assert.equal(app.node('login-form').hidden,false);assert.doesNotMatch(app.node('session-lock-note').textContent,/приложения|Яндекс/);
});

test('password mode rejects a stale MFA response and never opens a QR or code step', async () => {
  const app=await page(passwordSession);app.node('username').value='owner@example.test';app.node('password').value='fixture-password';
  app.responses.push({status:202,body:{mfaRequired:true,challengeToken:'stale-server'}});
  await app.trigger('login-form','submit');
  assert.equal(app.node('dashboard').hidden,true);assert.equal(app.node('verify-form').hidden,true);
  assert.match(app.node('login-error').textContent,/не подтвердил вход/);
});

test('password recovery checks email code before accepting a new password and still requires normal MFA login', async () => {
  const app = await page();
  app.node('username').value = 'owner@example.test';
  await app.trigger('forgot-password');
  assert.equal(app.node('login-form').hidden, true);
  assert.equal(app.node('reset-email').value, 'owner@example.test');
  app.responses.push({ status: 202, body: { resetToken: 'a'.repeat(64), retryAfter: 60 } });
  await app.trigger('reset-request-form', 'submit');
  assert.equal(app.node('reset-code-form').hidden, false);
  assert.equal(app.node('reset-resend').disabled, true);
  assert.deepEqual(app.calls.at(-1).body, { email: 'owner@example.test' });
  app.node('reset-code').value = '01234567';
  app.responses.push({ body: { passwordToken: 'b'.repeat(64) } });
  await app.trigger('reset-code-form', 'submit');
  assert.equal(app.node('reset-password-form').hidden, false);
  assert.equal(app.node('reset-code').value, '');
  app.node('reset-password').value = 'a-good-new-password';
  app.node('reset-password-confirm').value = 'does-not-match';
  const before = app.calls.length;
  await app.trigger('reset-password-form', 'submit');
  assert.equal(app.calls.length, before);
  assert.match(app.node('reset-password-error').textContent, /не совпадают/);
  app.node('reset-password-confirm').value = 'a-good-new-password';
  app.responses.push({ body: { passwordChanged: true } });
  await app.trigger('reset-password-form', 'submit');
  assert.equal(app.node('login-form').hidden, false);
  assert.equal(app.node('dashboard').hidden, true);
  assert.equal(app.node('reset-password').value, '');
  assert.equal(app.node('reset-password-confirm').value, '');
  assert.equal(app.state.csrfToken, '');
  assert.match(app.node('session-lock-note').textContent, /Пароль изменён/);
  assert.equal(app.storage.size, 0);
  await passwordStep(app, 'owner@example.test');
  assert.equal(app.node('verify-form').hidden, false);
  assert.equal(app.node('dashboard').hidden, true);
});

test('recovery resend waits sixty seconds; invalid code does not advance or expose protected menu', async () => {
  const app = await page(); await app.trigger('forgot-password');
  app.node('reset-email').value = 'owner@example.test';
  app.responses.push({ status: 202, body: { resetToken: 'c'.repeat(64), retryAfter: 60 } });
  await app.trigger('reset-request-form', 'submit');
  const count = app.calls.length; await app.trigger('reset-resend'); assert.equal(app.calls.length, count);
  await app.advance(60000); assert.equal(app.node('reset-resend').disabled, false);
  app.node('reset-code').value = '12345678';
  app.responses.push({ status: 400, body: { error: 'Код неверный', code: 'invalid_reset' } });
  await app.trigger('reset-code-form', 'submit');
  assert.equal(app.node('reset-password-form').hidden, true);
  assert.match(app.node('reset-code-error').textContent, /Код неверный/);
  app.responses.push({ status: 202, body: { resetToken: 'd'.repeat(64), retryAfter: 60 } });
  await app.trigger('reset-resend');
  assert.equal(app.node('reset-code').value, '');
  await app.trigger('reset-code-back');
  assert.equal(app.node('login-form').hidden, false);
  assert.equal(app.node('reset-email').value, '');
});

test('unconfigured mail has a useful error and pagehide discards recovery secrets and late responses', async () => {
  const app = await page(); await app.trigger('forgot-password');
  app.node('reset-email').value = 'owner@example.test';
  app.responses.push({ status: 503, body: { error: 'Отправка кодов пока не настроена.', code: 'reset_unavailable' } });
  await app.trigger('reset-request-form', 'submit');
  assert.match(app.node('reset-request-error').textContent, /не настроена/);
  assert.equal(app.node('reset-code-form').hidden, true);
  let release;
  app.responses.push({ wait: new Promise(resolve => { release = resolve; }), body: { resetToken: 'e'.repeat(64) } });
  const pending = app.trigger('reset-request-form', 'submit');
  await app.settle(); app.windowEvent('pagehide'); release(); await pending;
  assert.equal(app.node('reset-code-form').hidden, true);
  assert.equal(app.node('login-form').hidden, false);
  assert.equal(app.node('reset-email').value, '');
  assert.equal(app.storage.size, 0);
});

async function requestRecovery(app) {
  await app.trigger('forgot-password'); app.node('reset-email').value = 'owner@example.test';
  app.responses.push({ status: 202, body: { resetToken: 'c'.repeat(64), expiresIn: 600, retryAfter: 60 } });
  await app.trigger('reset-request-form', 'submit');
}

test('request throttle displays the server wait and becomes available without reloading', async () => {
  const app = await page(); await app.trigger('forgot-password'); app.node('reset-email').value = 'owner@example.test';
  app.responses.push({ status: 429, headers: { 'retry-after': '180' }, body: { error: 'Слишком много попыток.', code: 'rate_limit' } });
  await app.trigger('reset-request-form', 'submit');
  assert.match(app.node('reset-request-wait').textContent, /3:00/);
  assert.equal(app.node('reset-request-submit').disabled, true);
  const calls = app.calls.length; await app.trigger('reset-request-form', 'submit'); assert.equal(app.calls.length, calls);
  await app.advance(180000);
  assert.equal(app.node('reset-request-submit').disabled, false);
  assert.equal(app.node('reset-request-wait').hidden, true);
});

test('resend throttle preserves the current code and never blocks its verification', async () => {
  const app = await page(); await requestRecovery(app); await app.advance(60000);
  app.node('reset-code').value = '01234567';
  app.responses.push({ status: 429, headers: { 'retry-after': '180' }, body: { error: 'Код уже запрошен.', code: 'rate_limit' } });
  await app.trigger('reset-resend');
  assert.match(app.node('reset-resend').textContent, /3:00/);
  assert.equal(app.node('reset-code').disabled, false);
  assert.equal(app.node('reset-code').value, '01234567');
  assert.equal(app.node('reset-code-submit').disabled, false);
  app.responses.push({ body: { passwordToken: 'd'.repeat(64) } });
  await app.trigger('reset-code-form', 'submit');
  assert.equal(app.calls.at(-1).body.resetToken, 'c'.repeat(64));
  assert.equal(app.node('reset-password-form').hidden, false);
  assert.equal(app.tabStorage.size, 0);
});

test('code verification throttle counts down separately from sending email', async () => {
  const app = await page(); await requestRecovery(app); await app.advance(60000);
  app.node('reset-code').value = '01234567';
  const date = new Date(app.now() + 120000).toUTCString();
  app.responses.push({ status: 429, headers: { 'retry-after': date }, body: { error: 'Слишком много попыток.', code: 'rate_limit' } });
  await app.trigger('reset-code-form', 'submit');
  assert.match(app.node('reset-code-wait').textContent, /2:00/);
  assert.equal(app.node('reset-code-submit').disabled, true);
  assert.equal(app.node('reset-resend').disabled, false);
  assert.equal(app.node('reset-code').disabled, false);
  await app.advance(120000); assert.equal(app.node('reset-code-submit').disabled, false);
});

test('expired email code has a clear next action while a new email can be requested', async () => {
  const app = await page(); await requestRecovery(app); await app.advance(600000);
  assert.match(app.node('reset-code-help').textContent, /Срок действия кода истёк/);
  assert.equal(app.node('reset-code-submit').disabled, true);
  assert.equal(app.node('reset-resend').disabled, false);
  const calls = app.calls.length; app.node('reset-code').value = '01234567';
  await app.trigger('reset-code-form', 'submit'); assert.equal(app.calls.length, calls);
  app.responses.push({ body: { resetToken: 'd'.repeat(64), expiresIn: 600, retryAfter: 60 } });
  await app.trigger('reset-resend'); assert.equal(app.node('reset-code-submit').disabled, false);
  assert.match(app.node('reset-code-help').textContent, /10:00/);
});

test('reload and return from email retain only a pending mail handle, never code/password grants', async () => {
  const app = await page(); await requestRecovery(app); app.node('reset-code').value = '01234567';
  await app.advance(30000); app.windowEvent('pagehide');
  assert.equal(app.node('reset-code').value, '');
  assert.doesNotMatch([...app.tabStorage.values()].join(''), /01234567|passwordToken/);
  await app.windowEvent('pageshow');
  assert.equal(app.node('reset-code-form').hidden, false);
  assert.match(app.node('reset-resend').textContent, /0:30/);
  const refreshed = await page(undefined, { tabStorage: app.tabStorage });
  assert.equal(refreshed.node('reset-code-form').hidden, false);
  assert.equal(refreshed.calls.length, 1); // No additional email request.
  refreshed.node('reset-code').value = '01234567';
  refreshed.responses.push({ body: { passwordToken: 'd'.repeat(64) } });
  await refreshed.trigger('reset-code-form', 'submit');
  assert.equal(refreshed.calls.at(-1).body.resetToken, 'c'.repeat(64));
  assert.equal(refreshed.tabStorage.size, 0);
  refreshed.windowEvent('pagehide'); await refreshed.windowEvent('pageshow');
  assert.equal(refreshed.node('reset-password-form').hidden, true);
  assert.equal(refreshed.node('login-form').hidden, false);
});

test('untrusted or expired stored recovery data cannot create a password step or auth session', async () => {
  for (const stored of [
    { token: 'broken', email: 'owner@example.test', retryAt: 0, verifyAt: 0, expiresAt: 2_000_000_100_000 },
    { token: 'c'.repeat(64), email: 'owner@example.test', retryAt: 0, verifyAt: 0, expiresAt: 1 },
  ]) {
    const app = await page(undefined, { tabStorage: new Map([['vosem-utra-password-reset', JSON.stringify({ ...stored, passwordToken: 'd'.repeat(64) })]]) });
    assert.equal(app.node('login-form').hidden, false); assert.equal(app.node('reset-password-form').hidden, true);
    assert.equal(app.tabStorage.size, 0); assert.equal(app.state.csrfToken, '');
  }
});

test('already-have-code opens verification during a send limit without requesting any email', async () => {
  const app = await page(); await app.trigger('forgot-password');
  app.node('reset-email').value = 'owner@example.test';
  app.responses.push({ status: 429, headers: { 'retry-after': '180' }, body: { error: 'Код уже запрошен.', code: 'rate_limit' } });
  await app.trigger('reset-request-form', 'submit');
  assert.equal(app.node('reset-request-submit').disabled, true);
  assert.equal(app.node('reset-have-code').disabled, false);
  const before = app.calls.length; await app.trigger('reset-have-code');
  assert.equal(app.calls.length, before);
  assert.equal(app.node('reset-code-form').hidden, false);
  assert.equal(app.node('reset-code-submit').disabled, false);
  assert.equal(app.node('reset-resend').disabled, true);
  assert.match(app.node('reset-delivery-note').textContent, /Новое письмо не отправлялось/);
  app.windowEvent('pagehide'); await app.windowEvent('pageshow');
  assert.equal(app.node('reset-code-form').hidden, false);
  const fresh = await page(undefined, { tabStorage: app.tabStorage });
  assert.equal(fresh.node('reset-code-form').hidden, false);
  fresh.node('reset-code').value = '01234567';
  fresh.responses.push({ body: { passwordToken: 'd'.repeat(64) } });
  await fresh.trigger('reset-code-form', 'submit');
  assert.deepEqual(fresh.calls.at(-1).body, { email: 'owner@example.test', code: '01234567' });
  assert.equal(fresh.node('reset-password-form').hidden, false);
  assert.equal(fresh.tabStorage.size, 0);
});

test('already-have-code validates the email locally and the previous hourly client timer is shortened', async () => {
  const app = await page(); await app.trigger('forgot-password');
  const before = app.calls.length; await app.trigger('reset-have-code');
  assert.match(app.node('reset-request-error').textContent, /Укажите почту/); assert.equal(app.calls.length, before);
  const tabStorage = new Map([['vosem-utra-password-reset', JSON.stringify({ token: 'c'.repeat(64), email: 'owner@example.test', retryAt: app.now()+1800000, verifyAt: 0, expiresAt: app.now()+600000 })]]);
  const fresh = await page(undefined,{ tabStorage });
  assert.match(fresh.node('reset-resend').textContent, /3:00/);
  await fresh.advance(60000); fresh.windowEvent('pagehide'); await fresh.windowEvent('pageshow');
  assert.match(fresh.node('reset-resend').textContent, /2:00/); // Returning does not restart the wait.
});

function successfulVerify(app) {
  app.responses.push({ body: { authenticated: true, csrfToken: 'csrf-after-mfa' } });
  app.responses.push({ body: { items: [], revision: 'revision-1' } });
}

test('password validation opens the second step without granting menu access; OTP completes login', async () => {
  const app = await page();
  assert.equal(app.node('username').autocomplete, 'username');
  await passwordStep(app);
  assert.deepEqual(app.calls[1].body, { username: 'cafe-admin', password: 'example-password-only-for-tests' });
  assert.equal(app.calls.length, 2);
  assert.equal(app.state.csrfToken, '');
  assert.equal(app.node('dashboard').hidden, true);
  assert.equal(app.node('password').value, '');
  assert.equal(app.node('login-form').hidden, true);
  assert.equal(app.node('verify-form').hidden, false);
  assert.equal(app.auth.challengeToken, 'memory-only-challenge');
  app.node('verification-code').value = '001234';
  successfulVerify(app);
  await app.trigger('verify-form', 'submit');
  assert.deepEqual(app.calls[2].body, { challengeToken: 'memory-only-challenge', code: '001234' });
  assert.equal(app.calls[2].headers['X-CSRF-Token'], undefined);
  assert.equal(app.calls[3].url, '/api/admin/menu');
  assert.equal(app.state.csrfToken, 'csrf-after-mfa');
  assert.equal(app.node('dashboard').hidden, false);
  assert.equal(app.auth.challengeToken, '');
  assert.equal(app.node('verification-code').value, '');
});

test('failed verification remains retryable and back discards the challenge and entered secrets', async () => {
  const app = await page();
  await passwordStep(app);
  app.node('verification-code').value = '111111';
  app.responses.push({ status: 401, body: { error: 'Не удалось подтвердить вход.' } });
  await app.trigger('verify-form', 'submit');
  assert.equal(app.node('verification-error').textContent, 'Не удалось подтвердить вход.');
  assert.equal(app.node('verify-submit').disabled, false);
  assert.equal(app.auth.challengeToken, 'memory-only-challenge');
  assert.equal(app.node('verification-code').value, '');
  assert.equal(app.node('dashboard').hidden, true);
  app.node('verification-code').value = '222222';
  await app.trigger('auth-back');
  assert.equal(app.auth.challengeToken, '');
  assert.equal(app.node('verification-code').value, '');
  assert.equal(app.node('password').value, '');
  assert.equal(app.node('login-form').hidden, false);
  assert.equal(app.node('verify-form').hidden, true);
  assert.equal(app.node('username').value, 'cafe-admin');
});

test('recovery mode accepts a full text code without numeric validation', async () => {
  const app = await page();
  await passwordStep(app);
  await app.trigger('code-mode');
  const input = app.node('verification-code');
  assert.equal(input.inputMode, 'text');
  assert.equal(input.autocomplete, 'off');
  assert.equal(input.getAttribute('pattern'), null);
  input.value = 'ABCD-EFGH-IJKL';
  successfulVerify(app);
  await app.trigger('verify-form', 'submit');
  assert.equal(app.calls[2].body.code, 'ABCD-EFGH-IJKL');
  assert.equal(app.state.csrfToken, 'csrf-after-mfa');
  assert.equal(app.auth.recovery, false);
});

test('an unconfigured production account shows setup guidance and blocks login until rechecked', async () => {
  const app = await page({ authenticated: false, configured: false, mfaRequired: true, production: true });
  assert.equal(app.node('auth-setup').hidden, false);
  assert.equal(app.node('login-form').hidden, true);
  assert.equal(app.node('login-submit').disabled, true);
  await app.trigger('login-form', 'submit');
  assert.equal(app.calls.length, 1);
  app.responses.push({ body: { authenticated: false, configured: true, mfaRequired: true, production: true } });
  await app.trigger('check-setup');
  assert.equal(app.node('auth-setup').hidden, true);
  assert.equal(app.node('login-form').hidden, false);
  assert.equal(app.node('login-submit').disabled, false);
});

test('password-only success does not bypass MFA even in a local legacy configuration', async () => {
  const app = await page({ authenticated: false, configured: true, mfaRequired: false, production: false });
  app.node('username').value = 'admin';
  app.node('password').value = 'example-local-test-password';
  app.responses.push({ body: { authenticated: true, csrfToken: 'unexpected-password-only-session' } });
  await app.trigger('login-form', 'submit');
  assert.equal(app.state.csrfToken, '');
  assert.equal(app.node('dashboard').hidden, true);
  assert.equal(app.calls.length, 2);
  const production = await page();
  production.node('username').value = 'admin';
  production.node('password').value = 'example-local-test-password';
  production.responses.push({ body: { authenticated: true, csrfToken: 'unexpected-password-only-session' } });
  await production.trigger('login-form', 'submit');
  assert.equal(production.state.csrfToken, '');
  assert.equal(production.node('dashboard').hidden, true);
  assert.equal(production.calls.length, 2);
});

test('an incomplete challenge never opens the second step or loads menu data', async () => {
  const app = await page();
  app.node('username').value = 'admin';
  app.node('password').value = 'example-password-only-for-tests';
  app.responses.push({ status: 202, body: { mfaRequired: true } });
  await app.trigger('login-form', 'submit');
  assert.equal(app.node('verify-form').hidden, true);
  assert.equal(app.node('login-error').hidden, false);
  assert.equal(app.node('password').value, '');
  assert.equal(app.state.csrfToken, '');
  assert.equal(app.calls.length, 2);
});

test('session expiry clears challenge/code state while preserving an open menu draft', async () => {
  const app = await page();
  await passwordStep(app);
  app.state.csrfToken = 'expired-session';
  app.node('editor-dialog').open = true;
  app.node('verification-code').value = '123456';
  app.responses.push({ body: { authenticated: false, trustedUsername: 'cafe-admin' } });
  app.sessionExpired({ status: 401 });
  assert.equal(app.auth.challengeToken, '');
  assert.equal(app.node('verification-code').value, '');
  assert.equal(app.state.csrfToken, '');
  assert.equal(app.draft.resume, true);
  assert.equal(app.node('verify-form').hidden, false);
});

test('an expired challenge returns to the password step and cannot be reused', async () => {
  const app = await page();
  await passwordStep(app);
  app.node('verification-code').value = '111111';
  app.responses.push({ status: 410, body: { error: 'Время подтверждения истекло. Войдите снова.', code: 'challenge_expired' } });
  await app.trigger('verify-form', 'submit');
  assert.equal(app.auth.challengeToken, '');
  assert.equal(app.node('verification-code').value, '');
  assert.equal(app.node('verify-form').hidden, true);
  assert.equal(app.node('login-form').hidden, false);
  assert.equal(app.node('login-error').textContent, 'Время подтверждения истекло. Войдите снова.');
  await app.trigger('verify-form', 'submit');
  assert.equal(app.calls.length, 3);
});

test('ready=false blocks production login even when an account exists', async () => {
  const app = await page({ authenticated: false, configured: true, mfaRequired: true, production: true, ready: false });
  assert.equal(app.auth.setupRequired, true);
  assert.equal(app.node('auth-setup').hidden, false);
  assert.equal(app.node('login-submit').disabled, true);
});

test('username validation rejects a leading punctuation character before any login request', async () => {
  const app = await page();
  assert.equal(app.node('username').getAttribute('pattern'), null, 'A legacy-only HTML pattern must not reject email logins');
  assert.equal(app.node('username').getAttribute('type'), 'text', 'type=email would reject existing non-email logins');
  for (const username of ['.admin', '_admin', '-admin']) {
    assert.equal(app.validUsername(username), false);
    app.node('username').value = username;
    app.node('password').value = 'example-password-only-for-tests';
    await app.trigger('login-form', 'submit');
    assert.equal(app.calls.length, 1);
    assert.equal(app.node('login-error').hidden, false);
  }
  assert.equal(app.validUsername('Admin-1._'), true);
  assert.equal(app.validUsername('1admin'), true);
});

test('an email login opens the Yandex Key challenge and still requires its six-digit code', async () => {
  const app = await page();
  assert.equal(app.node('username').value, '', 'The public form must not prefill an administrator email');
  assert.equal(app.node('username').getAttribute('maxlength'), '254');
  assert.equal(app.validUsername('Cafe.Owner+menu@Example.Test'), true);
  await passwordStep(app, ' Cafe.Owner+menu@Example.Test ');
  assert.equal(app.calls[1].body.username, 'Cafe.Owner+menu@Example.Test');
  assert.equal(app.node('verify-form').hidden, false);
  assert.equal(app.node('dashboard').hidden, true);
  assert.equal(app.node('verification-label').textContent, 'Код из Яндекс ID (Ключ)');
  assert.match(app.node('verification-help').textContent, /выберите «Восемь утра»/);
  await app.trigger('code-mode');
  assert.equal(app.node('verification-label').textContent, 'Резервный код');
  await app.trigger('code-mode');
  assert.equal(app.node('verification-label').textContent, 'Код из Яндекс ID (Ключ)');
  app.node('verification-code').value = '001234';
  successfulVerify(app);
  await app.trigger('verify-form', 'submit');
  assert.equal(app.calls[2].body.code, '001234');
  assert.equal(app.node('dashboard').hidden, false);
});

test('malformed or oversized email addresses are rejected before login reaches the server', async () => {
  const app = await page();
  const invalid = [
    '.owner@example.test', 'owner.@example.test', 'owner..name@example.test',
    'owner@@example.test', 'owner@example', 'owner@-example.test', 'owner@example-.test',
    'owner@exam_ple.test', 'owner@ex..test', 'владелец@example.test',
    'owner @example.test', 'owner\n@example.test', '\towner@example.test',
    `${'a'.repeat(65)}@example.test`, `owner@${'a'.repeat(64)}.test`,
    `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`,
  ];
  for (const username of invalid) {
    assert.equal(app.validUsername(username), false, `Must reject ${JSON.stringify(username)}`);
    app.node('username').value = username;
    app.node('password').value = 'example-password-only-for-tests';
    await app.trigger('login-form', 'submit');
    assert.equal(app.calls.length, 1);
    assert.equal(app.node('login-error').hidden, false);
  }
  const longestValid = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
  assert.equal(longestValid.length, 254);
  assert.equal(app.validUsername(longestValid), true);
});

const enrollmentSession = { authenticated: false, configured: true, mfaRequired: true, production: true, ready: false, enrollmentAvailable: true };
const enrollmentStart = {
  enrollmentToken: 'pending-enrollment-token',
  otpauthUri: 'otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP',
  secret: 'JBSWY3DPEHPK3PXP', qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=', expiresIn: 300,
};
const recoveryCodes = ['aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa', 'bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb'];

async function enrollmentPasswordStep(app, requiresNewPassword = false) {
  app.node('username').value = 'admin';
  app.node('password').value = 'existing-password-for-tests';
  app.responses.push({ status: 202, body: { enrollmentRequired: true, challengeToken: 'enrollment-challenge', username: 'admin', requiresNewPassword } });
  await app.trigger('login-form', 'submit');
}

async function showTestQr(app) {
  await enrollmentPasswordStep(app);
  app.responses.push({ body: enrollmentStart });
  await app.trigger('enrollment-form', 'submit');
}

async function confirmTestEnrollment(app) {
  app.node('enrollment-code').value = '001234';
  app.responses.push({ body: { authenticated: true, csrfToken: 'enrolled-csrf-token', recoveryCodes } });
  await app.trigger('enrollment-verify-form', 'submit');
}

function assertEnrollmentSecretsCleared(app) {
  assert.equal(app.node('enrollment-qr-image').getAttribute('src'), null);
  assert.equal(app.node('enrollment-secret').textContent, '');
  assert.equal(app.node('enrollment-code').value, '');
  assert.equal(app.auth.enrollmentToken, '');
  assert.equal(app.auth.challengeToken, '');
  assert.equal(app.node('enrollment-password').value, '');
  assert.equal(app.node('enrollment-password-confirm').value, '');
}

test('an available first enrollment permits password login but reveals setup data only after validation', async () => {
  const app = await page(enrollmentSession);
  assert.equal(app.node('login-form').hidden, false);
  assert.equal(app.node('login-submit').disabled, false);
  assert.equal(app.node('auth-setup').hidden, true);
  assert.equal(app.node('enrollment-form').hidden, true);
  assert.equal(app.node('enrollment-username').value, '');
  assert.equal(app.node('enrollment-qr-image').getAttribute('src'), null);
  await enrollmentPasswordStep(app, true);
  assert.equal(app.node('enrollment-form').hidden, false);
  assert.equal(app.node('enrollment-username').value, 'v.utra@yandex.ru');
  assert.equal(app.node('enrollment-password').required, true);
  assert.equal(app.node('password').value, '');
  assert.equal(app.node('dashboard').hidden, true);
  assert.equal(app.state.csrfToken, '');
  await app.trigger('enrollment-form', 'submit');
  assert.equal(app.calls.length, 2, 'A required new password cannot be omitted');
  app.node('enrollment-password').value = 'new-password-for-tests';
  app.node('enrollment-password-confirm').value = 'does-not-match-password';
  await app.trigger('enrollment-form', 'submit');
  assert.equal(app.calls.length, 2, 'A mismatched confirmation cannot start enrollment');
  app.node('enrollment-password-confirm').value = 'new-password-for-tests';
  app.responses.push({ body: enrollmentStart });
  await app.trigger('enrollment-form', 'submit');
  assert.equal(app.calls[2].url, '/api/admin/enroll/start');
  assert.deepEqual(app.calls[2].body, { challengeToken: 'enrollment-challenge', username: 'v.utra@yandex.ru', password: 'new-password-for-tests' });
  assert.equal(app.node('enrollment-password').value, '');
  assert.equal(app.node('enrollment-password-confirm').value, '');
  assert.equal(app.node('enrollment-qr-image').getAttribute('src'), enrollmentStart.qrDataUrl);
});

test('new password minimum is eight in HTML, help and enrollment validation', async () => {
  for (const required of [true, false]) {
    const app = await page(enrollmentSession);
    await enrollmentPasswordStep(app, required);
    for (const id of ['enrollment-password', 'enrollment-password-confirm']) {
      assert.equal(app.node(id).getAttribute('minlength'), '8');
      assert.equal(app.node(id).getAttribute('maxlength'), '1024');
      app.node(id).value = 'short-7';
    }
    assert.match(app.node('enrollment-password-help').textContent, /8/);
    await app.trigger('enrollment-form', 'submit');
    assert.equal(app.calls.length, 2, 'Seven characters must not reach the server');
    assert.match(app.node('enrollment-error').textContent, /от 8 до 1024/);
    app.node('enrollment-password').value = 'eight-8!';
    app.node('enrollment-password-confirm').value = 'eight-8!';
    app.responses.push({ body: enrollmentStart });
    await app.trigger('enrollment-form', 'submit');
    assert.equal(app.calls[2].body.password, 'eight-8!');
    assert.equal(app.node('enrollment-verify-form').hidden, false);
    assert.equal(app.node('dashboard').hidden, true, 'A valid password still needs TOTP');
    assert.equal(app.state.csrfToken, '');
  }
});

test('wrong enrollment codes cannot open the menu and recovery codes must be saved before continuing', async () => {
  const app = await page(enrollmentSession);
  await showTestQr(app);
  assert.equal(app.calls[2].body.password, undefined, 'A strong existing password can be retained');
  assert.equal(app.node('enrollment-secret').textContent, enrollmentStart.secret);
  app.node('enrollment-code').value = '111111';
  app.responses.push({ status: 401, body: { error: 'Код не принят.', code: 'invalid_code' } });
  await app.trigger('enrollment-verify-form', 'submit');
  assert.equal(app.node('enrollment-verify-error').textContent, 'Код не принят.');
  assert.equal(app.node('enrollment-code').value, '');
  assert.equal(app.auth.enrollmentToken, enrollmentStart.enrollmentToken);
  assert.equal(app.node('dashboard').hidden, true);
  assert.equal(app.state.csrfToken, '');
  assert.equal(app.calls.some((call) => call.url === '/api/admin/menu'), false);
  await confirmTestEnrollment(app);
  assertEnrollmentSecretsCleared(app);
  assert.equal(app.auth.recoveryPending, true);
  assert.equal(app.node('enrollment-recovery-form').hidden, false);
  assert.deepEqual(app.node('enrollment-recovery-codes').children.map((row) => row.children[0].textContent), recoveryCodes);
  assert.equal(app.node('enrollment-continue').disabled, true);
  assert.equal(app.node('dashboard').hidden, true);
  await app.trigger('enrollment-recovery-form', 'submit');
  assert.equal(app.calls.some((call) => call.url === '/api/admin/menu'), false);
  app.node('saved-recovery-codes').checked = true;
  await app.trigger('saved-recovery-codes', 'change');
  assert.equal(app.node('enrollment-continue').disabled, false);
  app.responses.push({ body: { items: [], revision: 'after-enrollment' } });
  await app.trigger('enrollment-recovery-form', 'submit');
  assert.equal(app.node('dashboard').hidden, false);
  assert.equal(app.node('enrollment-recovery-codes').children.length, 0);
  assert.equal(app.auth.recoveryPending, false);
  assert.equal(app.idle.active, true);
  assert.equal(app.timers.size, 1, 'Only the idle lock timer remains after enrollment');
});

test('cancelling enrollment clears QR and manual secret even when server cancellation fails', async () => {
  const app = await page(enrollmentSession);
  await showTestQr(app);
  app.responses.push({ status: 503, body: { error: 'Temporary failure' } });
  await app.trigger('enrollment-cancel');
  assert.deepEqual(app.calls.at(-1).body, { challengeToken: 'enrollment-challenge', enrollmentToken: 'pending-enrollment-token' });
  assert.equal(app.calls.at(-1).url, '/api/admin/enroll/cancel');
  assertEnrollmentSecretsCleared(app);
  assert.equal(app.node('login-form').hidden, false);
  assert.equal(app.node('enrollment-verify-form').hidden, true);
  assert.equal(app.timers.size, 0);
});

test('both server expiry and local enrollment timeout erase all enrollment secrets', async () => {
  const app = await page(enrollmentSession);
  await showTestQr(app);
  app.node('enrollment-code').value = '001234';
  app.responses.push({ status: 410, body: { error: 'Начните вход заново.', code: 'challenge_expired' } });
  await app.trigger('enrollment-verify-form', 'submit');
  assertEnrollmentSecretsCleared(app);
  assert.equal(app.node('login-form').hidden, false);
  const locallyExpired = await page(enrollmentSession);
  await showTestQr(locallyExpired);
  locallyExpired.expireEnrollment();
  assertEnrollmentSecretsCleared(locallyExpired);
  assert.equal(locallyExpired.node('login-form').hidden, false);
  assert.equal(locallyExpired.timers.size, 0);
});

test('pagehide clears QR and recovery codes and prevents a late start response from restoring them', async () => {
  const app = await page(enrollmentSession);
  await showTestQr(app);
  app.windowEvent('pagehide');
  assertEnrollmentSecretsCleared(app);
  assert.equal(app.node('enrollment-recovery-codes').children.length, 0);
  const recovery = await page(enrollmentSession);
  await showTestQr(recovery);
  await confirmTestEnrollment(recovery);
  recovery.windowEvent('pagehide');
  assertEnrollmentSecretsCleared(recovery);
  assert.equal(recovery.node('enrollment-recovery-codes').children.length, 0);
  assert.equal(recovery.auth.recoveryPending, false);
  assert.equal(recovery.state.csrfToken, '');
  const pending = await page(enrollmentSession);
  await enrollmentPasswordStep(pending);
  let release;
  pending.responses.push({ body: enrollmentStart, wait: new Promise((resolve) => { release = resolve; }) });
  const request = pending.trigger('enrollment-form', 'submit');
  assert.equal(pending.node('enrollment-back').disabled, true);
  pending.windowEvent('pagehide');
  release();
  await request;
  assertEnrollmentSecretsCleared(pending);
  assert.equal(pending.node('enrollment-verify-form').hidden, true);
});

test('an external QR image URL is never assigned to the image element', async () => {
  const app = await page(enrollmentSession);
  await enrollmentPasswordStep(app);
  app.responses.push({ body: { ...enrollmentStart, qrDataUrl: 'https://outside.example/qr.png' } });
  app.responses.push({ body: { cancelled: true } });
  await app.trigger('enrollment-form', 'submit');
  assertEnrollmentSecretsCleared(app);
  assert.equal(app.node('login-form').hidden, false);
});

test('a PHP enrollment response is rendered locally as a QR that decodes to the original otpauth URI', async () => {
  const app = await page(enrollmentSession);
  await enrollmentPasswordStep(app);
  const { qrDataUrl, ...phpResponse } = enrollmentStart;
  app.responses.push({ body: phpResponse });
  await app.trigger('enrollment-form', 'submit');
  assert.equal(app.qrCalls.length, 1);
  assert.equal(app.qrCalls[0].text, enrollmentStart.otpauthUri);
  const rendered = app.node('enrollment-qr-image').getAttribute('src');
  assert.match(rendered, /^data:image\/png;base64,/);
  const png = PNG.sync.read(Buffer.from(rendered.split(',')[1], 'base64'));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.equal(decoded?.data, enrollmentStart.otpauthUri);
  assert.equal(app.calls.length, 3, 'Rendering QR must not send the secret to any service');
  app.windowEvent('pagehide');
  assertEnrollmentSecretsCleared(app);
});

test('a late local QR render cannot restore the secret after pagehide', async () => {
  let release;
  const app = await page(enrollmentSession, { qrRenderer: () => new Promise((resolve) => { release = resolve; }) });
  await enrollmentPasswordStep(app);
  const { qrDataUrl, ...phpResponse } = enrollmentStart;
  app.responses.push({ body: phpResponse });
  const rendering = app.trigger('enrollment-form', 'submit');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  app.windowEvent('pagehide');
  release(enrollmentStart.qrDataUrl);
  await rendering;
  assertEnrollmentSecretsCleared(app);
  assert.equal(app.node('enrollment-verify-form').hidden, true);
});

test('PHP QR fallback rejects non-TOTP URIs and a mismatched secret before rendering', async () => {
  for (const otpauthUri of ['https://outside.example/qr?secret=JBSWY3DPEHPK3PXP', 'otpauth://totp/Test?secret=DIFFERENTSECRET']) {
    const app = await page(enrollmentSession);
    await enrollmentPasswordStep(app);
    const { qrDataUrl, ...phpResponse } = enrollmentStart;
    app.responses.push({ body: { ...phpResponse, otpauthUri } });
    app.responses.push({ body: { cancelled: true } });
    await app.trigger('enrollment-form', 'submit');
    assert.equal(app.qrCalls.length, 0);
    assertEnrollmentSecretsCleared(app);
  }
});


test('legacy dishes follow group assignment until explicitly hidden and keep their internal order', async () => {
  const app = await page();
  const legacy = { id: 'legacy-toast', name: 'Тост', description: 'Яйцо и хлеб', price: 450, category: 'eggs', image: '', published: false, availableForOrder: false, order: 17 };
  app.validateMenu({ items: [legacy], revision: 3 });
  assert.equal(app.state.items[0].published, true); assert.equal(app.state.items[0].availableForOrder, true);
  app.openEditor(app.state.items[0]);
  assert.equal(app.node('category').required, true);
  assert.ok(app.node('category').children.every(option => option.value !== ''));
  app.responses.push({ body: { items: [{ ...legacy, published: true, availableForOrder: true }], revision: 4 } });
  await app.trigger('item-form', 'submit');
  const saved = app.calls.at(-1).body;
  assert.equal(saved.items[0].published, true); assert.equal(saved.items[0].availableForOrder, true); assert.equal(saved.items[0].order, 17);
  app.openEditor(); assert.equal(app.node('editor-dialog').open, false);
  app.openEditor({ ...legacy, id: 'new-local-id' }); assert.equal(app.node('editor-dialog').open, false);
  assert.doesNotMatch(html, /empty-add-item|id="add-item"|id="order"|id="published"|id="available-for-order"/);
  app.render(); assert.equal(app.node('add-dish').hidden, true);
  const walk = node => [node, ...node.children.flatMap(walk)];
  assert.ok(!walk(app.itemCard(app.state.items[0])).some(node => node.dataset.itemAction === 'toggle'));
});

test('malformed availability from the menu server is rejected rather than silently enabling ordering', async () => {
  const app = await page();
  for (const availableForOrder of [null, 'false', 0]) {
    assert.throws(() => app.validateMenu({ items: [{ id: 'bad', availableForOrder }], revision: 1 }), /некорректную доступность/);
  }
});

const categoryFixture = () => {
  const source = (externalId) => ({ provider: 'kds', organizationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', externalId, testOnly: true });
  const categories = [
    { id: 'breakfast', name: 'Завтраки', parentId: null, order: 0 },
    { id: 'dinner', name: 'Ужины', parentId: null, order: 1 },
  ];
  const sourceCategories = [
    { id: 'bar', name: 'Бар', parentId: null, order: 2, source: source('bar') },
    { id: 'coffee', name: 'Кофе', parentId: 'bar', order: 0, source: source('coffee') },
    { id: 'espresso', name: 'Эспрессо', parentId: 'coffee', order: 0, source: source('espresso') },
  ];
  const imported = (id, name, groupExternalId) => ({ id, name, description: '', price: 180, category: null, image: '', order: 0, published: false,
    source: { ...source(id), groupExternalId } });
  return { revision: 6, categories, sourceCategories, categoryMappings: [], items: [
    { id: 'porridge', name: 'Каша', description: '', price: 200, category: 'breakfast', image: '', order: 0, published: true },
    imported('double', 'Двойной эспрессо', 'espresso'), imported('tea', 'Чай', 'bar'), imported('latte', 'Латте', 'coffee'),
  ] };
};

const clickItem = (app, id, action) => app.trigger('items', 'click', { target: { closest: () => ({ dataset: { itemId: id, itemAction: action } }) } });

test('website mode starts with breakfast and only manual categories, with no all-menu filter', async () => {
  const app = await page();
  app.validateMenu(categoryFixture()); app.render();
  assert.equal(app.state.mode, 'site');
  assert.equal(app.state.siteCategory, 'breakfast');
  assert.deepEqual(Array.from(app.node('category-tabs').children, node => node.dataset.categoryId), ['breakfast', 'dinner']);
  assert.equal(app.node('items').children.length, 1);
  assert.doesNotMatch(html, /id="category-filter"|Всё меню|id="total-count"/);
  app.state.siteCategory = 'dinner'; app.render();
  assert.equal(app.node('empty-state').hidden, false);
  await app.trigger('empty-browse-cash');
  assert.equal(app.state.mode, 'cash');
});

test('cash mode navigates original groups and shows direct dishes with direct child groups, while search covers descendants', async () => {
  const app = await page();
  app.validateMenu(categoryFixture());
  await app.trigger('mode-cash');
  assert.equal(app.node('category-tabs').hidden, true);
  assert.equal(app.node('manage-categories').hidden, true);
  assert.equal(app.node('cash-groups').children.length, 1);
  assert.equal(app.node('items').children.length, 0);
  app.openCashGroup('bar');
  assert.equal(app.node('cash-groups').children[0].dataset.cashGroupId, 'coffee');
  assert.equal(app.node('items').children.length, 1, 'The root must not duplicate dishes from nested groups');
  app.openCashGroup('coffee');
  assert.equal(app.node('cash-groups').children[0].dataset.cashGroupId, 'espresso');
  assert.equal(app.node('items').children.length, 1);
  assert.equal(app.node('cash-breadcrumbs').children.at(-1).textContent, 'Кофе');
  app.openCashGroup('espresso');
  assert.equal(app.node('cash-groups').children.length, 0);
  assert.equal(app.node('items').children.length, 1);
  await app.trigger('cash-back');
  assert.equal(app.state.cashGroupId, 'coffee');
  app.openCashGroup('bar');
  app.node('search').value = 'Двойной'; await app.trigger('search', 'input');
  assert.equal(app.node('items').children.length, 1, 'Search includes deeper descendants within the current branch');
  assert.match(app.node('category-context').textContent, /вложенных/);
  await app.trigger('mode-site'); await app.trigger('mode-cash');
  assert.equal(app.state.cashGroupId, 'bar');
  assert.equal(app.node('search').value, 'Двойной');
});

test('assigning an individual cash dish publishes it in a manual category and retains its original group and current navigation', async () => {
  const app = await page(); const data = categoryFixture();
  app.validateMenu(data); app.setMenuMode('cash'); app.openCashGroup('espresso');
  app.openEditor(app.state.items[1]);
  assert.equal(app.node('category').disabled, false);
  assert.equal(app.node('category').required, false);
  assert.equal(app.node('category').value, '');
  assert.deepEqual(Array.from(app.node('category').children, option => option.value), ['', 'breakfast', 'dinner']);
  const before = app.calls.length;
  assert.equal(app.calls.length, before, 'Opening the editor does not publish a cash dish');
  app.node('category').value = 'dinner'; app.node('item-name').value = 'Наш двойной эспрессо';
  const changed = { ...data.items[1], category: 'dinner', published: true, name: 'Наш двойной эспрессо' };
  app.responses.push({ body: { ...data, revision: 7, items: data.items.map(item => item.id === changed.id ? changed : item) } });
  await app.trigger('item-form', 'submit');
  const saved = app.calls.at(-1).body;
  assert.deepEqual(saved.items[1].source, data.items[1].source);
  assert.deepEqual(saved.sourceCategories, data.sourceCategories);
  assert.deepEqual(saved.categories, data.categories);
  assert.deepEqual(saved.categoryMappings, []);
  assert.equal(saved.items[1].category, 'dinner'); assert.equal(saved.items[1].published, true);
  assert.equal(app.state.mode, 'cash'); assert.equal(app.state.cashGroupId, 'espresso');
  assert.equal(app.node('items').children.length, 1);
  app.setMenuMode('site'); app.state.siteCategory = 'dinner'; app.render();
  assert.equal(app.node('items').children.length, 1);
});

test('removing a sourced dish from the website detaches placement without deleting its cash record', async () => {
  const app = await page(); const data = categoryFixture();
  data.items[1] = { ...data.items[1], category: 'dinner', published: true };
  app.validateMenu(data); app.state.siteCategory = 'dinner'; app.render();
  await clickItem(app, 'double', 'detach');
  assert.match(app.node('delete-title').textContent, /с сайта/);
  const detached = { ...data.items[1], category: null, published: false, availableForOrder: false };
  app.responses.push({ body: { ...data, revision: 7, items: data.items.map(item => item.id === detached.id ? detached : item) } });
  await app.trigger('confirm-delete');
  const saved = app.calls.at(-1).body;
  assert.equal(saved.items.length, data.items.length);
  assert.equal(saved.items[1].category, null); assert.equal(saved.items[1].published, false);
  assert.deepEqual(saved.items[1].source, data.items[1].source);
  assert.equal(app.node('items').children.length, 0);
  app.setMenuMode('cash'); app.openCashGroup('espresso');
  assert.equal(app.node('items').children.length, 1);
  const card = app.itemCard(app.state.items[1]);
  const walk = node => [node, ...node.children.flatMap(walk)];
  assert.ok(!walk(card).some(node => ['delete', 'detach'].includes(node.dataset.itemAction)));
});

test('cash-only dishes can be edited without placement, and assigning a group is the sole publication switch', async () => {
  const app = await page(); const data = categoryFixture();
  app.validateMenu(data); app.openEditor(app.state.items[1]);
  assert.equal(app.node('category').required, false);
  app.node('description').value = 'Описание для будущей публикации';
  app.responses.push({ body: { ...data, revision: 7 } });
  await app.trigger('item-form', 'submit');
  assert.equal(app.calls.at(-1).body.items[1].category, null);
  assert.equal(app.calls.at(-1).body.items[1].published, false);
  data.items[1] = { ...data.items[1], category: 'dinner', published: false };
  app.validateMenu({ ...data, revision: 8 }); app.state.siteCategory = 'dinner'; app.render();
  assert.equal(app.node('items').children.length, 1);
  app.openEditor(app.state.items[1]); assert.equal(app.state.items[1].published, true);
});

test('test-only imported dishes cannot be enabled for ordering in the editor', async () => {
  const app = await page(); const data = categoryFixture();
  data.items[1] = { ...data.items[1], category: 'dinner', availableForOrder: true };
  app.validateMenu(data); app.openEditor(app.state.items[1]);
  assert.match(app.node('editor-keeper-status').textContent, /только для просмотра/);
  app.responses.push({ body: { ...data, revision: 7 } });
  await app.trigger('item-form', 'submit');
  assert.equal(app.calls.at(-1).body.items[1].availableForOrder, false);
  app.openEditor(app.state.items[0]);
  assert.equal(app.node('editor-keeper-status').hidden, true);
});

test('category manager only creates manual website categories and leaves cash hierarchy untouched', async () => {
  const app = await page(); const data = categoryFixture();
  app.validateMenu(data); app.openCategoryManager();
  app.node('new-category-name').value = 'Напитки'; await app.trigger('add-category');
  const target = app.categoryDraft.categories.find(entry => entry.name === 'Напитки');
  assert.ok(target); assert.equal(target.parentId, null); assert.equal(target.source, undefined);
  app.responses.push({ body: { ...data, revision: 7, categories: app.categoryDraft.categories } });
  await app.trigger('categories-form', 'submit');
  const saved = app.calls.at(-1).body;
  assert.deepEqual(saved.sourceCategories, data.sourceCategories);
  assert.deepEqual(saved.categoryMappings, []);
  assert.equal(saved.items[1].category, null);
  assert.equal(app.node('categories-dialog').open, false);
  assert.doesNotMatch(html, /source-category-list|Куда помещать блюда из КДС/);
});

test('opening the group editor automatically fetches the latest saved groups', async () => {
  const app = await page(); const data = categoryFixture();
  app.validateMenu(data);
  const current = { ...data, revision: 7, categories: [...data.categories, { id: 'drinks', name: 'Напитки', parentId: null, order: 2 }] };
  app.responses.push({ body: current });
  await app.trigger('manage-categories');
  assert.equal(app.calls.at(-1).method, 'GET');
  assert.equal(app.calls.at(-1).url, '/api/admin/menu');
  assert.equal(app.node('categories-dialog').open, true);
  assert.equal(app.categoryDraft.revision, 7);
  assert.deepEqual(Array.from(app.categoryDraft.categories, group => group.id), ['breakfast', 'dinner', 'drinks']);
  assert.equal(app.categoryDraft.dirty, false);
});

test('a failed opening refresh never opens the group editor with a stale snapshot', async () => {
  const app = await page(); const data = categoryFixture();
  app.validateMenu(data);
  app.responses.push({ status: 503, body: { error: 'Сервер временно недоступен.' } });
  await app.trigger('manage-categories');
  assert.equal(app.node('categories-dialog').open, false);
  assert.equal(app.node('manage-categories').disabled, false);
  assert.match(app.node('dashboard-message').textContent, /Сервер временно недоступен/);
  app.responses.push({ body: { ...data, revision: 8 } });
  await app.trigger('manage-categories');
  assert.equal(app.node('categories-dialog').open, true);
  assert.equal(app.categoryDraft.revision, 8);
});

for (const uncertain of [false, true]) test(`group editor recovers on reopening after ${uncertain ? 'a lost save response' : 'another administrator saves'}`, async () => {
  const app = await page(); const data = categoryFixture();
  app.validateMenu(data); app.openCategoryManager();
  app.node('new-category-name').value = 'Напитки';
  app.responses.push(uncertain ? { error: new Error('Connection lost') } : { status: 409, body: { error: 'Menu revision changed.' } });
  await app.trigger('categories-form', 'submit');
  assert.equal(app.state.conflict, true);
  assert.equal(app.node('save-categories').disabled, true);
  assert.equal(app.node('manage-categories').disabled, false, 'Reopening must remain available after a conflict');
  assert.equal(app.node('categories-dialog').open, true);
  assert.equal(app.categoryDraft.dirty, true);
  assert.ok(app.categoryDraft.categories.some(group => group.name === 'Напитки'), 'Keep the unsaved draft until the user closes it');
  assert.match(app.node('categories-error').textContent, /Закройте это окно и снова нажмите «Редактировать группы»/);
  if (uncertain) assert.match(app.node('categories-error').textContent, /Ответ о сохранении не получен/);
  await app.trigger('cancel-categories');
  const current = { ...data, revision: 8, categories: [...data.categories, { id: 'desserts', name: 'Десерты', parentId: null, order: 2 }] };
  app.responses.push({ body: current });
  await app.trigger('manage-categories');
  assert.equal(app.state.conflict, false);
  assert.equal(app.categoryDraft.revision, 8);
  assert.equal(app.node('save-categories').disabled, false);
  assert.deepEqual(Array.from(app.categoryDraft.categories, group => group.id), ['breakfast', 'dinner', 'desserts']);
  assert.equal(app.calls.filter(call => call.method === 'PUT').length, 1, 'Opening the editor must not repeat an uncertain save');
});

test('a category draft cannot overwrite a newer menu revision', async () => {
  const app = await page(); const data = categoryFixture();
  app.validateMenu(data); app.openCategoryManager();
  app.categoryDraft.categories[0].name = 'Новое название';
  app.validateMenu({ ...data, revision: 7 });
  const before = app.calls.length; await app.trigger('categories-form', 'submit');
  assert.equal(app.calls.length, before); assert.match(app.node('categories-error').textContent, /Меню обновилось/);
  assert.match(app.node('categories-error').textContent, /Закройте это окно и снова нажмите «Редактировать группы»/);
});

test('saving a pending category creates it in one request and a retry keeps the same single draft entry', async () => {
  const app = await page(); const data = categoryFixture();
  app.validateMenu(data); app.openCategoryManager();
  app.node('new-category-name').value = 'Напитки';
  app.responses.push({ status: 422, body: { error: 'Проверьте категорию.' } });
  await app.trigger('categories-form', 'submit');
  const first = app.calls.at(-1).body;
  assert.equal(first.categories.filter(entry => entry.name === 'Напитки').length, 1);
  assert.equal(app.node('new-category-name').value, '');
  assert.equal(app.node('categories-dialog').open, true);
  app.responses.push({ body: { ...data, revision: 7, categories: first.categories } });
  await app.trigger('categories-form', 'submit');
  assert.deepEqual(app.calls.at(-1).body.categories, first.categories);
  assert.equal(app.node('categories-dialog').open, false);
});

test('empty or duplicate new categories do not send menu updates', async () => {
  const app = await page(); app.validateMenu(categoryFixture()); app.openCategoryManager();
  const before = app.calls.length;
  await app.trigger('categories-form', 'submit');
  assert.equal(app.calls.length, before);
  app.openCategoryManager(); app.node('new-category-name').value = 'Завтраки';
  await app.trigger('categories-form', 'submit');
  assert.equal(app.calls.length, before);
  assert.match(app.node('categories-error').textContent, /уже есть/);
});

test('remembering the browser is automatic with no checkbox or opt-in request flag', async () => {
  const app = await page();
  assert.doesNotMatch(html, /id="remember-device"/);
  assert.match(html, /Введите почту и пароль администратора/);
  assert.doesNotMatch(html, /браузер на 30 дней/);
  await passwordStep(app);
  assert.deepEqual(app.calls[1].body, { username: 'cafe-admin', password: 'example-password-only-for-tests' });
  app.node('verification-code').value = '001234'; successfulVerify(app);
  await app.trigger('verify-form', 'submit');
  assert.deepEqual(app.calls[2].body, { challengeToken: 'memory-only-challenge', code: '001234' });
});

test('password eyes reveal and hide each field independently without submitting or changing its value', async () => {
  const app = await page();
  const ids = ['password', 'enrollment-password', 'enrollment-password-confirm'];
  for (const id of ids) {
    const input = app.node(id); const button = app.node(`${id}-toggle`);
    input.value = 'fixture-password-to-inspect';
    assert.equal(input.type, 'password');
    assert.equal(button.getAttribute('type'), 'button');
    assert.equal(button.getAttribute('aria-controls'), id);
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    await app.trigger(`${id}-toggle`);
    assert.equal(input.type, 'text');
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.match(button.getAttribute('aria-label'), /^Скрыть /);
    for (const other of ids.filter((value) => value !== id)) assert.equal(app.node(other).type, 'password');
    await app.trigger(`${id}-toggle`);
    assert.equal(input.type, 'password');
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.match(button.getAttribute('aria-label'), /^Показать /);
    assert.equal(input.value, 'fixture-password-to-inspect');
  }
  assert.equal(app.calls.length, 1, 'Visibility toggles must not make network requests');
});

test('password visibility resets on submission and cancellation, including failed login', async () => {
  const app = await page();
  app.node('username').value = 'cafe-admin'; app.node('password').value = 'fixture-invalid-password';
  await app.trigger('password-toggle');
  app.responses.push({ status: 401, body: { error: 'Неверный пароль.' } });
  await app.trigger('login-form', 'submit');
  assert.equal(app.node('password').type, 'password');
  assert.equal(app.node('password').value, '');
  assert.equal(app.node('password-toggle').getAttribute('aria-pressed'), 'false');
  await passwordStep(app);
  assert.equal(app.node('password').type, 'password');
  await app.trigger('auth-back');
  assert.equal(app.node('password-toggle').getAttribute('aria-pressed'), 'false');
});

test('trusted browser shows saved identity and code only, then requests a cookie-bound challenge', async () => {
  const app = await page({ authenticated: false, configured: true, ready: true, trustedUsername: 'ira@example.test' });
  assert.equal(app.node('login-form').hidden, true);
  assert.equal(app.node('verify-form').hidden, false);
  assert.equal(app.node('code-mode').hidden, true);
  assert.match(app.node('auth-description').textContent, /ira@example.test/);
  assert.equal(app.node('username').value, 'ira@example.test');
  assert.equal(app.state.csrfToken, '');
  app.node('verification-code').value = '001234';
  app.responses.push({ status: 202, body: { mfaRequired: true, challengeToken: 'trusted-challenge' } });
  successfulVerify(app);
  await app.trigger('verify-form', 'submit');
  assert.equal(app.calls[1].url, '/api/admin/resume');
  assert.deepEqual(app.calls[1].body, {});
  assert.deepEqual(app.calls[2].body, { challengeToken: 'trusted-challenge', code: '001234' });
  assert.equal(app.node('dashboard').hidden, false);
  assert.equal(app.auth.trustedUsername, '');
});

test('expired device requires password; forgetting the device is an explicit separate action', async () => {
  const app = await page({ authenticated: false, configured: true, ready: true, trustedUsername: 'ira@example.test' });
  app.node('verification-code').value = '001234';
  app.responses.push({ status: 401, body: { code: 'device_expired', error: 'Войдите с паролем.' } });
  await app.trigger('verify-form', 'submit');
  assert.equal(app.node('login-form').hidden, false);
  assert.equal(app.node('verify-form').hidden, true);
  const other = await page({ authenticated: false, configured: true, ready: true, trustedUsername: 'ira@example.test' });
  other.responses.push({ body: { forgotten: true } });
  await other.trigger('auth-forget-device');
  assert.equal(other.calls.at(-1).url, '/api/admin/forget-device');
  assert.equal(other.node('login-form').hidden, false);
});

test('idle expiry presents OTP unlock without losing the open dish draft', async () => {
  const app = await page();
  app.state.csrfToken = 'old-csrf'; app.node('editor-dialog').open = true; app.draft.dirty = true;
  app.responses.push({ body: { authenticated: false, trustedUsername: 'ira@example.test' } });
  app.sessionExpired({ status: 401 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.draft.resume, true); assert.equal(app.draft.dirty, true);
  assert.equal(app.node('verify-form').hidden, false);
  assert.equal(app.auth.trustedUsername, 'ira@example.test');
});

test('additional account enrollment uses the authenticated email instead of the owner preset', async () => {
  const app = await page();
  app.node('username').value = 'ira@example.test'; app.node('password').value = 'temporary-fixture-password';
  app.responses.push({ status: 202, body: { enrollmentRequired: true, challengeToken: 'ira-setup', username: 'ira@example.test', requiresNewPassword: true } });
  await app.trigger('login-form', 'submit');
  assert.equal(app.node('enrollment-username').value, 'ira@example.test');
  assert.equal(app.node('enrollment-password').required, true);
});

async function signedIn(options) {
  const app = await page(undefined, options);
  await passwordStep(app, 'ira@example.test');
  app.node('verification-code').value = '001234';
  successfulVerify(app);
  await app.trigger('verify-form', 'submit');
  return app;
}

test('idle locking closes the category manager while preserving its unsaved draft', async () => {
  const app = await signedIn();
  app.validateMenu(categoryFixture());
  app.openCategoryManager();
  app.node('new-category-name').value = 'Напитки';
  await app.trigger('add-category');
  app.responses.push({ body: { authenticated: false, trustedUsername: 'ira@example.test' } });
  await app.advance(900000);
  assert.equal(app.node('categories-dialog').open, false);
  assert.equal(app.node('dashboard').hidden, true);
  assert.equal(app.categoryDraft.resume, true);
  assert.equal(app.categoryDraft.dirty, true);
  assert.ok(app.categoryDraft.categories.some((entry) => entry.name === 'Напитки'));
  assert.match(app.node('session-lock-note').textContent, /Черновик сохранён/);
});

test('15 minutes without real activity automatically hides dashboard and dialogs, retaining draft and captured logout CSRF', async () => {
  const app = await signedIn();
  app.validateMenu(categoryFixture()); app.openEditor(app.state.items[0]);
  app.node('item-name').value = 'Новый тост';
  app.draft.dirty = true;
  app.node('delete-dialog').open = true;
  await app.advance(899999);
  assert.equal(app.node('dashboard').hidden, false);
  assert.equal(app.calls.some((call) => call.url.endsWith('/activity')), false, 'No idle keepalive requests');
  app.responses.push({ body: { authenticated: false, trustedUsername: 'ira@example.test' } });
  await app.advance(1);
  assert.equal(app.node('dashboard').hidden, true);
  assert.equal(app.node('editor-dialog').open, false);
  assert.equal(app.node('delete-dialog').open, false);
  assert.equal(app.node('verify-form').hidden, false);
  assert.equal(app.draft.resume, true);
  assert.equal(app.draft.dirty, true);
  assert.equal(app.node('item-name').value, 'Новый тост');
  assert.equal(app.state.csrfToken, '');
  assert.equal(app.calls.at(-1).url, '/api/admin/logout');
  assert.equal(app.calls.at(-1).headers['X-CSRF-Token'], 'csrf-after-mfa');
  assert.deepEqual(app.calls.at(-1).body, { forgetDevice: false });
  assert.equal(app.idle.active, false);
});

test('only trusted user events refresh idle, activity is throttled and stops completely when user stops', async () => {
  const app = await signedIn();
  await app.advance(1000);
  await app.activity('pointerdown', false);
  assert.equal(app.calls.filter((call) => call.url.endsWith('/activity')).length, 0);
  app.responses.push({ body: { authenticated: true } });
  await app.activity('keydown');
  assert.equal(app.calls.at(-1).url, '/api/admin/activity');
  assert.equal(app.calls.at(-1).headers['X-CSRF-Token'], 'csrf-after-mfa');
  await app.advance(1000);
  await app.activity('pointermove');
  await app.activity('input');
  assert.equal(app.calls.filter((call) => call.url.endsWith('/activity')).length, 1);
  app.responses.push({ body: { authenticated: true } });
  await app.advance(29000);
  assert.equal(app.calls.filter((call) => call.url.endsWith('/activity')).length, 2);
  await app.advance(60000);
  assert.equal(app.calls.filter((call) => call.url.endsWith('/activity')).length, 2, 'A trailing acknowledgement must not start a keepalive loop');
  assert.equal(app.idle.deadline, 2_000_000_000_000 + 2000 + 900000, 'Last real event, not response time, controls local inactivity');
});

test('acknowledged activity extends idle but network failures cannot keep protected UI unlocked', async () => {
  const app = await signedIn();
  await app.advance(840000);
  app.responses.push({ body: { authenticated: true } });
  await app.activity();
  await app.advance(60000);
  assert.equal(app.node('dashboard').hidden, false, 'Activity at minute 14 extends the session');
  const offline = await signedIn();
  await offline.advance(840000);
  offline.responses.push({ error: new Error('offline') });
  await offline.activity();
  offline.responses.push({ error: new Error('still offline') });
  await offline.advance(60000);
  assert.equal(offline.node('dashboard').hidden, true);
  assert.equal(offline.state.csrfToken, '');
  assert.equal(offline.node('verify-form').hidden, false);
  assert.match(offline.node('session-lock-note').textContent, /соединение/);
});

test('return from sleep hides protected UI and checks read-only status without treating wakeup as activity', async () => {
  const app = await signedIn();
  const count = app.calls.length;
  await app.advance(910000, { suspended: true });
  app.responses.push({ body: { authenticated: false, trustedUsername: 'ira@example.test' } });
  await app.windowEvent('pageshow');
  assert.equal(app.node('dashboard').hidden, true);
  assert.equal(app.calls.length, count + 1);
  assert.equal(app.calls.at(-1).url, '/api/admin/session');
  await app.activity();
  assert.equal(app.calls.length, count + 1);
});

test('ordinary logout keeps code-only entry while explicit forget removes the saved identity', async () => {
  const app = await signedIn();
  app.responses.push({ body: { authenticated: false, trustedUsername: 'ira@example.test' } });
  await app.trigger('logout');
  assert.deepEqual(app.calls.at(-1).body, { forgetDevice: false });
  assert.equal(app.node('verify-form').hidden, false);
  assert.equal(app.node('login-form').hidden, true);
  const shared = await signedIn();
  shared.responses.push({ body: { authenticated: false } });
  await shared.trigger('logout-forget');
  assert.deepEqual(shared.calls.at(-1).body, { forgetDevice: true });
  assert.equal(shared.node('login-form').hidden, false);
  assert.equal(shared.node('verify-form').hidden, true);
  assert.equal(shared.node('username').value, '');
});

test('a late menu response cannot repopulate or reopen protected UI after automatic lock', async () => {
  const app = await signedIn();
  let release;
  app.responses.push({ body: { items: [{ id: 'late', name: 'Поздний ответ' }], revision: 99 }, wait: new Promise((resolve) => { release = resolve; }) });
  const pending = app.loadMenu();
  app.responses.push({ body: { authenticated: false, trustedUsername: 'ira@example.test' } });
  await app.advance(900000);
  assert.equal(app.node('dashboard').hidden, true);
  assert.equal(app.calls.findLast((call) => call.url === '/api/admin/menu').signal.aborted, true);
  release();
  await pending;
  assert.equal(app.state.loaded, false);
  assert.equal(app.state.items.some((item) => item.id === 'late'), false);
  assert.equal(app.node('dashboard').hidden, true);
  assert.equal(app.node('editor-dialog').open, false);
});

test('malformed authenticated timing never opens a dashboard and absolute expiry is respected', async () => {
  const app = await page();
  await passwordStep(app);
  app.node('verification-code').value = '001234';
  app.responses.push({ body: { authenticated: true, csrfToken: 'bad', session: null } });
  await app.trigger('verify-form', 'submit');
  assert.equal(app.node('dashboard').hidden, true);
  assert.equal(app.state.csrfToken, '');
  const absolute = await page();
  await passwordStep(absolute);
  absolute.node('verification-code').value = '001234';
  absolute.responses.push({ body: { authenticated: true, csrfToken: 'short-absolute', session: {
    serverNow: absolute.now(), idleTimeoutMs: 900000, idleExpiresAt: absolute.now() + 900000, expiresAt: absolute.now() + 40000,
  } } });
  absolute.responses.push({ body: { items: [], revision: 1 } });
  await absolute.trigger('verify-form', 'submit');
  absolute.responses.push({ body: { authenticated: false, trustedUsername: 'cafe-admin' } });
  await absolute.advance(40000);
  assert.equal(absolute.node('dashboard').hidden, true);
  assert.match(absolute.node('session-lock-note').textContent, /Сессия завершилась/);
});

test('other tab acknowledged activity synchronizes deadline without a network keepalive; remote logout locks all views', async () => {
  const app = await signedIn();
  await app.advance(100000);
  const count = app.calls.length;
  await app.remote({ type: 'activity', username: 'ira@example.test', deadline: app.now() + 900000 });
  assert.equal(app.idle.deadline, app.now() + 900000);
  assert.equal(app.calls.length, count);
  app.validateMenu(categoryFixture()); app.openEditor(app.state.items[0]);
  app.draft.dirty = true;
  await app.remote({ type: 'lock', forgetDevice: true });
  assert.equal(app.node('dashboard').hidden, true);
  assert.equal(app.node('editor-dialog').open, false);
  assert.equal(app.node('login-form').hidden, false);
  assert.equal(app.node('username').value, '');
  assert.equal(app.calls.length, count, 'Other tabs must not redundantly invalidate a newly established server session');
});

test('switching to password entry does not silently revoke a trusted browser', async () => {
  const app = await page({ authenticated: false, configured: true, ready: true, trustedUsername: 'ira@example.test' });
  await app.trigger('auth-back');
  assert.equal(app.node('login-form').hidden, false);
  assert.equal(app.calls.length, 1);
});

test('a sleeping tab does not log out a shared session extended by real activity in another tab', async () => {
  const app = await signedIn();
  app.validateMenu(categoryFixture()); app.openEditor(app.state.items[0]);
  app.node('item-name').value = 'Черновик до сна';
  app.draft.dirty = true;
  await app.advance(910000, { suspended: true });
  let release;
  app.responses.push({ body: { authenticated: true, csrfToken: 'csrf-after-mfa', username: 'ira@example.test' },
    wait: new Promise((resolve) => { release = resolve; }) });
  const checking = app.windowEvent('pageshow');
  assert.equal(app.node('dashboard').hidden, true, 'The stale UI is hidden before the status check finishes');
  assert.equal(app.node('editor-dialog').open, false);
  release();
  await checking;
  assert.equal(app.node('dashboard').hidden, false);
  assert.equal(app.node('editor-dialog').open, true);
  assert.equal(app.node('item-name').value, 'Черновик до сна');
  assert.equal(app.calls.at(-1).url, '/api/admin/session');
  assert.equal(app.calls.some((call) => call.url.endsWith('/logout') || call.url.endsWith('/activity')), false);
});

test('logout blocks reauthentication until its cookie-clearing response finishes, including other open tabs', async () => {
  const app = await signedIn();
  let release;
  app.responses.push({ body: { authenticated: false, trustedUsername: 'ira@example.test' },
    wait: new Promise((resolve) => { release = resolve; }) });
  const exiting = app.trigger('logout');
  assert.equal(app.node('dashboard').hidden, true);
  assert.equal(app.node('verify-submit').disabled, true);
  app.node('verification-code').value = '001234';
  const count = app.calls.length;
  await app.trigger('verify-form', 'submit');
  assert.equal(app.calls.length, count, 'New authentication cannot race the old Set-Cookie logout response');
  const other = await signedIn();
  await other.remote(app.broadcasts.at(-1));
  assert.equal(other.node('verify-submit').disabled, true);
  release();
  await exiting;
  assert.equal(app.node('verify-submit').disabled, false);
  assert.equal(app.broadcasts.at(-1).type, 'logout-complete');
  await other.remote(app.broadcasts.at(-1));
  assert.equal(other.node('verify-submit').disabled, false);
});

test('a stale request rejected after fresh OTP must not lock or revoke the new session', async () => {
  const app = await signedIn();
  let release;
  app.responses.push({ body: { items: [], revision: 'old-response' }, wait: new Promise((resolve) => { release = resolve; }) });
  const oldRequest = app.loadMenu();
  app.responses.push({ body: { authenticated: false, trustedUsername: 'ira@example.test' } });
  await app.advance(900000);
  app.node('verification-code').value = '002345';
  app.responses.push({ body: { mfaRequired: true, challengeToken: 'fresh-challenge' } });
  app.responses.push({ body: { authenticated: true, csrfToken: 'new-session-csrf' } });
  app.responses.push({ body: { items: [], revision: 'new-session-menu' } });
  await app.trigger('verify-form', 'submit');
  assert.equal(app.node('dashboard').hidden, false);
  release();
  await oldRequest;
  assert.equal(app.state.csrfToken, 'new-session-csrf');
  assert.equal(app.state.revision, 'new-session-menu');
  assert.equal(app.node('dashboard').hidden, false);
  assert.equal(app.calls.filter((call) => call.url.endsWith('/logout')).length, 1);
});

test('offline logout persists only a nonsensitive lock marker and reload cannot reopen the old server session', async () => {
  const storage = new Map();
  const app = await signedIn({ storage });
  app.responses.push({ error: new Error('offline') });
  await app.trigger('logout');
  const marker = JSON.parse(storage.get('vosem-utra-admin-locked'));
  assert.deepEqual(Object.keys(marker).sort(), ['at', 'forgetDevice', 'pendingUntil']);
  assert.equal(marker.pendingUntil, 0);
  assert.doesNotMatch(JSON.stringify(marker), /ira|csrf|password|challenge/i);
  const reload = await page({ authenticated: true, csrfToken: 'old-server-csrf', username: 'ira@example.test' }, {
    storage, responsesAfterSession: [{ body: { authenticated: false, trustedUsername: 'ira@example.test' } }],
  });
  assert.equal(reload.node('dashboard').hidden, true);
  assert.equal(reload.node('verify-form').hidden, false);
  assert.deepEqual(reload.calls.map((call) => call.url), ['/api/admin/session', '/api/admin/logout']);
  assert.equal(reload.calls[1].headers['X-CSRF-Token'], 'old-server-csrf');
  reload.node('verification-code').value = '001234';
  reload.responses.push({ body: { mfaRequired: true, challengeToken: 'reload-challenge' } });
  successfulVerify(reload);
  await reload.trigger('verify-form', 'submit');
  assert.equal(storage.has('vosem-utra-admin-locked'), false, 'Only successful fresh MFA clears the browser lock');
  assert.equal(reload.node('dashboard').hidden, false);
});

test('network loss while checking a stale tab never restores its dashboard', async () => {
  const app = await signedIn();
  await app.advance(910000, { suspended: true });
  app.responses.push({ error: new Error('offline') });
  await app.windowEvent('pageshow');
  assert.equal(app.node('dashboard').hidden, true);
  assert.equal(app.state.csrfToken, '');
  assert.equal(app.node('verify-form').hidden, false);
  assert.equal(app.storage.has('vosem-utra-admin-locked'), true);
  assert.equal(app.calls.at(-1).url, '/api/admin/session');
});

test('stale-tab CSRF rejection does not revoke or mark a newer shared session as logged out', async () => {
  const app = await signedIn();
  await app.advance(1000);
  app.responses.push({ status: 403, body: { code: 'csrf', error: 'CSRF mismatch' } });
  app.responses.push({ body: { authenticated: true, csrfToken: 'fresh-other-tab-csrf', username: 'ira@example.test' } });
  await app.activity();
  assert.equal(app.node('dashboard').hidden, true);
  assert.equal(app.state.csrfToken, '');
  assert.equal(app.node('verify-form').hidden, false);
  assert.equal(app.calls.at(-1).url, '/api/admin/session');
  assert.equal(app.calls.some((call) => call.url.endsWith('/logout')), false);
  assert.equal(app.storage.has('vosem-utra-admin-locked'), false);
});


async function chooseGroup(app, id) {
  await app.trigger('category-sort-list', 'click', { target: { closest: selector => selector.includes('data-group-select') ? { dataset: { groupSelect: id } } : null } });
}

test('group deletion moves dishes in a draft and preserves other groups, then saves all changes atomically', async () => {
  const app = await page(); const data = categoryFixture();
  data.categories.push({ id: 'child', name: 'Детское', parentId: 'breakfast', order: 2 });
  data.items.push({ ...data.items[0], id: 'child-porridge', category: 'child' });
  app.validateMenu(data); app.openCategoryManager();
  await app.trigger('delete-category');
  assert.match(app.node('delete-category-description').textContent, /Блюд в группе: 1.*Остальные группы/);
  assert.equal(app.node('confirm-delete-category').disabled, true);
  assert.ok(!app.node('delete-category-destination').children.some(option => option.value === 'breakfast' || option.value === '__cash__'));
  const before = app.calls.length;
  app.node('delete-category-destination').value = 'dinner'; await app.trigger('delete-category-destination', 'change');
  assert.equal(app.node('confirm-delete-category').disabled, false);
  await app.trigger('confirm-delete-category');
  assert.equal(app.calls.length, before, 'Deletion stays local until Save groups');
  assert.equal(app.state.items[0].category, 'breakfast');
  assert.equal(app.categoryDraft.items[0].category, 'dinner');
  assert.equal(app.categoryDraft.items[0].published, true);
  assert.equal(app.categoryDraft.categories.find(entry => entry.id === 'child').parentId, null);
  assert.equal(app.categoryDraft.items.at(-1).category, 'child');
  app.responses.push({ body: { ...data, categories: app.categoryDraft.categories, items: app.categoryDraft.items, revision: 7 } });
  await app.trigger('categories-form', 'submit');
  assert.equal(app.calls.length, before + 1);
  const saved = app.calls.at(-1).body;
  assert.equal(saved.revision, 6); assert.equal(saved.items[0].category, 'dinner');
  assert.ok(!saved.categories.some(entry => entry.id === 'breakfast'));
  assert.deepEqual(saved.sourceCategories, data.sourceCategories);
});

test('deleting a sourced-only group detaches dishes without destroying their source records or publication metadata on other dishes', async () => {
  const app = await page(); const data = categoryFixture();
  data.items[1] = { ...data.items[1], category: 'dinner', published: true, availableForOrder: false };
  app.validateMenu(data); app.openCategoryManager(); await chooseGroup(app, 'dinner');
  await app.trigger('delete-category');
  assert.ok(app.node('delete-category-destination').children.some(option => option.value === '__cash__'));
  app.node('delete-category-destination').value = '__cash__'; await app.trigger('delete-category-destination', 'change');
  await app.trigger('confirm-delete-category');
  const detached = app.categoryDraft.items[1];
  assert.equal(detached.category, null); assert.equal(detached.published, false); assert.equal(detached.availableForOrder, false);
  assert.equal(app.categoryDraft.items.length, data.items.length);
  assert.deepEqual(JSON.parse(JSON.stringify(detached.source)), data.items[1].source);
  assert.equal(app.categoryDraft.items[0].category, 'breakfast');
  assert.equal(app.state.items[1].category, 'dinner');
  await app.trigger('cancel-categories'); app.openCategoryManager();
  assert.equal(app.categoryDraft.items[1].category, 'dinner', 'Cancel discards draft deletions');
});

test('a last occupied legacy group cannot be deleted or detached even with a forged destination', async () => {
  const app = await page(); const data = categoryFixture(); data.categories = [data.categories[0]];
  app.validateMenu(data); app.openCategoryManager(); await app.trigger('delete-category');
  assert.equal(app.node('confirm-delete-category').disabled, true);
  assert.match(app.node('delete-category-help').textContent, /Сначала добавьте другую группу/);
  app.node('delete-category-destination').value = '__cash__'; await app.trigger('confirm-delete-category');
  assert.equal(app.categoryDraft.categories.length, 1); assert.equal(app.categoryDraft.items[0].category, 'breakfast');
  assert.match(app.node('categories-error').textContent, /Выберите другую группу/);
});

test('empty groups including the last one are removable without deleting cash data', async () => {
  const app = await page(); const data = categoryFixture(); data.items = data.items.filter(item => item.source); data.categories = [data.categories[1]];
  app.validateMenu(data); app.openCategoryManager(); await app.trigger('delete-category');
  assert.equal(app.node('delete-category-destination-field').hidden, true);
  assert.equal(app.node('confirm-delete-category').disabled, false);
  await app.trigger('confirm-delete-category');
  assert.equal(app.categoryDraft.categories.length, 0);
  assert.equal(app.node('new-category-section').open, true);
  app.responses.push({ body: { ...data, categories: [], revision: 7 } });
  await app.trigger('categories-form', 'submit');
  assert.deepEqual(app.calls.at(-1).body.categories, []); assert.equal(app.calls.at(-1).body.items.length, 3);
});

test('previously nested website groups become peers and remain available as move destinations', async () => {
  const app = await page(); const data = categoryFixture();
  data.categories.push({ id: 'child', name: 'Детское', parentId: 'breakfast', order: 2 });
  data.categories.push({ id: 'grandchild', name: 'Малышам', parentId: 'child', order: 3 });
  app.validateMenu(data); app.openCategoryManager(); await app.trigger('delete-category');
  app.node('delete-category-destination').value = 'child'; await app.trigger('confirm-delete-category');
  assert.equal(app.categoryDraft.items[0].category, 'child');
  assert.equal(app.categoryDraft.categories.find(entry => entry.id === 'child').parentId, null);
  assert.equal(app.categoryDraft.categories.find(entry => entry.id === 'grandchild').parentId, null);
});

test('submitting an unknown dish ID never sends a creation request', async () => {
  const app = await page(); app.validateMenu(categoryFixture());
  app.openEditor(app.state.items[0]); app.draft.id = 'does-not-exist';
  const before = app.calls.length; await app.trigger('item-form', 'submit');
  assert.equal(app.calls.length, before); assert.match(app.node('editor-error').textContent, /больше недоступно/);
  assert.equal(app.draft.isNew, false);
  assert.doesNotMatch(source + html, /[Кк]атегори[яиюйях]/);
});

test('catalog profile creates a manual dish, retains existing dishes and offers ordinary deletion', async () => {
  const app = await page(undefined, { profile: 'catalog' });
  app.validateMenu(categoryFixture()); app.render();
  assert.equal(app.node('add-dish').hidden, false);
  const original = structuredClone(app.state.items);
  app.openEditor();
  assert.equal(app.node('editor-title').textContent, 'Добавить блюдо');
  assert.equal(app.draft.isNew, true);
  app.node('item-name').value = 'Новый завтрак'; app.node('description').value = 'Яйцо и авокадо'; app.node('price').value = '550';
  const category = app.node('category').value;
  const added = { id: 'new-dish-test-id', name: 'Новый завтрак', description: 'Яйцо и авокадо', price: 550,
    category, image: '', order: Math.max(0, ...original.map(item => item.order)) + 1, published: true, availableForOrder: true, hiddenOnSite: false };
  app.responses.push({ body: { categories: app.state.categories, sourceCategories: app.state.sourceCategories,
    items: [...original, added], revision: app.state.revision + 1 } });
  await app.trigger('item-form', 'submit');
  assert.equal(app.calls.at(-1).method, 'PUT');
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls.at(-1).body.items)), [...original, added]);
  assert.equal(app.node('editor-dialog').open, false);
  assert.match(app.node('dashboard-message').textContent, /Видно на сайте/);
  assert.doesNotMatch(app.node('dashboard-message').textContent, /заказать|касс/);
  const walk = node => [node, ...node.children.flatMap(walk)];
  const nodes = walk(app.itemCard(added));
  assert.ok(nodes.some(node => node.dataset.itemAction === 'delete'));
  assert.ok(!nodes.some(node => /Можно заказать|Из кассы/.test(node.textContent)));
});

test('availability sync preserves manual availability and source records, has busy state and sends only a CSRF protected status request', async () => {
  const app = await page(); const data = categoryFixture();
  data.keeperSync = { configured: true, updatedAt: null, matched: 0, forbidden: 0, limited: 0 };
  app.validateMenu(data); app.state.csrfToken = 'sync-csrf';
  let release;
  const response = { ...data, keeperSync: { ...data.keeperSync, updatedAt: '2026-09-30T12:10:00Z', matched: 1, limited: 1 },
    items: data.items.map(item => item.id === 'porridge' ? { ...item, availableForOrder: true, keeperAvailability: { forbidden: true, remaining: 1.5, updatedAt: '2026-09-30T12:10:00Z' } } : item) };
  app.responses.push({ body: response, wait: new Promise(resolve => { release = resolve; }) });
  const syncing = app.trigger('sync-availability'); await app.settle();
  assert.ok([...app.timers.values()].some(timer => timer.delay === 90000), 'The sequential API authentication and stock request has its own longer timeout');
  assert.equal(app.node('sync-availability').disabled, true); assert.equal(app.node('sync-availability').getAttribute('aria-busy'), 'true');
  assert.equal(app.calls.at(-1).url, '/api/admin/sync-availability'); assert.equal(app.calls.at(-1).method, 'POST');
  assert.equal(app.calls.at(-1).headers['X-CSRF-Token'], 'sync-csrf');
  release(); await syncing;
  assert.equal(app.state.items[0].availableForOrder, true);
  const text = node => node.textContent + node.children.map(text).join(' ');
  assert.match(text(app.itemCard(app.state.items[0])), /В стоп-листе/);
  assert.match(app.node('keeper-sync-status').textContent, /Проверено:/);
  assert.equal(app.node('sync-availability').disabled, false);
  app.openEditor(app.state.items[0]); assert.match(app.node('editor-keeper-status').textContent, /В стоп-листе/);
  assert.equal(app.state.items[0].availableForOrder, true, 'Stock is read-only and does not change persisted placement');
  app.responses.push({ body: { ...response, revision: 7 } }); await app.trigger('item-form', 'submit');
  assert.equal(app.calls.at(-1).body.items[0].keeperAvailability, undefined);
});

test('sync errors retain the previous successful timestamp and fractional stock is shown without rounding to whole portions', async () => {
  const app = await page(); const data = categoryFixture();
  data.keeperSync = { configured: true, updatedAt: '2026-09-30T12:10:00Z', matched: 1, forbidden: 0, limited: 1 };
  data.items[0].keeperAvailability = { forbidden: false, remaining: 1.5, updatedAt: data.keeperSync.updatedAt };
  app.validateMenu(data); const previous = app.node('keeper-sync-status').textContent;
  const text = node => node.textContent + node.children.map(text).join(' ');
  assert.match(text(app.itemCard(app.state.items[0])), /Осталось: 1,5 порц/);
  app.responses.push({ status: 502, body: { error: 'Касса временно недоступна' } });
  await app.trigger('sync-availability');
  assert.equal(app.node('keeper-sync-status').textContent, previous);
  assert.equal(app.state.items[0].keeperAvailability.remaining, 1.5);
  assert.match(app.node('dashboard-message').textContent, /Касса временно недоступна/);
  app.state.items[0].keeperAvailability.remaining = 0.5;
  assert.match(text(app.itemCard(app.state.items[0])), /Осталось: 0,5 порц/);
  assert.doesNotMatch(text(app.itemCard(app.state.items[0])), /Можно заказать/);
  app.state.items[0].keeperAvailability.remaining = 0;
  assert.match(text(app.itemCard(app.state.items[0])), /Нет в наличии/);
});

test('unconfigured availability sync stays disabled in both site and cash modes without issuing a request', async () => {
  const app = await page(); app.validateMenu(categoryFixture());
  const before = app.calls.length;
  for (const mode of ['site', 'cash']) {
    app.setMenuMode(mode); assert.equal(app.node('sync-availability').disabled, true);
    await app.trigger('sync-availability');
  }
  assert.equal(app.calls.length, before); assert.match(app.node('keeper-sync-status').textContent, /Подключение к кассе не настроено/);
});


const groupRow = (app, id) => app.node('category-sort-list').children.find(row => row.dataset.groupId === id);
const groupIds = app => Array.from(app.categoryDraft.categories, group => group.id);

async function moveGroupWithButton(app, id, direction) {
  await app.trigger('category-sort-list', 'click', { target: { closest: selector => selector.includes('data-group-move') ? { dataset: { groupMove: id, direction: String(direction) } } : null } });
}

test('website groups are flat and reorder buttons persist the same top-to-bottom website order only after saving', async () => {
  const app = await page(); const data = categoryFixture();
  data.categories.push({ id: 'drinks', name: 'Напитки', parentId: 'breakfast', order: 2 });
  app.validateMenu(data); app.openCategoryManager();
  assert.ok(app.categoryDraft.categories.every(group => group.parentId === null));
  assert.doesNotMatch(html, /selected-category-parent|new-category-parent|Расположение/);
  const before = app.calls.length;
  const firstId = groupIds(app)[0];
  await moveGroupWithButton(app, firstId, 1);
  assert.notEqual(groupIds(app)[0], firstId);
  assert.equal(app.calls.length, before); assert.equal(app.state.categories[0].id, firstId);
  assert.deepEqual(Array.from(app.categoryDraft.categories, group => group.order), [0, 1, 2]);
  app.responses.push({ body: { ...data, categories: app.categoryDraft.categories, revision: 7 } });
  await app.trigger('categories-form', 'submit');
  const sent = app.calls.at(-1).body;
  assert.deepEqual(sent.categories.map(group => group.id), groupIds(app));
  assert.ok(sent.categories.every(group => group.parentId === null));
  assert.deepEqual(sent.sourceCategories, data.sourceCategories);
});

test('arrow keys and Home/End on group handles reorder accessibly and cancellation discards the draft order', async () => {
  const app = await page(); app.validateMenu(categoryFixture()); app.openCategoryManager();
  const handle = groupRow(app, 'dinner').children[0];
  await app.trigger('category-sort-list', 'keydown', { key: 'Home', target: { closest: () => handle } });
  assert.deepEqual(groupIds(app), ['dinner', 'breakfast']);
  assert.match(app.node('group-sort-announcement').textContent, /место 1 из 2/);
  assert.equal(app.document.activeElement, groupRow(app, 'dinner').children[0]);
  await app.trigger('cancel-categories'); app.openCategoryManager();
  assert.deepEqual(groupIds(app), ['breakfast', 'dinner']);
  await app.trigger('category-sort-list', 'keydown', { key: 'End', target: { closest: () => groupRow(app, 'breakfast').children[0] } });
  assert.deepEqual(groupIds(app), ['dinner', 'breakfast']);
});

for (const pointerType of ['mouse', 'touch']) {
  test(`${pointerType} dragging uses a visible insertion marker and changes the draft order on release`, async () => {
    const app = await page(); app.validateMenu(categoryFixture()); app.openCategoryManager();
    const list = app.node('category-sort-list');
    list.getBoundingClientRect = () => ({ top: 0, bottom: 160, height: 160 });
    list.children.forEach((row, index) => { row.getBoundingClientRect = () => ({ top: index * 75, height: 65 }); });
    const first = groupRow(app, 'breakfast'); const second = groupRow(app, 'dinner');
    const start = { pointerId: 11, pointerType, clientY: 30, button: 0, target: { closest: () => first.children[0] } };
    await app.trigger('category-sort-list', 'pointerdown', start);
    await app.trigger('category-sort-list', 'pointermove', { ...start, clientY: 130 });
    assert.equal(first.classList.contains('is-dragging'), true);
    assert.equal(second.classList.contains('drop-after'), true);
    assert.deepEqual(groupIds(app), ['breakfast', 'dinner']);
    await app.trigger('category-sort-list', 'pointerup', { ...start, clientY: 130 });
    assert.deepEqual(groupIds(app), ['dinner', 'breakfast']);
    assert.equal(first.classList.contains('is-dragging'), false);
    assert.equal(second.classList.contains('drop-after'), false);
  });
}

test('cancelled pointer dragging and session locking clear drag visuals without committing any order', async () => {
  const app = await signedIn(); app.validateMenu(categoryFixture()); app.openCategoryManager();
  const list = app.node('category-sort-list'); list.getBoundingClientRect = () => ({ top: 0, bottom: 160, height: 160 });
  list.children.forEach((row, index) => { row.getBoundingClientRect = () => ({ top: index * 75, height: 65 }); });
  const first = groupRow(app, 'breakfast');
  const start = { pointerId: 12, pointerType: 'touch', clientY: 30, target: { closest: () => first.children[0] } };
  await app.trigger('category-sort-list', 'pointerdown', start);
  await app.trigger('category-sort-list', 'pointermove', { ...start, clientY: 130 });
  await app.trigger('category-sort-list', 'pointercancel', start);
  assert.deepEqual(groupIds(app), ['breakfast', 'dinner']); assert.equal(first.classList.contains('is-dragging'), false);
  await app.trigger('category-sort-list', 'pointerdown', start);
  await app.trigger('category-sort-list', 'pointermove', { ...start, clientY: 130 });
  app.responses.push({ body: { authenticated: false, trustedUsername: 'ira@example.test' } });
  await app.advance(900000);
  assert.equal(app.node('categories-dialog').open, false);
  assert.equal(first.classList.contains('is-dragging'), false);
  assert.deepEqual(groupIds(app), ['breakfast', 'dinner']);
});

test('hiding and restoring a dish retains its group and edits; failures never claim success', async () => {
  const app = await page(passwordSession, { profile: 'catalog' });
  app.state.csrfToken = 'visibility-csrf';
  const initial = categoryFixture(); app.validateMenu(initial); app.render();
  const item = app.state.items[0];
  const walk = node => [node, ...node.children.flatMap(walk)];
  const clickVisibility = () => app.trigger('items', 'click', { target: { closest: () => ({ dataset: { itemId: item.id, itemAction: 'visibility' } }) } });
  const hidden = { ...initial, revision: 7, items: initial.items.map(entry => entry.id === item.id ? { ...entry, hiddenOnSite: true } : entry) };
  app.responses.push({ body: hidden }); await clickVisibility();
  assert.equal(app.calls.at(-1).body.items[0].hiddenOnSite, true);
  assert.equal(app.calls.at(-1).headers['X-CSRF-Token'], 'visibility-csrf');
  assert.equal(app.state.items[0].published, false); assert.equal(app.state.items[0].availableForOrder, false);
  assert.equal(app.state.items[0].category, item.category);
  assert.ok(walk(app.node('items')).some(node => node.textContent === 'Скрыто с сайта'));
  assert.ok(walk(app.node('items')).some(node => node.textContent === 'Показать на сайте'));
  app.openEditor(app.state.items[0]); assert.equal(app.node('show-on-site').checked, false);
  app.node('description').value = 'Новое описание скрытого блюда';
  app.responses.push({ body: { ...hidden, revision: 8 } }); await app.trigger('item-form', 'submit');
  assert.equal(app.calls.at(-1).body.items[0].hiddenOnSite, true);
  assert.equal(app.calls.at(-1).body.items[0].description, 'Новое описание скрытого блюда');
  assert.match(app.node('dashboard-message').textContent, /Скрыто с сайта/);
  app.responses.push({ status: 500, body: { error: 'Не удалось сохранить' } }); await clickVisibility();
  assert.equal(app.state.items[0].hiddenOnSite, true);
  assert.doesNotMatch(app.node('dashboard-message').textContent, /снова видно/);
  app.responses.push({ body: { ...initial, revision: 9, items: initial.items.map(entry => ({ ...entry, hiddenOnSite: false })) } });
  await clickVisibility(); assert.equal(app.state.items[0].published, true);
  assert.equal(app.calls.at(-1).body.items[0].hiddenOnSite, false);
  assert.match(app.node('dashboard-message').textContent, /снова видно/);
});

test('dish editor can hide a new dish before its first publication', async () => {
  const app = await page(passwordSession, { profile: 'catalog' });
  app.state.csrfToken = 'visibility-csrf'; app.validateMenu(categoryFixture()); app.openEditor();
  assert.equal(app.node('show-on-site').checked, true);
  app.node('item-name').value = 'Будущее блюдо'; app.node('price').value = '350'; app.node('show-on-site').checked = false;
  app.responses.push({ body: { ...categoryFixture(), revision: 7 } }); await app.trigger('item-form', 'submit');
  const dish = app.calls.at(-1).body.items.at(-1);
  assert.equal(dish.hiddenOnSite, true); assert.equal(dish.published, false); assert.equal(dish.availableForOrder, false);
  assert.equal(dish.category, 'breakfast');
});
