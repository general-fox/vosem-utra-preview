import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile, rename, appendFile, stat, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { encodeBase32, verifyTotp } from './totp.mjs';

const scrypt = promisify(scryptCallback);
export const SCRYPT_PARAMS = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
const LEGACY_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
const ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
const CHALLENGE_MS = 5 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
export const DEVICE_MS = 30 * 24 * 60 * 60 * 1000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
export const additionalAccountFile = (dataDir, username) => path.join(dataDir, 'admin-users', `${hash(normalizeUsername(username))}.json`);
let activeHashes = 0;
const hashWaiters = [];

export class AuthError extends Error {
  constructor(status, message, code, retryAfter) { super(message); this.status = status; this.code = code; this.retryAfter = retryAfter; }
}
const invalid = () => new AuthError(401, 'Неверные данные для входа.', 'invalid_credentials');
const unavailable = () => new AuthError(503, 'Вход администратора требует настройки на сервере.', 'production_setup_required');

export function equalSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function boundedHash(password, salt, parameters) {
  if (activeHashes >= 2) {
    if (hashWaiters.length >= 8) throw new AuthError(429, 'Повторите вход позже.', 'rate_limit', 30);
    await new Promise((resolve) => hashWaiters.push(resolve));
  } else activeHashes += 1;
  try { return await scrypt(password, salt, 64, parameters); }
  finally { const next = hashWaiters.shift(); if (next) next(); else activeHashes -= 1; }
}

export async function makePasswordRecord(password, { legacyUpgrade = false } = {}) {
  const minimum = legacyUpgrade ? 1 : 15;
  if (typeof password !== 'string' || password.length < minimum || password.length > 1024) throw new Error('Пароль должен содержать от 15 до 1024 символов.');
  const salt = randomBytes(32).toString('hex');
  const value = await boundedHash(password, salt, SCRYPT_PARAMS);
  return { version: 2, algorithm: 'scrypt', salt, hash: value.toString('hex'), N: SCRYPT_PARAMS.N, r: 8, p: 1 };
}

function validatePasswordRecord(record) {
  if (!record || !/^[a-f0-9]{64}$/.test(record.salt) || !/^[a-f0-9]{128}$/.test(record.hash)) throw new Error('Invalid credential record');
  if (record.version !== undefined && (record.version !== 2 || record.algorithm !== 'scrypt' || record.N !== SCRYPT_PARAMS.N || record.r !== 8 || record.p !== 1)) throw new Error('Unsupported password record');
  return record;
}
export async function verifyPassword(password, record) {
  validatePasswordRecord(record);
  const candidate = await boundedHash(password, record.salt, record.version === 2 ? SCRYPT_PARAMS : LEGACY_PARAMS);
  return equalSecret(candidate.toString('hex'), record.hash);
}
export function normalizeUsername(value) {
  const invalidUsername = () => new Error('Укажите email до 254 символов или логин: 3–64 латинские буквы, цифры, точка, дефис или подчёркивание.');
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw invalidUsername();
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254) throw invalidUsername();
  if (!normalized.includes('@')) {
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized)) throw invalidUsername();
    return normalized;
  }
  const [local, domain, extra] = normalized.split('@');
  const dotAtom = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
  const domainName = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
  if (extra !== undefined || !local || local.length > 64 || !domain || !dotAtom.test(local) || !domainName.test(domain)) throw invalidUsername();
  return normalized;
}

export async function atomicAuthWrite(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, filename);
}
// Cross-process guard for the local setup CLI and server MFA consumption. No unsafe lease expiry.
export async function withAccountLock(dataDir, operation) {
  await mkdir(dataDir, { recursive: true });
  const lock = path.join(dataDir, 'auth-account.lock');
  const deadline = Date.now() + 10_000;
  while (true) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new AuthError(503, 'Доступ занят настройкой. Повторите позже.', 'auth_busy');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await operation(); }
  finally { await rmdir(lock); }
}
async function optionalJson(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function getEncryptionKey({ dataDir, production = false, encryptionKey = process.env.AUTH_ENCRYPTION_KEY, create = false }) {
  if (encryptionKey) {
    const key = /^[a-f0-9]{64}$/i.test(encryptionKey) ? Buffer.from(encryptionKey, 'hex') : Buffer.from(encryptionKey, 'base64');
    if (key.length !== 32) throw new Error('AUTH_ENCRYPTION_KEY must contain 32 random bytes encoded as hex or base64');
    return key;
  }
  if (production) throw new Error('AUTH_ENCRYPTION_KEY is required in production');
  const filename = path.join(dataDir, 'auth-key');
  try {
    const value = (await readFile(filename, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid local auth key');
    return Buffer.from(value, 'hex');
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    await mkdir(dataDir, { recursive: true });
    const key = randomBytes(32);
    try { await writeFile(filename, key.toString('hex'), { mode: 0o600, flag: 'wx' }); }
    catch (writeError) { if (writeError.code === 'EEXIST') return getEncryptionKey({ dataDir, production, create: false }); throw writeError; }
    return key;
  }
}
export function encryptTotp(secret, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('vosem-utra:totp:v1'));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('hex'), ciphertext: ciphertext.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}
export function decryptTotp(record, key) {
  if (record?.version !== 1 || !/^[a-f0-9]{24}$/.test(record.iv) || !/^[a-f0-9]{32}$/.test(record.tag) || !/^[a-f0-9]{32,256}$/.test(record.ciphertext)) throw new Error('Invalid encrypted TOTP secret');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'hex'));
  decipher.setAAD(Buffer.from('vosem-utra:totp:v1'));
  decipher.setAuthTag(Buffer.from(record.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'hex')), decipher.final()]).toString('utf8');
}
export function createRecoveryCodes() {
  return Array.from({ length: 10 }, () => randomBytes(16).toString('hex').match(/.{4}/g).join('-'));
}
const recoveryHash = (code) => hash(`vosem-recovery-v1:${code.toLowerCase().replaceAll('-', '').replaceAll(' ', '')}`);

export async function makeEnrolledAccount({ username, password, secret, code, key, time = Date.now() }) {
  const lastCounter = verifyTotp(secret, code, { time });
  if (lastCounter === null) throw new Error('Код не подтверждён. Данные доступа не изменены.');
  const recoveryCodes = createRecoveryCodes();
  const account = {
    version: 2, username: normalizeUsername(username), credentialVersion: randomUUID(), password: await makePasswordRecord(password),
    totp: { encrypted: encryptTotp(secret, key), lastCounter }, recovery: recoveryCodes.map(recoveryHash),
  };
  return { account, recoveryCodes };
}
export const createTotpSecret = () => encodeBase32(randomBytes(20));

/** One process owns auth state. Durable reservations survive process restarts. */
export function createAuthService(options) {
  const { dataDir } = options;
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const publicOrigin = Object.hasOwn(options, 'publicOrigin') ? options.publicOrigin : process.env.PUBLIC_ORIGIN;
  const encryptionKey = options.encryptionKey ?? process.env.AUTH_ENCRYPTION_KEY;
  const environmentPassword = options.password ?? process.env.ADMIN_PASSWORD;
  const environmentUsername = options.username ?? process.env.ADMIN_USERNAME ?? 'admin';
  const now = options.now ?? Date.now;
  const sessionMs = options.sessionMs ?? ABSOLUTE_MS;
  const idleMs = options.idleMs ?? IDLE_MS;
  const accountFile = path.join(dataDir, 'admin-auth.json');
  const legacyFile = path.join(dataDir, 'admin-password.json');
  const throttleFile = path.join(dataDir, 'auth-throttle.json');
  const devicesFile = path.join(dataDir, 'auth-devices.json');
  const sessions = new Map(); const challenges = new Map(); const enrollments = new Map();
  let queue = Promise.resolve(); let auditQueue = Promise.resolve(); let environmentAccount;
  const serial = (operation) => { const result = queue.then(operation); queue = result.catch(() => {}); return result; };
  const remember = (map, token, value) => {
    map.set(token, value);
    // Expired enrollment secrets are discarded even when the browser never sends another request.
    const timer = setTimeout((store, key) => store.delete(key), CHALLENGE_MS, map, token);
    timer.unref();
  };

  function audit(event, ip = '', detail = {}) {
    const allowed = {};
    for (const name of ['revision', 'count', 'method', 'username']) if (['string', 'number'].includes(typeof detail[name])) allowed[name] = detail[name];
    const entry = JSON.stringify({ at: new Date(now()).toISOString(), event, ...(ip ? { peer: hash(ip).slice(0, 24) } : {}), ...allowed }) + '\n';
    const result = auditQueue.then(async () => {
      await mkdir(dataDir, { recursive: true });
      const filename = path.join(dataDir, 'security-audit.jsonl');
      try { if ((await stat(filename)).size > 5 * 1024 * 1024) await rename(filename, `${filename}.1`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await appendFile(filename, entry, { mode: 0o600 });
    });
    auditQueue = result.catch(() => {});
    return result;
  }

  async function account(username) {
    const extra = username ? await optionalJson(additionalAccountFile(dataDir, username)) : null;
    let saved = extra ?? await optionalJson(accountFile);
    // A Git checkout intentionally contains no owner secrets. An operator-provisioned
    // employee can still enroll locally without creating/replacing an owner account.
    if (!saved && !environmentPassword && !await optionalJson(legacyFile)) {
      const names = await readdir(path.join(dataDir, 'admin-users')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
      const name = names.filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry)).sort()[0];
      if (name) {
        saved = await optionalJson(path.join(dataDir, 'admin-users', name));
        if (!saved || saved.secondary !== true || path.basename(additionalAccountFile(dataDir, saved.username)) !== name) throw new Error('Invalid additional account');
      }
    }
    if (saved) {
      if (extra && (extra.username !== username || extra.secondary !== true)) throw new Error('Invalid additional account');
      if (saved.version !== 2 || normalizeUsername(saved.username) !== saved.username || typeof saved.credentialVersion !== 'string') throw new Error('Invalid account');
      validatePasswordRecord(saved.password);
      if (saved.totp && (!Number.isSafeInteger(saved.totp.lastCounter) || !Array.isArray(saved.recovery) || saved.recovery.some((code) => !/^[a-f0-9]{64}$/.test(code)))) throw new Error('Invalid MFA account');
      return saved;
    }
    if (environmentPassword) {
      if (!environmentAccount) environmentAccount = makePasswordRecord(environmentPassword, { legacyUpgrade: !production }).then((password) => ({ version: 2, username: normalizeUsername(environmentUsername), credentialVersion: hash(password.hash), password, totp: null, recovery: [], environment: true }));
      return environmentAccount;
    }
    const legacy = await optionalJson(legacyFile);
    if (!legacy) return null;
    validatePasswordRecord(legacy);
    return { version: 2, username: 'admin', credentialVersion: hash(JSON.stringify(legacy)), password: legacy, totp: null, recovery: [], legacy: true };
  }

  async function configurationReady(current) {
    if (!current) return false;
    if (production) {
      let secureOrigin = false;
      try { const url = new URL(publicOrigin); secureOrigin = url.protocol === 'https:' && url.origin === publicOrigin; } catch {}
      if (!secureOrigin || !encryptionKey) return false;
      try { await getEncryptionKey({ dataDir, production, encryptionKey }); } catch { return false; }
    }
    if (current.totp) {
      try { decryptTotp(current.totp.encrypted, await getEncryptionKey({ dataDir, production, encryptionKey })); }
      catch { return false; }
    }
    return true;
  }
  async function state(username) {
    try {
      const current = await account(username); const configured = await configurationReady(current);
      return { current, ready: configured && Boolean(current.totp), enrollmentAvailable: configured && !current.totp };
    } catch { return { current: null, ready: false, enrollmentAvailable: false }; }
  }

  const saveAccount = (current) => atomicAuthWrite(current.secondary === true ? additionalAccountFile(dataDir, current.username) : accountFile, current);
  async function deviceStore() {
    const saved = await optionalJson(devicesFile) ?? { version: 1, devices: {} };
    if (saved.version !== 1 || !saved.devices || typeof saved.devices !== 'object' || Array.isArray(saved.devices)) throw new Error('Invalid trusted device storage');
    for (const [key, device] of Object.entries(saved.devices)) if (device.expiresAt <= now()) delete saved.devices[key];
    return saved;
  }
  async function trustedDevice(token, saved) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const device = (saved ?? await deviceStore()).devices[hash(token)];
    if (!device || device.expiresAt <= now()) return null;
    const fresh = await state(device.username);
    return fresh.ready && fresh.current.username === device.username && fresh.current.credentialVersion === device.credentialVersion ? device : null;
  }
  // Caller holds the account lock. Rotation never extends the original 30-day deadline.
  async function rememberDevice(current, oldToken, expiresAt = now() + DEVICE_MS) {
    const saved = await deviceStore();
    if (oldToken) delete saved.devices[hash(oldToken)];
    const token = randomBytes(32).toString('hex');
    if (Object.keys(saved.devices).length >= 100) delete saved.devices[Object.keys(saved.devices)[0]];
    saved.devices[hash(token)] = { username: current.username, credentialVersion: current.credentialVersion, expiresAt };
    await atomicAuthWrite(devicesFile, saved);
    return { deviceToken: token, deviceMaxAge: Math.max(0, Math.floor((expiresAt - now()) / 1000)) };
  }
  async function forgetDevice(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return;
    await serial(() => withAccountLock(dataDir, async () => {
      const saved = await deviceStore(); delete saved.devices[hash(token)]; await atomicAuthWrite(devicesFile, saved);
    }));
  }
  async function resume(deviceToken, ip) {
    const device = await trustedDevice(deviceToken);
    if (!device) throw new AuthError(401, 'Срок запоминания истёк. Войдите с паролем.', 'device_expired');
    const challengeToken = randomBytes(32).toString('hex');
    if (challenges.size >= 100) challenges.delete(challenges.keys().next().value);
    remember(challenges, challengeToken, { type: 'mfa', username: device.username, credentialVersion: device.credentialVersion,
      deviceHash: hash(deviceToken), ip, expiresAt: now() + CHALLENGE_MS, attempts: 0 });
    return { mfaRequired: true, challengeToken, trusted: true, username: device.username };
  }

  async function throttleRead() {
    const saved = await optionalJson(throttleFile) ?? { version: 1, buckets: {} };
    if (saved.version !== 1 || !saved.buckets || typeof saved.buckets !== 'object' || Array.isArray(saved.buckets)) throw new Error('Invalid throttle state');
    for (const [key, value] of Object.entries(saved.buckets)) {
      if (!Number.isFinite(value.until) || !Number.isInteger(value.count) || value.count < 0) throw new Error('Invalid throttle bucket');
      if (value.until <= now()) delete saved.buckets[key];
    }
    return saved;
  }
  function reserve(ip, phase) {
    return serial(async () => {
      const saved = await throttleRead();
      const keys = [`${phase}:ip:${hash(ip)}`, `${phase}:global`];
      for (const [index, name] of keys.entries()) {
        const value = saved.buckets[name];
        if (value && value.count >= (index === 0 ? 8 : 40)) throw new AuthError(429, 'Слишком много попыток. Повторите позже.', 'rate_limit', Math.ceil((value.until - now()) / 1000));
      }
      const reservations = keys.map((name) => {
        const value = saved.buckets[name] ?? { count: 0, until: now() + WINDOW_MS };
        value.count += 1; saved.buckets[name] = value;
        return { name, until: value.until };
      });
      await atomicAuthWrite(throttleFile, saved);
      return reservations;
    });
  }
  function refund(reservations) {
    return serial(async () => {
      const saved = await throttleRead();
      for (const entry of reservations) {
        const value = saved.buckets[entry.name];
        if (value?.until === entry.until) { value.count -= 1; if (value.count <= 0) delete saved.buckets[entry.name]; }
      }
      await atomicAuthWrite(throttleFile, saved);
    });
  }

  async function session(token, { touch = true } = {}) {
    const value = sessions.get(token);
    if (!value) return null;
    const fresh = await state(value.username);
    if (!fresh.ready || fresh.current.credentialVersion !== value.credentialVersion || value.expiresAt <= now() || value.lastSeen + idleMs <= now()) { sessions.delete(token); return null; }
    if (touch) value.lastSeen = now();
    return { ...value, token };
  }
  async function issue(current, ip, oldToken) {
    const fresh = await state(current.username);
    if (!fresh.ready || fresh.current.credentialVersion !== current.credentialVersion) throw invalid();
    for (const [key, value] of sessions) if (value.expiresAt <= now() || value.lastSeen + idleMs <= now()) sessions.delete(key);
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
    if (oldToken) sessions.delete(oldToken);
    const token = randomBytes(32).toString('hex'); const csrfToken = randomBytes(32).toString('hex');
    sessions.set(token, { csrfToken, username: current.username, credentialVersion: current.credentialVersion, expiresAt: now() + sessionMs, lastSeen: now() });
    await audit('login.succeeded', ip, { username: current.username });
    return { authenticated: true, token, csrfToken };
  }

  async function login({ username, password }, ip, oldToken) {
    let normalizedUsername;
    try { normalizedUsername = normalizeUsername(username); } catch { normalizedUsername = null; }
    const fresh = await state(normalizedUsername);
    if (!fresh.ready && !fresh.enrollmentAvailable) throw fresh.current ? unavailable() : new AuthError(503, 'Вход администратора не настроен.', 'not_configured');
    const reservation = await reserve(ip, 'password');
    const current = fresh.current;
    // Always evaluate the password for syntactically valid input, even for an unknown username.
    const validInput = typeof password === 'string' && password.length > 0 && password.length <= 1024 && normalizedUsername !== null;
    const validPassword = validInput && await verifyPassword(password, current.password);
    if (!validPassword || !equalSecret(normalizedUsername, current.username) || (current.initialExpiresAt && current.initialExpiresAt <= now())) { await audit('login.failed', ip); throw invalid(); }
    await refund(reservation);
    for (const [token, value] of challenges) if (value.expiresAt <= now()) challenges.delete(token);
    if (challenges.size >= 100) challenges.delete(challenges.keys().next().value);
    const challengeToken = randomBytes(32).toString('hex');
    if (!current.totp) {
      const requiresNewPassword = current.temporaryPassword === true || password.length < 15;
      const passwordRecord = requiresNewPassword ? null : current.password.version === 2 ? current.password : await makePasswordRecord(password);
      remember(challenges, challengeToken, { type: 'enrollment', credentialVersion: current.credentialVersion, ip, expiresAt: now() + CHALLENGE_MS, attempts: 0, requiresNewPassword, passwordRecord, username: current.username, secondary: current.secondary === true });
      await audit('enrollment.authorized', ip);
      return { enrollmentRequired: true, challengeToken, username: current.username, requiresNewPassword };
    }
    remember(challenges, challengeToken, { type: 'mfa', username: current.username, credentialVersion: current.credentialVersion, ip, expiresAt: now() + CHALLENGE_MS, attempts: 0, oldToken });
    await audit('login.mfa_requested', ip);
    return { mfaRequired: true, challengeToken };
  }

  async function verify({ challengeToken, code }, ip, deviceToken) {
    const initial = typeof challengeToken === 'string' ? challenges.get(challengeToken) : null;
    // Unknown tokens cannot consume the budget reserved for someone who knows the password.
    if (!initial || initial.type !== 'mfa' || initial.ip !== ip || initial.expiresAt <= now() || initial.attempts >= 5) {
      if (initial && initial.ip === ip) challenges.delete(challengeToken);
      throw new AuthError(410, 'Время подтверждения истекло. Начните вход заново.', 'challenge_expired');
    }
    const reservation = await reserve(ip, 'otp');
    const result = await serial(() => withAccountLock(dataDir, async () => {
      const challenge = typeof challengeToken === 'string' ? challenges.get(challengeToken) : null;
      const fresh = await state(challenge?.username);
      if (!challenge || challenge.type !== 'mfa' || challenge.ip !== ip || challenge.expiresAt <= now() || challenge.attempts >= 5 || !fresh.ready || challenge.credentialVersion !== fresh.current?.credentialVersion || !fresh.current.totp) {
        if (challengeToken) challenges.delete(challengeToken);
        await audit('mfa.failed', ip); throw new AuthError(410, 'Время подтверждения истекло. Начните вход заново.', 'challenge_expired');
      }
      challenge.attempts += 1;
      const device = challenge.deviceHash ? await trustedDevice(deviceToken) : null;
      if (challenge.deviceHash && (!device || !equalSecret(challenge.deviceHash, typeof deviceToken === 'string' ? hash(deviceToken) : '') || device.username !== fresh.current.username)) {
        challenges.delete(challengeToken); throw new AuthError(401, 'Войдите с паролем.', 'device_expired');
      }
      const current = fresh.current;
      let method = 'totp';
      const normalized = typeof code === 'string' && code.length <= 100 ? code.trim() : '';
      const secret = decryptTotp(current.totp.encrypted, await getEncryptionKey({ dataDir, production, encryptionKey }));
      const counter = verifyTotp(secret, normalized, { time: now(), lastCounter: current.totp.lastCounter });
      if (counter !== null) current.totp.lastCounter = counter;
      else {
        const index = !challenge.deviceHash && /^[a-fA-F0-9 -]{32,47}$/.test(normalized) ? current.recovery.findIndex((value) => equalSecret(value, recoveryHash(normalized))) : -1;
        if (index < 0) {
          if (challenge.attempts >= 5) {
            challenges.delete(challengeToken);
            await audit('mfa.failed', ip); throw new AuthError(410, 'Начните вход заново.', 'challenge_expired');
          }
          await audit('mfa.failed', ip); throw new AuthError(401, 'Код не принят. Начните вход заново или повторите код.', 'invalid_code');
        }
        current.recovery.splice(index, 1); method = 'recovery';
      }
      await saveAccount(current);
      challenges.delete(challengeToken);
      await audit('mfa.succeeded', ip, { method });
      const deviceResult = method === 'totp'
        ? await rememberDevice(current, deviceToken, device?.expiresAt) : {};
      return { current, oldToken: challenge.oldToken, deviceResult };
    }));
    await refund(reservation);
    return { ...await issue(result.current, ip, result.oldToken), ...result.deviceResult };
  }

  const expired = () => new AuthError(410, 'Время настройки истекло. Начните вход заново.', 'challenge_expired');
  function pendingEntry(map, token, ip) {
    const entry = typeof token === 'string' ? map.get(token) : null;
    if (!entry || entry.ip !== ip || entry.expiresAt <= now() || entry.attempts >= 5) {
      if (entry?.ip === ip) map.delete(token);
      throw expired();
    }
    return entry;
  }

  async function enrollmentStart({ challengeToken, username, password }, ip) {
    const challenge = pendingEntry(challenges, challengeToken, ip);
    if (challenge.type !== 'enrollment') throw expired();
    let normalizedUsername;
    try { normalizedUsername = normalizeUsername(username); } catch { throw new AuthError(400, 'Укажите корректную почту или логин.', 'invalid_username'); }
    if ((challenge.requiresNewPassword || password !== undefined) && (typeof password !== 'string' || password.length < 15 || password.length > 1024)) throw new AuthError(400, 'Новый пароль должен содержать от 15 до 1024 символов.', 'invalid_password');
    const fresh = await state(challenge.username);
    if (!fresh.enrollmentAvailable || fresh.current.credentialVersion !== challenge.credentialVersion) throw expired();
    if (fresh.current.temporaryPassword && await verifyPassword(password, fresh.current.password)) throw new AuthError(400, 'Задайте свой пароль, отличный от временного.', 'invalid_password');
    if (challenge.secondary && normalizedUsername !== challenge.username) throw new AuthError(400, 'Для этой учётной записи нельзя изменить почту.', 'invalid_username');
    if (!challenge.secondary && await optionalJson(additionalAccountFile(dataDir, normalizedUsername))) throw new AuthError(400, 'Эта почта уже используется.', 'invalid_username');
    const reservation = await reserve(ip, 'enrollment');
    const passwordRecord = password === undefined ? challenge.passwordRecord : await makePasswordRecord(password);
    // Re-check after hashing: cancellation or another start must win over this pending work.
    if (pendingEntry(challenges, challengeToken, ip) !== challenge) throw expired();
    const secret = createTotpSecret();
    const enrollmentToken = randomBytes(32).toString('hex');
    for (const [token, value] of enrollments) if (value.expiresAt <= now()) enrollments.delete(token);
    if (enrollments.size >= 100) enrollments.delete(enrollments.keys().next().value);
    remember(enrollments, enrollmentToken, { credentialVersion: challenge.credentialVersion, ip, expiresAt: now() + CHALLENGE_MS, attempts: 0, username: normalizedUsername, accountUsername: challenge.username, secondary: challenge.secondary, passwordRecord, secret });
    challenges.delete(challengeToken);
    await refund(reservation);
    await audit('enrollment.started', ip);
    const otpauthUri = `otpauth://totp/${encodeURIComponent(`Восемь утра:${normalizedUsername}`)}?secret=${secret}&issuer=${encodeURIComponent('Восемь утра')}&algorithm=SHA1&digits=6&period=30`;
    return { enrollmentToken, otpauthUri, secret, expiresIn: CHALLENGE_MS / 1000 };
  }

  async function enrollmentConfirm({ enrollmentToken, code }, ip) {
    pendingEntry(enrollments, enrollmentToken, ip);
    const reservation = await reserve(ip, 'otp');
    const result = await serial(() => withAccountLock(dataDir, async () => {
      const enrollment = pendingEntry(enrollments, enrollmentToken, ip);
      const fresh = await state(enrollment.accountUsername);
      if (!fresh.enrollmentAvailable || fresh.current.credentialVersion !== enrollment.credentialVersion) { enrollments.delete(enrollmentToken); throw expired(); }
      enrollment.attempts += 1;
      const counter = verifyTotp(enrollment.secret, typeof code === 'string' ? code.trim() : '', { time: now() });
      if (counter === null) {
        await audit('enrollment.failed', ip);
        if (enrollment.attempts >= 5) { enrollments.delete(enrollmentToken); throw expired(); }
        throw new AuthError(401, 'Код не принят. Проверьте код в приложении.', 'invalid_code');
      }
      const key = await getEncryptionKey({ dataDir, production, encryptionKey, create: !production });
      const recoveryCodes = createRecoveryCodes();
      const current = { version: 2, username: enrollment.username, credentialVersion: randomUUID(), password: enrollment.passwordRecord, totp: { encrypted: encryptTotp(enrollment.secret, key), lastCounter: counter }, recovery: recoveryCodes.map(recoveryHash) };
      if (enrollment.secondary) current.secondary = true;
      else if (await optionalJson(additionalAccountFile(dataDir, current.username))) throw new AuthError(400, 'Эта почта уже используется.', 'invalid_username');
      await saveAccount(current);
      if (!enrollment.secondary) await unlink(legacyFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      for (const map of [sessions, challenges, enrollments]) for (const [token, pending] of map) if (pending.credentialVersion === enrollment.credentialVersion) map.delete(token);
      await audit('credentials.mfa_enrolled', ip, { username: current.username });
      const deviceResult = await rememberDevice(current);
      return { current, recoveryCodes, deviceResult };
    }));
    await refund(reservation);
    return { ...await issue(result.current, ip), ...result.deviceResult, recoveryCodes: result.recoveryCodes };
  }

  function enrollmentCancel({ challengeToken, enrollmentToken }, ip) {
    // Serialize with confirmation: a completed confirmation wins; earlier cancellation prevents it.
    return serial(async () => {
      const challenge = challenges.get(challengeToken);
      if (challenge?.type === 'enrollment' && challenge.ip === ip) challenges.delete(challengeToken);
      if (enrollments.get(enrollmentToken)?.ip === ip) enrollments.delete(enrollmentToken);
      return { cancelled: true };
    });
  }

  return {
    production, sessionMs, audit, session, login, verify, enrollmentStart, enrollmentConfirm, enrollmentCancel, resume, forgetDevice,
    async status(token, deviceToken) {
      const currentSession = await session(token);
      if (currentSession) return { authenticated: true, csrfToken: currentSession.csrfToken };
      const fresh = await state();
      const device = await trustedDevice(deviceToken);
      return { authenticated: false, configured: Boolean(fresh.current), mfaRequired: production || Boolean(fresh.current), production, ready: fresh.ready, enrollmentAvailable: fresh.enrollmentAvailable, ...(device ? { trustedUsername: device.username } : {}) };
    },
    async logout(token, ip) { sessions.delete(token); await audit('logout', ip); },
  };
}
