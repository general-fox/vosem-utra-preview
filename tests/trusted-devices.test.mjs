import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { createAuthService, makeEnrolledAccount, atomicAuthWrite, additionalAccountFile, DEVICE_COOKIE_MAX_AGE } from '../server/auth.mjs';
import { addAdministrator } from '../server/add-admin.mjs';
import { totp } from '../server/totp.mjs';

const PASSWORD = 'private-fixture-password-only';
const SECRET = 'JBSWY3DPEHPK3PXP';
const KEY = Buffer.alloc(32, 91);
const TIME = 1_800_000_000_000;
async function fixture(t, { owner = true } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cafe-trusted-'));
  t.after(async () => {
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('cafe-trusted-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  let now = TIME;
  const primary = await makeEnrolledAccount({ username: 'owner@example.test', password: PASSWORD, secret: SECRET, code: totp(SECRET, { time: TIME - 60000 }), key: KEY, time: TIME - 60000 });
  if (owner) await atomicAuthWrite(path.join(dataDir, 'admin-auth.json'), primary.account);
  const service = () => createAuthService({ dataDir, production: false, password: '', encryptionKey: KEY.toString('hex'), now: () => now });
  return { dataDir, primary, service, advance: (ms) => { now += ms; }, code: () => totp(SECRET, { time: now }),
    login: async (auth) => {
      const challenge = await auth.login({ username: 'OWNER@example.test', password: PASSWORD }, 'peer');
      return auth.verify({ challengeToken: challenge.challengeToken, code: totp(SECRET, { time: now }) }, 'peer');
    }, now: () => now };
}

test('a device is remembered automatically, survives restart and idle expiry but never authorizes a session alone', async (t) => {
  const app = await fixture(t); let auth = app.service();
  const remembered = await app.login(auth);
  assert.equal(remembered.deviceMaxAge, DEVICE_COOKIE_MAX_AGE);
  const disk = await readFile(path.join(app.dataDir, 'auth-devices.json'), 'utf8');
  assert.ok(!disk.includes(remembered.deviceToken));
  const record = Object.values(JSON.parse(disk).devices)[0];
  assert.equal(record.persistent, true);
  assert.equal(Object.hasOwn(record, 'expiresAt'), false);
  app.advance(31 * 86400000);
  assert.equal(await auth.session(remembered.token), null);
  auth = app.service();
  assert.equal((await auth.status(undefined, remembered.deviceToken)).trustedUsername, 'owner@example.test');
  assert.equal((await auth.status(undefined, remembered.deviceToken)).authenticated, false);
  assert.equal((await auth.status()).trustedUsername, undefined);
  await assert.rejects(auth.resume('owner@example.test', 'peer'), { code: 'device_expired' });
  const pending = await auth.resume(remembered.deviceToken, 'peer');
  await assert.rejects(auth.verify({ challengeToken: pending.challengeToken, code: app.code() }, 'peer'), { code: 'device_expired' });
  const retry = await auth.resume(remembered.deviceToken, 'peer');
  const unlocked = await auth.verify({ challengeToken: retry.challengeToken, code: app.code() }, 'peer', remembered.deviceToken);
  assert.ok(await auth.session(unlocked.token));
  assert.notEqual(unlocked.deviceToken, remembered.deviceToken);
  assert.equal(unlocked.deviceMaxAge, DEVICE_COOKIE_MAX_AGE);
  await assert.rejects(auth.resume(remembered.deviceToken, 'peer'), { code: 'device_expired' });
  await auth.logout(unlocked.token, 'peer');
  assert.equal((await auth.status(unlocked.token, unlocked.deviceToken)).trustedUsername, 'owner@example.test');
  assert.equal((await auth.status(unlocked.token, unlocked.deviceToken)).authenticated, false);
  app.advance(401 * 86400000);
  // Even beyond the cookie's technical browser lifetime, server trust remains
  // until revoked. In a browser the missing/expired cookie requires a password.
  assert.equal((await auth.resume(unlocked.deviceToken, 'peer')).mfaRequired, true);
});

test('valid legacy devices upgrade only after real TOTP; expired legacy devices cannot revive', async (t) => {
  const app = await fixture(t); const auth = app.service(); const entry = await app.login(auth);
  const file = path.join(app.dataDir, 'auth-devices.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  const key = createHash('sha256').update(entry.deviceToken).digest('hex');
  delete stored.devices[key].persistent;
  stored.devices[key].expiresAt = TIME + 30 * 86400000;
  const expiredToken = randomBytes(32).toString('hex');
  const expiredKey = createHash('sha256').update(expiredToken).digest('hex');
  stored.devices[expiredKey] = { ...stored.devices[key], expiresAt: TIME };
  await atomicAuthWrite(file, stored);
  const before = await readFile(file, 'utf8');
  await assert.rejects(auth.resume(expiredToken, 'peer'), { code: 'device_expired' });
  assert.equal((await auth.status(undefined, entry.deviceToken)).trustedUsername, 'owner@example.test');
  assert.equal(await readFile(file, 'utf8'), before);
  app.advance(30000);
  const challenge = await auth.resume(entry.deviceToken, 'peer');
  await assert.rejects(auth.verify({ challengeToken: challenge.challengeToken, code: 'bad' }, 'peer', entry.deviceToken), { code: 'invalid_code' });
  assert.equal(await readFile(file, 'utf8'), before);
  const completed = await auth.verify({ challengeToken: challenge.challengeToken, code: app.code() }, 'peer', entry.deviceToken);
  assert.equal(completed.deviceMaxAge, DEVICE_COOKIE_MAX_AGE);
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after.devices[key], undefined);
  assert.equal(after.devices[expiredKey], undefined);
  assert.deepEqual(Object.values(after.devices).map(({ persistent, expiresAt }) => ({ persistent, expiresAt })), [{ persistent: true, expiresAt: undefined }]);
});

test('forget and credential replacement revoke remembered browsers; concurrent unlock rotates only once', async (t) => {
  const app = await fixture(t); const auth = app.service(); const entry = await app.login(auth);
  app.advance(30000);
  const a = await auth.resume(entry.deviceToken, 'peer'); const b = await auth.resume(entry.deviceToken, 'peer');
  const outcomes = await Promise.allSettled([a, b].map((pending) => auth.verify({ challengeToken: pending.challengeToken, code: app.code() }, 'peer', entry.deviceToken)));
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  const active = outcomes.find((result) => result.status === 'fulfilled').value;
  await auth.forgetDevice(active.deviceToken);
  await assert.rejects(auth.resume(active.deviceToken, 'peer'), { code: 'device_expired' });
  app.advance(30000); const again = await app.login(auth);
  const file = path.join(app.dataDir, 'admin-auth.json');
  const account = JSON.parse(await readFile(file, 'utf8')); account.credentialVersion = randomUUID();
  await atomicAuthWrite(file, account);
  await assert.rejects(auth.resume(again.deviceToken, 'peer'), { code: 'device_expired' });
});

test('recovery needs a password, never establishes trust, and device OTP attempts stay limited', async (t) => {
  const app = await fixture(t); const auth = app.service(); const entry = await app.login(auth);
  app.advance(30000);
  const resumed = await auth.resume(entry.deviceToken, 'peer');
  await assert.rejects(auth.verify({ challengeToken: resumed.challengeToken, code: app.primary.recoveryCodes[0] }, 'peer', entry.deviceToken), { code: 'invalid_code' });
  for (let i = 0; i < 4; i++) await assert.rejects(auth.verify({ challengeToken: resumed.challengeToken, code: 'bad' }, 'peer', entry.deviceToken), { code: i === 3 ? 'challenge_expired' : 'invalid_code' });
  await assert.rejects(auth.verify({ challengeToken: resumed.challengeToken, code: app.code() }, 'peer', entry.deviceToken), { code: 'challenge_expired' });
  const pending = await auth.login({ username: 'owner@example.test', password: PASSWORD }, 'peer');
  const recovered = await auth.verify({ challengeToken: pending.challengeToken, code: app.primary.recoveryCodes[0] }, 'peer', entry.deviceToken);
  assert.equal(recovered.deviceToken, undefined);
  assert.equal((await auth.status(undefined, entry.deviceToken)).trustedUsername, undefined);
  await assert.rejects(auth.resume(entry.deviceToken, 'peer'), { code: 'device_expired' });
});

test('an additional admin enrolls independently without replacing the owner or revoking the owner session', async (t) => {
  const app = await fixture(t); const auth = app.service(); const ownerSession = await app.login(auth);
  const ownerBefore = await readFile(path.join(app.dataDir, 'admin-auth.json'), 'utf8');
  const added = await addAdministrator({ dataDir: app.dataDir, username: 'ira@example.test', now: TIME });
  const credentials = await readFile(added.accessFile, 'utf8');
  const password = credentials.match(/Временный пароль: (.+)/)[1];
  await assert.rejects(addAdministrator({ dataDir: app.dataDir, username: 'ira@example.test', now: TIME }), /уже существует/);
  const pending = await auth.login({ username: 'IRA@example.test', password }, 'ira-peer');
  assert.equal(pending.requiresNewPassword, true);
  await assert.rejects(auth.enrollmentStart({ challengeToken: pending.challengeToken, username: 'owner@example.test', password: PASSWORD }, 'ira-peer'), { code: 'invalid_username' });
  await assert.rejects(auth.enrollmentStart({ challengeToken: pending.challengeToken, username: 'ira@example.test' }, 'ira-peer'), { code: 'invalid_password' });
  const started = await auth.enrollmentStart({ challengeToken: pending.challengeToken, username: 'ira@example.test', password: PASSWORD }, 'ira-peer');
  const done = await auth.enrollmentConfirm({ enrollmentToken: started.enrollmentToken, code: totp(started.secret, { time: TIME }) }, 'ira-peer');
  assert.ok(done.deviceToken); assert.equal((await auth.session(done.token)).username, 'ira@example.test');
  assert.ok(await auth.session(ownerSession.token));
  assert.equal(await readFile(path.join(app.dataDir, 'admin-auth.json'), 'utf8'), ownerBefore);
  const extra = JSON.parse(await readFile(additionalAccountFile(app.dataDir, 'ira@example.test'), 'utf8'));
  assert.equal(extra.secondary, true); assert.ok(extra.totp); assert.equal(extra.temporaryPassword, undefined);
  await assert.rejects(auth.login({ username: 'ira@example.test', password }, 'ira-peer'), { code: 'invalid_credentials' });
  app.advance(30000);
  const resumed = await auth.resume(done.deviceToken, 'ira-peer');
  await assert.rejects(auth.verify({ challengeToken: resumed.challengeToken, code: app.code() }, 'ira-peer', done.deviceToken), { code: 'invalid_code' });
  const unlocked = await auth.verify({ challengeToken: resumed.challengeToken, code: totp(started.secret, { time: app.now() }) }, 'ira-peer', done.deviceToken);
  assert.equal((await auth.session(unlocked.token)).username, 'ira@example.test');
});

test('operator-only provisioning works in a clean checkout, without granting a public signup or extending the temporary password', async (t) => {
  const app = await fixture(t, { owner: false }); const auth = app.service();
  assert.equal((await auth.status()).configured, false);
  const added = await addAdministrator({ dataDir: app.dataDir, username: 'employee@example.test', now: TIME });
  const password = (await readFile(added.accessFile, 'utf8')).match(/Временный пароль: (.+)/)[1];
  assert.equal((await auth.status()).enrollmentAvailable, true);
  await assert.rejects(auth.login({ username: 'stranger@example.test', password }, 'peer'), { code: 'invalid_credentials' });
  assert.equal((await auth.login({ username: 'employee@example.test', password }, 'peer')).enrollmentRequired, true);
  app.advance(7 * 86400000);
  await assert.rejects(auth.login({ username: 'employee@example.test', password }, 'peer'), { code: 'invalid_credentials' });
});
