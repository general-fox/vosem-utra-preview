import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import QRCode from 'qrcode';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

const source = await readFile(new URL('../admin.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../admin.html', import.meta.url), 'utf8');

// Exercise the real event handlers without opening a browser or making network calls.
async function page(session = { authenticated: false, configured: true, mfaRequired: true, production: true },
  { qrRenderer = QRCode.toDataURL, storage = new Map(), responsesAfterSession = [] } = {}) {
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
  };
  function makeNode(attributes = new Map(), hidden = false) {
    const handlers = new Map();
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
      classList: { toggle() {} },
    };
  }
  for (const match of html.matchAll(/<([a-z][a-z\d-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const attributes = new Map([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((entry) => [entry[1], entry[2]]));
    nodes.set(match[3], makeNode(attributes, /\bhidden\b/.test(match[2])));
  }
  const context = vm.createContext({
    document, Intl, URL, AbortController, crypto: { randomUUID: () => 'new-dish-test-id' },
    Date: class extends Date { static now() { return now; } },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
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
      return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body };
    },
  });
  const runtimeSource = source.replace("await import('qrcode')", 'await __loadLocalQr()');
  const runtime = await new vm.Script(`(async () => {\n${runtimeSource}\nreturn { state, auth, draft, idle, sessionExpired, validUsername, validateMenu, openEditor, itemCard, loadMenu, lockSession, checkSession };\n})()`, { filename: 'admin.js' }).runInContext(context);
  async function settle() { for (let index = 0; index < 20; index += 1) await Promise.resolve(); }
  return {
    ...runtime, calls, responses, timers, qrCalls, broadcasts, document, storage,
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
    async trigger(id, event = 'click') {
      const handler = document.getElementById(id).handlers.get(event);
      assert.ok(handler, `Missing handler: ${id}/${event}`);
      await handler({ preventDefault() {} });
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


test('menu editor defaults legacy and new dishes to orderable, preserves explicit unavailability and saves it independently', async () => {
  const app = await page();
  const legacy = { id: 'legacy-toast', name: 'Тост', description: 'Яйцо и хлеб', price: 450, category: 'eggs', image: '', published: true, order: 1 };
  app.validateMenu({ items: [legacy], revision: 3 });
  assert.equal(app.state.items[0].availableForOrder, true);
  app.openEditor(app.state.items[0]);
  assert.equal(app.node('available-for-order').checked, true);
  assert.equal(app.node('published').checked, true);
  app.node('available-for-order').checked = false;
  app.responses.push({ body: { items: [{ ...legacy, availableForOrder: false }], revision: 4 } });
  await app.trigger('item-form', 'submit');
  const saved = app.calls.at(-1).body;
  assert.equal(saved.revision, 3);
  assert.equal(saved.items[0].availableForOrder, false);
  assert.equal(saved.items[0].published, true);
  assert.equal(app.state.items[0].availableForOrder, false);
  app.openEditor(app.state.items[0]);
  assert.equal(app.node('available-for-order').checked, false, 'Reopening must not reset explicit false');
  const text = (node) => node.textContent + node.children.map(text).join(' ');
  assert.match(text(app.itemCard(app.state.items[0])), /Временно недоступно/);
  app.openEditor();
  assert.equal(app.node('available-for-order').checked, true);
  assert.equal(app.node('published').checked, true);
});

test('malformed availability from the menu server is rejected rather than silently enabling ordering', async () => {
  const app = await page();
  for (const availableForOrder of [null, 'false', 0]) {
    assert.throws(() => app.validateMenu({ items: [{ id: 'bad', availableForOrder }], revision: 1 }), /некорректную доступность/);
  }
});

test('remembering the browser is automatic with no checkbox or opt-in request flag', async () => {
  const app = await page();
  assert.doesNotMatch(html, /id="remember-device"/);
  assert.match(html, /Запомним этот браузер/);
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

test('15 minutes without real activity automatically hides dashboard and dialogs, retaining draft and captured logout CSRF', async () => {
  const app = await signedIn();
  app.openEditor();
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
  app.openEditor();
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
  app.openEditor();
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
