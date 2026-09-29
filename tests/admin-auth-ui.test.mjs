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
async function page(session = { authenticated: false, configured: true, mfaRequired: true, production: true }, { qrRenderer = QRCode.toDataURL } = {}) {
  const nodes = new Map();
  const calls = [];
  const responses = [{ body: session }];
  const timers = new Map();
  const windowHandlers = new Map();
  const qrCalls = [];
  const document = {
    activeElement: null,
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
      value: attributes.get('value') || '', hidden, disabled: false, checked: false,
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
    setTimeout(callback, delay) { const id = Symbol(); timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    location: { href: 'https://example.test/admin.html', origin: 'https://example.test' },
    window: { addEventListener(name, handler) { windowHandlers.set(name, handler); } },
    // Inject the installed renderer at the module-loading boundary; production uses a Vite local chunk.
    __loadLocalQr: async () => ({ default: { toDataURL: async (text, options) => { qrCalls.push({ text, options }); return qrRenderer(text, options); } } }),
    fetch: async (url, options) => {
      calls.push({ url, ...options, body: options.body ? JSON.parse(options.body) : undefined });
      const response = responses.shift();
      assert.ok(response, `Unexpected request: ${url}`);
      if (response.wait) await response.wait;
      const status = response.status || 200;
      return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => response.body };
    },
  });
  const runtimeSource = source.replace("await import('qrcode')", 'await __loadLocalQr()');
  const runtime = await new vm.Script(`(async () => {\n${runtimeSource}\nreturn { state, auth, draft, sessionExpired, validUsername, validateMenu, openEditor, itemCard };\n})()`, { filename: 'admin.js' }).runInContext(context);
  return {
    ...runtime, calls, responses, timers, qrCalls,
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
  app.sessionExpired({ status: 401 });
  assert.equal(app.auth.challengeToken, '');
  assert.equal(app.node('verification-code').value, '');
  assert.equal(app.state.csrfToken, '');
  assert.equal(app.draft.resume, true);
  assert.equal(app.node('login-form').hidden, false);
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
  assert.equal(app.timers.size, 0);
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
