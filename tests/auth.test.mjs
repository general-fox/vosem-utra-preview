import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { scryptSync, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createAuthService, makePasswordRecord, verifyPassword, makeEnrolledAccount, atomicAuthWrite, encryptTotp, decryptTotp, getEncryptionKey, SCRYPT_PARAMS, withAccountLock, normalizeUsername } from '../server/auth.mjs';
import { saveAccount } from '../server/auth-cli.mjs';
import { totp, encodeBase32, verifyTotp } from '../server/totp.mjs';

const PASSWORD = 'test-only-a-long-password-123';
const SECRET = encodeBase32(Buffer.from('12345678901234567890'));
const KEY = Buffer.alloc(32, 77);
const TIME = 1_800_000_000_000;
const PASSWORD_RECORD = await makePasswordRecord(PASSWORD);
const loginData = { username: 'owner', password: PASSWORD };

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vosem-auth-'));
  let clock = TIME;
  const serviceOptions = { dataDir, password: '', production: false, now: () => clock, ...options };
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return {
    dataDir, advance(ms) { clock += ms; },
    service(extra = {}) { return createAuthService({ ...serviceOptions, ...extra }); },
    async enroll() {
      const { account, recoveryCodes } = await makeEnrolledAccount({ username: 'owner', password: PASSWORD, secret: SECRET, code: totp(SECRET, { time: TIME - 60_000 }), key: KEY, time: TIME - 60_000 });
      await atomicAuthWrite(path.join(dataDir, 'admin-auth.json'), account);
      return { account, recoveryCodes };
    },
    async localAccount() {
      const account = { version: 2, username: 'owner', credentialVersion: randomUUID(), password: PASSWORD_RECORD, totp: null, recovery: [] };
      await atomicAuthWrite(path.join(dataDir, 'admin-auth.json'), account);
      return account;
    },
  };
}

test('TOTP matches all RFC 6238 Appendix B SHA-1/SHA-256/SHA-512 vectors', () => {
  const vectors = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  const secrets = ['12345678901234567890', '12345678901234567890123456789012', '1234567890'.repeat(6) + '1234'];
  for (const [seconds, ...codes] of vectors) for (const [index, algorithm] of ['sha1', 'sha256', 'sha512'].entries()) {
    assert.equal(totp(encodeBase32(Buffer.from(secrets[index])), { time: seconds * 1000, algorithm, digits: 8 }), codes[index]);
  }
  const code = totp(SECRET, { time: TIME });
  assert.equal(verifyTotp(SECRET, code, { time: TIME, lastCounter: TIME / 30_000 }), null);
  assert.notEqual(verifyTotp(SECRET, code, { time: TIME + 30_000 }), null);
  assert.equal(verifyTotp(SECRET, code, { time: TIME + 90_000 }), null);
});

test('new password policy and versioned scrypt parameters are enforced', async () => {
  assert.equal(PASSWORD_RECORD.version, 2);
  assert.equal(PASSWORD_RECORD.N, 131072);
  assert.equal(SCRYPT_PARAMS.r, 8);
  assert.equal(SCRYPT_PARAMS.p, 1);
  await assert.rejects(makePasswordRecord('Abc123!'), /от 8 до 1024/);
  await assert.rejects(makePasswordRecord('a'.repeat(1025)), /от 8 до 1024/);
  const minimumRecord = await makePasswordRecord('Abc123!?');
  assert.equal(await verifyPassword('Abc123!?', minimumRecord), true);
  assert.equal(await verifyPassword(PASSWORD, PASSWORD_RECORD), true);
  assert.equal(await verifyPassword('incorrect-password', PASSWORD_RECORD), false);
});

test('email and legacy usernames share canonical trimming and case normalization with strict ASCII limits', () => {
  assert.equal(normalizeUsername(' V.UTRA@YANDEX.RU '), 'v.utra@yandex.ru');
  assert.equal(normalizeUsername('Owner+menu@sub.example.ru'), 'owner+menu@sub.example.ru');
  assert.equal(normalizeUsername(' ADMIN '), 'admin');
  assert.equal(normalizeUsername('Owner.Name-1_2'), 'owner.name-1_2');
  assert.equal(normalizeUsername('a'.repeat(64)), 'a'.repeat(64));
  const maximumEmail = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
  assert.equal(maximumEmail.length, 254);
  assert.equal(normalizeUsername(maximumEmail), maximumEmail);
  for (const invalidUsername of [
    '', 'ab', 'a'.repeat(65), maximumEmail + 'd', `${'a'.repeat(65)}@example.ru`,
    'v.utra@@yandex.ru', '@yandex.ru', 'v.utra@', 'v ut ra@yandex.ru', 'v.utra@yan dex.ru',
    '.v.utra@yandex.ru', 'v..utra@yandex.ru', 'v.utra.@yandex.ru', 'v.utra@localhost',
    'v.utra@-yandex.ru', 'v.utra@yandex-.ru', 'v.utra@yan_dex.ru', 'v.utra@yandex..ru',
    `v.utra@${'a'.repeat(64)}.ru`, 'v.utra@yandex.ru.', 'v.utra@яндекс.рф',
    'v.utra@yandex.ru\n', '\tv.utra@yandex.ru', 'v.utra\u0000@yandex.ru', 'v.utra@yandex.ru\u007f',
    '"v.utra"@yandex.ru', 'v.utra@yandex.ru;admin', 'v.utra@yandex.ru@evil.example',
  ]) assert.throws(() => normalizeUsername(invalidUsername), /Укажите email/, JSON.stringify(invalidUsername));
});

test('specified email enrolls and authenticates with MFA using the same normalized identity', async (t) => {
  const app = await fixture(t, { production: true, publicOrigin: 'https://cafe.example', encryptionKey: KEY.toString('hex') });
  const enrollmentTime = TIME - 60_000;
  const { account } = await makeEnrolledAccount({ username: ' V.UTRA@YANDEX.RU ', password: PASSWORD, secret: SECRET, code: totp(SECRET, { time: enrollmentTime }), key: KEY, time: enrollmentTime });
  assert.equal(account.username, 'v.utra@yandex.ru');
  await atomicAuthWrite(path.join(app.dataDir, 'admin-auth.json'), account);
  const service = app.service();
  await assert.rejects(service.login({ username: 'other@yandex.ru', password: PASSWORD }, 'peer'), { code: 'invalid_credentials' });
  const pending = await service.login({ username: '  V.Utra@Yandex.RU  ', password: PASSWORD }, 'peer');
  assert.equal(pending.mfaRequired, true);
  assert.equal(pending.token, undefined);
  const completed = await service.verify({ challengeToken: pending.challengeToken, code: totp(SECRET, { time: TIME }) }, 'peer');
  assert.equal(completed.authenticated, true);
  assert.equal((await service.session(completed.token)).username, 'v.utra@yandex.ru');
});

test('legacy simple username remains usable with surrounding spaces and mixed case', async (t) => {
  const app = await fixture(t);
  await app.localAccount();
  assert.equal((await app.service().login({ username: ' OWNER ', password: PASSWORD }, 'peer')).enrollmentRequired, true);
});

test('expensive password checks have a bounded queue instead of unlimited memory use', async () => {
  const results = await Promise.allSettled(Array.from({ length: 14 }, () => verifyPassword(PASSWORD, PASSWORD_RECORD)));
  assert.equal(results.filter((result) => result.status === 'fulfilled' && result.value === true).length, 10);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'rate_limit').length, 4);
});

test('legacy eight-character password upgrades only after confirmed MFA without requiring replacement', async (t) => {
  const app = await fixture(t);
  const password = 'old-Pw8!';
  const salt = '11'.repeat(32);
  const legacy = { salt, hash: scryptSync(password, salt, 64).toString('hex') };
  await writeFile(path.join(app.dataDir, 'admin-password.json'), JSON.stringify(legacy));
  const service = app.service();
  await assert.rejects(service.login({ username: 'admin', password: 'wrong' }, 'peer'), { code: 'invalid_credentials' });
  assert.deepEqual(JSON.parse(await readFile(path.join(app.dataDir, 'admin-password.json'), 'utf8')), legacy);
  const pending = await service.login({ username: 'admin', password }, 'peer');
  assert.equal(pending.enrollmentRequired, true);
  assert.equal(pending.requiresNewPassword, false);
  assert.deepEqual(JSON.parse(await readFile(path.join(app.dataDir, 'admin-password.json'), 'utf8')), legacy);
  const started = await service.enrollmentStart({ challengeToken: pending.challengeToken, username: 'admin' }, 'peer');
  assert.deepEqual(JSON.parse(await readFile(path.join(app.dataDir, 'admin-password.json'), 'utf8')), legacy);
  const session = await service.enrollmentConfirm({ enrollmentToken: started.enrollmentToken, code: totp(started.secret, { time: TIME }) }, 'peer');
  assert.equal(session.authenticated, true);
  const upgraded = JSON.parse(await readFile(path.join(app.dataDir, 'admin-auth.json'), 'utf8'));
  assert.equal(upgraded.password.N, 131072);
  assert.equal(await verifyPassword(password, upgraded.password), true);
  await assert.rejects(readFile(path.join(app.dataDir, 'admin-password.json')), { code: 'ENOENT' });
});

test('production requires HTTPS origin, an encryption key, and enrolled MFA', async (t) => {
  const app = await fixture(t);
  await app.localAccount();
  let service = app.service({ production: true, publicOrigin: 'https://cafe.example', encryptionKey: KEY.toString('hex') });
  assert.equal((await service.status()).ready, false);
  assert.equal((await service.status()).enrollmentAvailable, true);
  assert.equal((await service.login(loginData, 'peer')).enrollmentRequired, true);
  await app.enroll();
  for (const settings of [{ publicOrigin: 'http://cafe.example', encryptionKey: KEY.toString('hex') }, { publicOrigin: 'https://cafe.example', encryptionKey: '' }, { publicOrigin: 'https://cafe.example', encryptionKey: 'aa'.repeat(32) }]) {
    service = app.service({ production: true, ...settings });
    assert.equal((await service.status()).ready, false);
    await assert.rejects(service.login(loginData, 'peer'), { code: 'production_setup_required' });
  }
  assert.equal((await app.service({ production: true, publicOrigin: 'https://cafe.example', encryptionKey: KEY.toString('hex') }).status()).ready, true);
});

test('MFA challenge never grants a session; real TOTP completes it once and replay fails', async (t) => {
  const app = await fixture(t, { encryptionKey: KEY.toString('hex') });
  await app.enroll();
  const service = app.service();
  const pending = await service.login(loginData, 'peer');
  assert.equal(pending.mfaRequired, true);
  assert.equal(pending.token, undefined);
  assert.equal(await service.session(pending.challengeToken), null);
  const code = totp(SECRET, { time: TIME });
  const completed = await service.verify({ challengeToken: pending.challengeToken, code }, 'peer');
  assert.equal(completed.authenticated, true);
  assert.equal((await service.session(completed.token)).username, 'owner');
  await assert.rejects(service.verify({ challengeToken: pending.challengeToken, code }, 'peer'), { code: 'challenge_expired' });
  const again = await service.login(loginData, 'peer');
  await assert.rejects(service.verify({ challengeToken: again.challengeToken, code }, 'peer'), { code: 'invalid_code' });
  const restarted = app.service();
  const third = await restarted.login(loginData, 'peer');
  await assert.rejects(restarted.verify({ challengeToken: third.challengeToken, code }, 'peer'), { code: 'invalid_code' });
});

test('recovery code is hashed on disk, consumed once, and cannot be replayed after restart', async (t) => {
  const app = await fixture(t, { encryptionKey: KEY.toString('hex') });
  const { recoveryCodes } = await app.enroll();
  let service = app.service();
  let pending = await service.login(loginData, 'peer');
  const completed = await service.verify({ challengeToken: pending.challengeToken, code: recoveryCodes[0] }, 'peer');
  assert.equal(completed.authenticated, true);
  const stored = await readFile(path.join(app.dataDir, 'admin-auth.json'), 'utf8');
  assert.equal(stored.includes(recoveryCodes[0]), false);
  assert.equal(stored.includes(SECRET), false);
  assert.equal(JSON.parse(stored).recovery.length, 9);
  service = app.service();
  pending = await service.login(loginData, 'peer');
  await assert.rejects(service.verify({ challengeToken: pending.challengeToken, code: recoveryCodes[0] }, 'peer'), { code: 'invalid_code' });
});

test('pending challenge is peer-bound, expires, and stops after five wrong codes', async (t) => {
  const app = await fixture(t, { encryptionKey: KEY.toString('hex') });
  await app.enroll();
  const service = app.service();
  let pending = await service.login(loginData, 'peer');
  await assert.rejects(service.verify({ challengeToken: pending.challengeToken, code: totp(SECRET, { time: TIME }) }, 'different-peer'), { code: 'challenge_expired' });
  pending = await service.login(loginData, 'peer');
  app.advance(5 * 60_000 + 1);
  await assert.rejects(service.verify({ challengeToken: pending.challengeToken, code: totp(SECRET, { time: TIME }) }, 'peer'), { code: 'challenge_expired' });
  pending = await service.login(loginData, 'peer');
  for (let index = 0; index < 4; index++) await assert.rejects(service.verify({ challengeToken: pending.challengeToken, code: 'wrong' }, 'peer'), { code: 'invalid_code' });
  await assert.rejects(service.verify({ challengeToken: pending.challengeToken, code: 'wrong' }, 'peer'), { code: 'challenge_expired' });
});

test('failed-login throttle persists after restart and account-wide limit covers changing IPs', async (t) => {
  const app = await fixture(t);
  await app.localAccount();
  let service = app.service();
  for (let index = 0; index < 8; index++) await assert.rejects(service.login({ username: 'owner', password: '' }, 'peer'), { status: 401 });
  service = app.service();
  await assert.rejects(service.login(loginData, 'peer'), { status: 429 });
  for (let index = 0; index < 32; index++) await assert.rejects(service.login({ username: 'owner', password: '' }, `other-${index}`), { status: 401 });
  await assert.rejects(service.login(loginData, 'another-address'), { status: 429 });
  app.advance(15 * 60_000 + 1);
  assert.equal((await service.login(loginData, 'peer')).enrollmentRequired, true);
});

test('sessions have idle and absolute expiry and revoke immediately on credential change', async (t) => {
  const app = await fixture(t, { encryptionKey: KEY.toString('hex') });
  const { account, recoveryCodes } = await app.enroll();
  const service = app.service({ idleMs: 100, sessionMs: 250 });
  const authenticate = async () => {
    const pending = await service.login(loginData, 'peer');
    return service.verify({ challengeToken: pending.challengeToken, code: recoveryCodes.shift() }, 'peer');
  };
  let session = await authenticate();
  app.advance(101);
  assert.equal(await service.session(session.token), null);
  session = await authenticate();
  for (let index = 0; index < 3; index++) { app.advance(80); assert.equal((await service.activity(session.token)).authenticated, true); }
  app.advance(11);
  assert.equal(await service.session(session.token), null);
  session = await authenticate();
  await atomicAuthWrite(path.join(app.dataDir, 'admin-auth.json'), { ...account, credentialVersion: randomUUID() });
  assert.equal(await service.session(session.token), null);
});

test('session status never extends the fifteen-minute idle deadline; activity cannot bypass expiry', async (t) => {
  const app = await fixture(t, { encryptionKey: KEY.toString('hex') });
  await app.enroll();
  const service = app.service();
  const pending = await service.login(loginData, 'peer');
  const done = await service.verify({ challengeToken: pending.challengeToken, code: totp(SECRET, { time: TIME }) }, 'peer');
  assert.deepEqual(done.session, { idleTimeoutMs: 900000, idleExpiresAt: TIME + 900000, expiresAt: TIME + 28800000, serverNow: TIME });
  for (let index = 0; index < 14; index++) {
    app.advance(60000);
    const status = await service.status(done.token);
    assert.equal(status.authenticated, true);
    assert.equal(status.session.idleExpiresAt, TIME + 900000);
    assert.equal(status.session.serverNow, TIME + (index + 1) * 60000);
  }
  app.advance(60000);
  assert.equal((await service.status(done.token, done.deviceToken)).authenticated, false);
  assert.equal((await service.status(done.token, done.deviceToken)).trustedUsername, 'owner');
  await assert.rejects(service.activity(done.token), { code: 'unauthorized' });
});

test('logout wins over session checks already awaiting the account read', async (t) => {
  const app = await fixture(t, { encryptionKey: KEY.toString('hex') });
  const { recoveryCodes } = await app.enroll();
  const service = app.service();
  async function authenticate() {
    const pending = await service.login(loginData, 'peer');
    return service.verify({ challengeToken: pending.challengeToken, code: recoveryCodes.shift() }, 'peer');
  }
  let done = await authenticate();
  const activity = service.activity(done.token);
  const rejected = assert.rejects(activity, { code: 'unauthorized', status: 401 });
  await service.logout(done.token, 'peer');
  await rejected;
  assert.equal(await service.session(done.token), null);

  done = await authenticate();
  const status = service.status(done.token);
  await service.logout(done.token, 'peer');
  assert.equal((await status).authenticated, false);
  assert.equal(await service.session(done.token), null);
});

test('TOTP encryption rejects tampering; local key creation is unavailable in production', async (t) => {
  const app = await fixture(t);
  const encrypted = encryptTotp(SECRET, KEY);
  assert.equal(decryptTotp(encrypted, KEY), SECRET);
  assert.throws(() => decryptTotp({ ...encrypted, tag: '00'.repeat(16) }, KEY));
  assert.throws(() => decryptTotp(encrypted, Buffer.alloc(32)));
  await assert.rejects(getEncryptionKey({ dataDir: app.dataDir, production: true, encryptionKey: '', create: true }), /required/);
  const local = await getEncryptionKey({ dataDir: app.dataDir, encryptionKey: '', create: true });
  assert.equal(local.length, 32);
  assert.deepEqual(await getEncryptionKey({ dataDir: app.dataDir, encryptionKey: '' }), local);
});

test('security audit contains events without passwords, OTPs, secrets, cookies, or recovery codes', async (t) => {
  const app = await fixture(t, { encryptionKey: KEY.toString('hex') });
  const { recoveryCodes } = await app.enroll();
  const service = app.service();
  const pending = await service.login(loginData, 'peer');
  const completed = await service.verify({ challengeToken: pending.challengeToken, code: recoveryCodes[0] }, 'peer');
  await service.logout(completed.token, 'peer');
  const audit = await readFile(path.join(app.dataDir, 'security-audit.jsonl'), 'utf8');
  assert.match(audit, /login.mfa_requested/);
  assert.match(audit, /mfa.succeeded/);
  assert.match(audit, /logout/);
  for (const sensitive of [PASSWORD, SECRET, recoveryCodes[0], pending.challengeToken, completed.token, completed.csrfToken, KEY.toString('hex')]) assert.equal(audit.includes(sensitive), false);
});

test('bogus MFA tokens do not block a legitimate challenge behind a shared proxy IP', async (t) => {
  const app = await fixture(t, { encryptionKey: KEY.toString('hex') });
  await app.enroll();
  const service = app.service();
  const pending = await service.login(loginData, 'proxy');
  for (let index = 0; index < 20; index++) await assert.rejects(service.verify({ challengeToken: `bogus-${index}`, code: '000000' }, 'proxy'), { code: 'challenge_expired' });
  assert.equal((await service.verify({ challengeToken: pending.challengeToken, code: totp(SECRET, { time: TIME }) }, 'proxy')).authenticated, true);
});

test('password maintenance merges latest MFA state under the account lock', async (t) => {
  const app = await fixture(t, { encryptionKey: KEY.toString('hex') });
  const { recoveryCodes } = await app.enroll();
  const service = app.service();
  const pending = await service.login(loginData, 'peer');
  await service.verify({ challengeToken: pending.challengeToken, code: recoveryCodes[0] }, 'peer');
  const changed = await saveAccount(app.dataDir, (current) => ({ ...current, credentialVersion: randomUUID(), password: PASSWORD_RECORD }), 'credentials.password_changed');
  assert.equal(changed.recovery.length, 9);
  const again = await service.login(loginData, 'peer');
  await assert.rejects(service.verify({ challengeToken: again.challengeToken, code: recoveryCodes[0] }, 'peer'), { code: 'invalid_code' });
});

test('credential replacement while MFA waits on a CLI lock cannot be overwritten', async (t) => {
  const app = await fixture(t, { encryptionKey: KEY.toString('hex') });
  const { account } = await app.enroll();
  const service = app.service();
  const pending = await service.login(loginData, 'peer');
  let release; let signal;
  const acquired = new Promise((resolve) => { signal = resolve; });
  const holding = withAccountLock(app.dataDir, async () => {
    signal(); await new Promise((resolve) => { release = resolve; });
    await atomicAuthWrite(path.join(app.dataDir, 'admin-auth.json'), { ...account, credentialVersion: 'new-credential-version' });
  });
  await acquired;
  const attempt = service.verify({ challengeToken: pending.challengeToken, code: totp(SECRET, { time: TIME }) }, 'peer');
  const rejected = assert.rejects(attempt, { code: 'challenge_expired' });
  release(); await holding; await rejected;
  assert.equal(JSON.parse(await readFile(path.join(app.dataDir, 'admin-auth.json'), 'utf8')).credentialVersion, 'new-credential-version');
});

test('production bootstrap enrollment exposes no session or secret before password and persists only after TOTP', async (t) => {
  const app = await fixture(t, { production: true, publicOrigin: 'https://cafe.example', encryptionKey: KEY.toString('hex'), password: PASSWORD, username: ' V.UTRA@YANDEX.RU ' });
  const service = app.service();
  const before = await service.status();
  assert.equal(before.ready, false);
  assert.equal(before.enrollmentAvailable, true);
  assert.equal(before.mfaRequired, true);
  assert.equal(JSON.stringify(before).includes('secret'), false);
  await assert.rejects(service.login({ username: 'v.utra@yandex.ru', password: 'wrong-password' }, 'peer'), { code: 'invalid_credentials' });
  await assert.rejects(service.enrollmentStart({ challengeToken: 'invented', username: 'v.utra@yandex.ru' }, 'peer'), { code: 'challenge_expired' });
  await assert.rejects(readFile(path.join(app.dataDir, 'admin-auth.json')), { code: 'ENOENT' });
  const pending = await service.login({ username: 'V.UTRA@YANDEX.RU', password: PASSWORD }, 'peer');
  assert.equal(pending.enrollmentRequired, true);
  assert.equal(pending.username, 'v.utra@yandex.ru');
  assert.equal(pending.requiresNewPassword, false);
  assert.equal(pending.token, undefined);
  assert.equal(await service.session(pending.challengeToken), null);
  const started = await service.enrollmentStart({ challengeToken: pending.challengeToken, username: 'v.utra@yandex.ru' }, 'peer');
  assert.match(started.otpauthUri, /^otpauth:\/\/totp\//);
  assert.equal(started.expiresIn, 300);
  await assert.rejects(readFile(path.join(app.dataDir, 'admin-auth.json')), { code: 'ENOENT' });
  await assert.rejects(service.enrollmentConfirm({ enrollmentToken: started.enrollmentToken, code: 'wrong' }, 'peer'), { code: 'invalid_code' });
  await assert.rejects(readFile(path.join(app.dataDir, 'admin-auth.json')), { code: 'ENOENT' });
  const completed = await service.enrollmentConfirm({ enrollmentToken: started.enrollmentToken, code: totp(started.secret, { time: TIME }) }, 'peer');
  assert.equal(completed.authenticated, true);
  assert.equal(completed.recoveryCodes.length, 10);
  assert.equal((await service.session(completed.token)).username, 'v.utra@yandex.ru');
  const saved = await readFile(path.join(app.dataDir, 'admin-auth.json'), 'utf8');
  const audit = await readFile(path.join(app.dataDir, 'security-audit.jsonl'), 'utf8');
  for (const secret of [PASSWORD, started.secret, started.otpauthUri, started.enrollmentToken, ...completed.recoveryCodes]) {
    assert.equal(saved.includes(secret), false);
    assert.equal(audit.includes(secret), false);
  }
  await assert.rejects(service.enrollmentConfirm({ enrollmentToken: started.enrollmentToken, code: totp(started.secret, { time: TIME }) }, 'peer'), { code: 'challenge_expired' });
  const nextLogin = await service.login({ username: 'v.utra@yandex.ru', password: PASSWORD }, 'peer');
  assert.equal(nextLogin.mfaRequired, true);
  assert.equal(nextLogin.enrollmentRequired, undefined);
});

test('seven-character legacy password must be replaced; eight-character replacement still requires MFA', async (t) => {
  const app = await fixture(t);
  const weak = 'old-Pw7';
  const replacement = 'new-Pw8!';
  const salt = '22'.repeat(32);
  const legacy = { salt, hash: scryptSync(weak, salt, 64).toString('hex') };
  await writeFile(path.join(app.dataDir, 'admin-password.json'), JSON.stringify(legacy));
  const service = app.service();
  let pending = await service.login({ username: 'admin', password: weak }, 'peer');
  assert.equal(pending.requiresNewPassword, true);
  await assert.rejects(service.enrollmentStart({ challengeToken: pending.challengeToken, username: 'v.utra@yandex.ru' }, 'peer'), { code: 'invalid_password' });
  await assert.rejects(service.enrollmentStart({ challengeToken: pending.challengeToken, username: 'v.utra@yandex.ru', password: 'new-Pw7' }, 'peer'), { code: 'invalid_password' });
  let started = await service.enrollmentStart({ challengeToken: pending.challengeToken, username: 'v.utra@yandex.ru', password: replacement }, 'peer');
  assert.equal(await service.session(started.enrollmentToken), null);
  await assert.rejects(service.enrollmentConfirm({ enrollmentToken: started.enrollmentToken, code: 'wrong' }, 'peer'), { code: 'invalid_code' });
  await service.enrollmentCancel({ enrollmentToken: started.enrollmentToken }, 'peer');
  await assert.rejects(service.enrollmentConfirm({ enrollmentToken: started.enrollmentToken, code: totp(started.secret, { time: TIME }) }, 'peer'), { code: 'challenge_expired' });
  assert.deepEqual(JSON.parse(await readFile(path.join(app.dataDir, 'admin-password.json'), 'utf8')), legacy);
  await assert.rejects(readFile(path.join(app.dataDir, 'admin-auth.json')), { code: 'ENOENT' });
  pending = await service.login({ username: 'admin', password: weak }, 'peer');
  started = await service.enrollmentStart({ challengeToken: pending.challengeToken, username: 'v.utra@yandex.ru', password: replacement }, 'peer');
  await service.enrollmentConfirm({ enrollmentToken: started.enrollmentToken, code: totp(started.secret, { time: TIME }) }, 'peer');
  const saved = JSON.parse(await readFile(path.join(app.dataDir, 'admin-auth.json'), 'utf8'));
  assert.equal(await verifyPassword(replacement, saved.password), true);
  assert.equal(await verifyPassword(weak, saved.password), false);
  assert.equal(saved.username, 'v.utra@yandex.ru');
  const nextLogin = await service.login({ username: 'v.utra@yandex.ru', password: replacement }, 'peer');
  assert.equal(nextLogin.mfaRequired, true);
  assert.equal(nextLogin.token, undefined);
});

test('cancelling password challenge and a concurrently queued confirmation prevents enrollment', async (t) => {
  const app = await fixture(t);
  const original = await app.localAccount();
  const service = app.service();
  let pending = await service.login(loginData, 'peer');
  await service.enrollmentCancel({ challengeToken: pending.challengeToken }, 'peer');
  await assert.rejects(service.enrollmentStart({ challengeToken: pending.challengeToken, username: 'owner' }, 'peer'), { code: 'challenge_expired' });
  pending = await service.login(loginData, 'peer');
  const started = await service.enrollmentStart({ challengeToken: pending.challengeToken, username: 'owner' }, 'peer');
  const cancelled = service.enrollmentCancel({ enrollmentToken: started.enrollmentToken }, 'peer');
  const confirming = service.enrollmentConfirm({ enrollmentToken: started.enrollmentToken, code: totp(started.secret, { time: TIME }) }, 'peer');
  await cancelled;
  await assert.rejects(confirming, { code: 'challenge_expired' });
  assert.deepEqual(JSON.parse(await readFile(path.join(app.dataDir, 'admin-auth.json'), 'utf8')), original);
});

test('pending browser enrollment cannot overwrite a concurrent CLI MFA setup', async (t) => {
  const app = await fixture(t, { encryptionKey: KEY.toString('hex') });
  await app.localAccount();
  const service = app.service();
  const pending = await service.login(loginData, 'peer');
  const started = await service.enrollmentStart({ challengeToken: pending.challengeToken, username: 'owner' }, 'peer');
  let release; let signal;
  const acquired = new Promise((resolve) => { signal = resolve; });
  let replacement;
  const holding = withAccountLock(app.dataDir, async () => {
    signal(); await new Promise((resolve) => { release = resolve; });
    replacement = (await app.enroll()).account;
  });
  await acquired;
  const rejected = assert.rejects(service.enrollmentConfirm({ enrollmentToken: started.enrollmentToken, code: totp(started.secret, { time: TIME }) }, 'peer'), { code: 'challenge_expired' });
  release(); await holding; await rejected;
  assert.deepEqual(JSON.parse(await readFile(path.join(app.dataDir, 'admin-auth.json'), 'utf8')), replacement);
});

test('enrollment capabilities are peer-bound, expire, and stop after five incorrect codes', async (t) => {
  const app = await fixture(t);
  const original = await app.localAccount();
  const service = app.service();
  let pending = await service.login(loginData, 'peer');
  await assert.rejects(service.enrollmentStart({ challengeToken: pending.challengeToken, username: 'owner' }, 'other'), { code: 'challenge_expired' });
  app.advance(300_001);
  await assert.rejects(service.enrollmentStart({ challengeToken: pending.challengeToken, username: 'owner' }, 'peer'), { code: 'challenge_expired' });
  pending = await service.login(loginData, 'peer');
  const started = await service.enrollmentStart({ challengeToken: pending.challengeToken, username: 'owner' }, 'peer');
  await assert.rejects(service.enrollmentConfirm({ enrollmentToken: started.enrollmentToken, code: 'wrong' }, 'other'), { code: 'challenge_expired' });
  for (let index = 0; index < 4; index++) await assert.rejects(service.enrollmentConfirm({ enrollmentToken: started.enrollmentToken, code: 'wrong' }, 'peer'), { code: 'invalid_code' });
  await assert.rejects(service.enrollmentConfirm({ enrollmentToken: started.enrollmentToken, code: 'wrong' }, 'peer'), { code: 'challenge_expired' });
  assert.deepEqual(JSON.parse(await readFile(path.join(app.dataDir, 'admin-auth.json'), 'utf8')), original);
});

test('existing MFA and unconfigured accounts cannot be claimed through enrollment endpoints', async (t) => {
  const app = await fixture(t, { encryptionKey: KEY.toString('hex') });
  const service = app.service();
  assert.equal((await service.status()).enrollmentAvailable, false);
  await assert.rejects(service.login(loginData, 'peer'), { code: 'not_configured' });
  await assert.rejects(service.enrollmentStart({ challengeToken: 'invented', username: 'owner', password: PASSWORD }, 'peer'), { code: 'challenge_expired' });
  const { account } = await app.enroll();
  const pending = await service.login(loginData, 'peer');
  assert.equal(pending.mfaRequired, true);
  await assert.rejects(service.enrollmentStart({ challengeToken: pending.challengeToken, username: 'attacker', password: PASSWORD }, 'peer'), { code: 'challenge_expired' });
  assert.deepEqual(JSON.parse(await readFile(path.join(app.dataDir, 'admin-auth.json'), 'utf8')), account);
});

test('enrollment start and confirmation capabilities each succeed only once under concurrency', async (t) => {
  const app = await fixture(t);
  await app.localAccount();
  const service = app.service();
  const pending = await service.login(loginData, 'peer');
  const starts = await Promise.allSettled([1, 2].map(() => service.enrollmentStart({ challengeToken: pending.challengeToken, username: 'owner', password: PASSWORD }, 'peer')));
  assert.equal(starts.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(starts.filter((entry) => entry.status === 'rejected' && entry.reason.code === 'challenge_expired').length, 1);
  const started = starts.find((entry) => entry.status === 'fulfilled').value;
  const confirms = await Promise.allSettled([1, 2].map(() => service.enrollmentConfirm({ enrollmentToken: started.enrollmentToken, code: totp(started.secret, { time: TIME }) }, 'peer')));
  assert.equal(confirms.filter((entry) => entry.status === 'fulfilled' && entry.value.authenticated).length, 1);
  assert.equal(confirms.filter((entry) => entry.status === 'rejected' && entry.reason.code === 'challenge_expired').length, 1);
});

test('cancellation invalidates an in-flight start before its replacement password can be persisted', async (t) => {
  const app = await fixture(t);
  const original = await app.localAccount();
  const service = app.service();
  const pending = await service.login(loginData, 'peer');
  const started = service.enrollmentStart({ challengeToken: pending.challengeToken, username: 'owner', password: PASSWORD + '-replacement' }, 'peer');
  const rejected = assert.rejects(started, { code: 'challenge_expired' });
  await service.enrollmentCancel({ challengeToken: pending.challengeToken }, 'peer');
  await rejected;
  assert.deepEqual(JSON.parse(await readFile(path.join(app.dataDir, 'admin-auth.json'), 'utf8')), original);
});
