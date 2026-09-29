const $ = (id) => document.getElementById(id);
const categories = {
  signature: 'Фирменные завтраки',
  eggs: 'Яйца и тосты',
  porridge: 'Каши и гранола',
  sweet: 'Сладкое утро',
};
const currency = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 });
const state = { items: [], revision: null, csrfToken: '', busy: false, loaded: false, conflict: false };
// Authentication challenges and entered codes live only in this page's memory.
const auth = { challengeToken: '', recovery: false, busy: false, setupRequired: false, production: false, mfaRequired: false,
  enrollmentAvailable: false, enrollmentToken: '', enrollmentPhase: '', enrollmentTimer: null, generation: 0,
  requiresNewPassword: false, recoveryPending: false, trustedUsername: '', logoutPending: false };
const draft = { id: null, isNew: true, image: '', file: null, previewUrl: '', dirty: false, resume: false };
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const ACTIVITY_THROTTLE_MS = 30 * 1000;
const idle = { active: false, generation: 0, deadline: 0, absoluteDeadline: 0, timeoutMs: IDLE_TIMEOUT_MS,
  lastActivity: 0, lastSent: -Infinity, lastAcknowledged: 0, activityTimer: null, timer: null, pending: false,
  username: '', requests: new Set(), suspended: false, dashboardWasVisible: false };
const timingObservedAt = new WeakMap();
let remoteLogoutTimer = null;
const LOCK_STORAGE_KEY = 'vosem-utra-admin-locked';
let pendingLogoutWake = null;
const wallClockOrigin = Date.now();
const monotonicOrigin = globalThis.performance?.now();
// Wall time catches a sleeping laptop; monotonic time also handles a clock moved backwards.
function sessionNow() {
  return Math.max(Date.now(), wallClockOrigin + (monotonicOrigin === undefined ? 0 : globalThis.performance.now() - monotonicOrigin));
}
function readLockMarker() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(LOCK_STORAGE_KEY) || 'null');
    return value && Number.isFinite(value.at) && Number.isFinite(value.pendingUntil) ? value : null;
  } catch { return null; }
}
function rememberLocked(forgetDevice, pending = false) {
  try {
    globalThis.localStorage?.setItem(LOCK_STORAGE_KEY, JSON.stringify({ at: Date.now(), forgetDevice,
      pendingUntil: pending ? Date.now() + 25000 : 0 }));
  } catch { /* Private browsing can disable storage; this tab still fails closed. */ }
}
function finishRememberedLogout() {
  const marker = readLockMarker();
  if (marker) rememberLocked(marker.forgetDevice === true);
  pendingLogoutWake?.();
}
function clearLockMarker() {
  try { globalThis.localStorage?.removeItem(LOCK_STORAGE_KEY); } catch { /* Optional local marker, never a credential. */ }
}
async function waitForPendingLogout() {
  const marker = readLockMarker();
  if (!marker || marker.pendingUntil <= Date.now()) return;
  setAuthBusy(true);
  await new Promise((resolve) => {
    const timer = setTimeout(done, Math.min(25000, marker.pendingUntil - Date.now()));
    function done() { clearTimeout(timer); pendingLogoutWake = null; resolve(); }
    pendingLogoutWake = done;
  });
  setAuthBusy(false);
}
let authChannel = null;
try { if (typeof BroadcastChannel === 'function') authChannel = new BroadcastChannel('vosem-utra-admin-session'); } catch { /* Optional, never required for locking. */ }
let deleteId = null;
const passwordFields = [
  ['password', 'пароль'],
  ['enrollment-password', 'новый пароль'],
  ['enrollment-password-confirm', 'повтор пароля'],
];

function setPasswordVisible(id, label, visible) {
  $(id).type = visible ? 'text' : 'password';
  const button = $(`${id}-toggle`);
  const action = `${visible ? 'Скрыть' : 'Показать'} ${label}`;
  button.setAttribute('aria-pressed', String(visible));
  button.setAttribute('aria-label', action);
  button.setAttribute('title', action);
}

function hidePasswords() {
  for (const [id, label] of passwordFields) setPasswordVisible(id, label, false);
}

for (const [id, label] of passwordFields) {
  $(`${id}-toggle`).addEventListener('click', () => {
    if (auth.busy || auth.setupRequired) return;
    setPasswordVisible(id, label, $(id).type === 'password');
  });
}

// Match the server's email/legacy-login rules without type=email rejecting old logins.
function validUsername(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const username = value.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(username)) return true;
  if (username.length > 254) return false;
  const parts = username.split('@');
  if (parts.length !== 2 || parts[0].length > 64) return false;
  const local = /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
  const domain = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return local.test(parts[0]) && domain.test(parts[1]);
}

class ApiError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function stopIdleSession() {
  idle.active = false;
  idle.generation += 1;
  clearTimeout(idle.timer);
  clearTimeout(idle.activityTimer);
  idle.timer = idle.activityTimer = null;
  idle.pending = false;
  for (const controller of idle.requests) controller.abort();
  idle.requests.clear();
}

function broadcastAuth(message) {
  try { authChannel?.postMessage(message); } catch { /* Local timeout still works without other tabs. */ }
}

function scheduleIdleLock() {
  clearTimeout(idle.timer);
  if (!idle.active) return;
  const remaining = Math.min(idle.deadline, idle.absoluteDeadline) - sessionNow();
  if (remaining <= 0) {
    if (document.visibilityState === 'hidden' || remaining < -1000) {
      suspendProtectedUi();
      void checkVisibleSession();
    } else void lockSession({ reason: sessionNow() >= idle.absoluteDeadline ? 'expired' : 'idle' });
    return;
  }
  idle.timer = setTimeout(() => { if (idle.active) scheduleIdleLock(); }, remaining);
}

function acceptSessionTiming(data, { initial = false, activity = false } = {}) {
  const timing = data?.session;
  if (!timing || !['idleTimeoutMs', 'idleExpiresAt', 'expiresAt', 'serverNow'].every((key) => Number.isFinite(timing[key]))
    || timing.idleTimeoutMs <= 0 || timing.idleTimeoutMs > IDLE_TIMEOUT_MS
    || timing.idleExpiresAt <= timing.serverNow || timing.expiresAt <= timing.serverNow) {
    throw new ApiError('Не удалось подтвердить срок защищённой сессии. Войдите снова.', 401, 'invalid_session_timing');
  }
  const now = timingObservedAt.get(data) ?? sessionNow();
  if (initial) {
    stopIdleSession();
    idle.active = true;
    idle.username = validUsername(data.username) ? data.username : $('username').value.trim();
    idle.lastActivity = now - Math.max(0, timing.idleTimeoutMs - (timing.idleExpiresAt - timing.serverNow));
    idle.lastAcknowledged = idle.lastActivity;
    idle.lastSent = -Infinity;
    idle.suspended = false;
  }
  if (!idle.active) return;
  idle.timeoutMs = timing.idleTimeoutMs;
  const absolute = now + timing.expiresAt - timing.serverNow;
  idle.absoluteDeadline = initial ? absolute : Math.min(idle.absoluteDeadline, absolute);
  // The server acknowledgement never extends the UI past 15 minutes of real activity.
  idle.deadline = Math.min(now + timing.idleExpiresAt - timing.serverNow, idle.lastActivity + idle.timeoutMs, idle.absoluteDeadline);
  if (idle.deadline <= sessionNow()) {
    if (initial) stopIdleSession();
    throw new ApiError('Сессия завершилась. Войдите снова.', 401, 'invalid_session_timing');
  }
  scheduleIdleLock();
  if (activity && idle.active) broadcastAuth({ type: 'activity', username: idle.username, deadline: idle.deadline });
}

function showLockedIdentity(username, note = '') {
  if (typeof username === 'string' && validUsername(username)) {
    auth.setupRequired = false;
    showVerification('', username);
    $('verification-code').focus();
  } else $('password').focus();
  message($('session-lock-note'), note);
}

async function lockSession({ reason = 'idle', forgetDevice = false, remote = false, pending = false, persist = !remote } = {}) {
  if (!state.csrfToken && !idle.active && reason === 'idle') return;
  // Capture before showLogin clears it. Requests already in flight cannot reopen protected UI.
  const csrfToken = state.csrfToken;
  const username = idle.username || auth.trustedUsername || $('username').value.trim();
  draft.resume = draft.resume || $('editor-dialog').open;
  $('editor-dialog').close();
  $('delete-dialog').close();
  deleteId = null;
  showLogin();
  if (persist) rememberLocked(forgetDevice, !remote);
  if (!remote || pending) auth.logoutPending = true;
  if (remote && pending) {
    clearTimeout(remoteLogoutTimer);
    remoteLogoutTimer = setTimeout(() => { auth.logoutPending = false; setAuthBusy(false); }, 25000);
  }
  setBusy(false);
  setAuthBusy(false);
  const note = reason === 'idle'
    ? `Панель закрыта после 15 минут без действий.${draft.resume ? ' Черновик сохранён в этой вкладке.' : ''}`
    : reason === 'expired' ? `Сессия завершилась.${draft.resume ? ' Черновик сохранён в этой вкладке.' : ''}`
      : `Вы вышли из панели.${draft.resume ? ' Черновик сохранён в этой вкладке.' : ''}`;
  if (forgetDevice) { idle.username = ''; $('username').value = ''; }
  showLockedIdentity(forgetDevice ? '' : username, note);
  if (!remote) broadcastAuth({ type: 'lock', forgetDevice, pending: true });
  const generation = idle.generation;
  const authGeneration = auth.generation;
  try {
    const result = remote ? null : await api('logout', { method: 'POST', body: { forgetDevice }, csrfToken, allowAfterLock: true });
    if (generation !== idle.generation || authGeneration !== auth.generation) return;
    if (result) {
      if (!forgetDevice && validUsername(result.trustedUsername)) showLockedIdentity(result.trustedUsername, note);
      else { showLogin(); if (forgetDevice) $('username').value = ''; message($('session-lock-note'), note); }
    }
  } catch {
    // Fail closed even offline. No automatic re-entry based on an old session response.
    if (generation === idle.generation) message($('session-lock-note'), `${note} Для нового входа понадобится соединение с сервером.`);
  } finally {
    if (!remote) {
      auth.logoutPending = false;
      finishRememberedLogout();
      setAuthBusy(false);
      broadcastAuth({ type: 'logout-complete' });
    }
  }
}

async function sendActivity() {
  idle.activityTimer = null;
  if (!idle.active || idle.pending || idle.lastActivity <= idle.lastAcknowledged) return;
  if (sessionNow() >= idle.deadline || sessionNow() >= idle.absoluteDeadline) { suspendProtectedUi(); void checkVisibleSession(); return; }
  const generation = idle.generation;
  const activityAt = idle.lastActivity;
  idle.pending = true;
  idle.lastSent = sessionNow();
  try {
    const data = await api('activity', { method: 'POST', body: {} });
    if (generation !== idle.generation || !idle.active) return;
    if (data.authenticated !== true) throw new ApiError('Сессия завершилась.', 401);
    idle.lastAcknowledged = activityAt;
    acceptSessionTiming(data, { activity: true });
  } catch (error) {
    if (generation !== idle.generation) return;
    if (error.status === 401 || error.status === 403) {
      // Another tab may have completed fresh MFA and replaced our CSRF token.
      // Hide this view, but never revoke that newer shared-cookie session blindly.
      suspendProtectedUi();
      await checkVisibleSession();
    }
    // No retries or keepalive while idle. The last confirmed deadline still locks offline.
  } finally {
    if (generation === idle.generation) {
      idle.pending = false;
      if (idle.active && idle.lastActivity > activityAt && !idle.activityTimer) {
        idle.activityTimer = setTimeout(sendActivity, Math.max(0, ACTIVITY_THROTTLE_MS - (sessionNow() - idle.lastSent)));
      }
    }
  }
}

function recordActivity(event) {
  if (!event.isTrusted || document.visibilityState === 'hidden' || !idle.active) return;
  if (idle.suspended) { void checkVisibleSession(); return; }
  const now = sessionNow();
  if (now >= idle.deadline || now >= idle.absoluteDeadline) { suspendProtectedUi(); void checkVisibleSession(); return; }
  idle.lastActivity = now;
  if (idle.pending || idle.activityTimer) return;
  const wait = Math.min(Math.max(0, ACTIVITY_THROTTLE_MS - (now - idle.lastSent)), Math.max(0, idle.deadline - now - 1000));
  if (!wait) void sendActivity();
  else idle.activityTimer = setTimeout(sendActivity, wait);
}

async function api(path, { method = 'GET', body, raw = false, csrfToken = state.csrfToken, allowAfterLock = false } = {}) {
  const startedAt = sessionNow();
  const controller = new AbortController();
  const generation = idle.generation;
  const protectedRequest = Boolean(csrfToken) && !allowAfterLock;
  if (protectedRequest) idle.requests.add(controller);
  const timeout = setTimeout(() => controller.abort(), 20000);
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = raw ? body.type : 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  try {
    const response = await fetch(`/api/admin/${path}`, {
      method, headers, credentials: 'same-origin', cache: 'no-store',
      signal: controller.signal, body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const isJson = response.headers.get('content-type')?.includes('application/json');
    if (!isJson) throw new ApiError('Сервер управления меню недоступен. Статическая версия сайта не сохраняет изменения. Откройте панель на сервере с настроенным доступом администратора.', response.status);
    const data = await response.json();
    if (data && typeof data === 'object') timingObservedAt.set(data, startedAt);
    if (protectedRequest && generation !== idle.generation) throw new ApiError('Сессия закрыта. Черновик сохранён в этой вкладке.', 401, 'client_locked');
    if (!response.ok) {
      const detail = typeof data.error === 'string' ? data.error : data.error?.message || data.message;
      throw new ApiError(detail || `Не удалось выполнить запрос (${response.status}). Попробуйте ещё раз.`, response.status, data.code || data.error?.code || '');
    }
    return data;
  } catch (error) {
    if (protectedRequest && generation !== idle.generation) throw new ApiError('Сессия закрыта. Черновик сохранён в этой вкладке.', 401, 'client_locked');
    if (error instanceof ApiError) throw error;
    throw new ApiError(error.name === 'AbortError'
      ? 'Сервер не ответил вовремя. Проверьте подключение и попробуйте ещё раз.'
      : 'Не удалось связаться с сервером меню. Проверьте подключение и повторите попытку.');
  } finally {
    idle.requests.delete(controller);
    clearTimeout(timeout);
  }
}

function message(element, text) {
  element.textContent = text;
  element.hidden = !text;
}

function notice(text, { error = false, refresh = false } = {}) {
  $('dashboard-notice').hidden = !text;
  $('dashboard-notice').classList.toggle('is-error', error);
  $('dashboard-message').textContent = text;
  $('retry-load').hidden = !refresh;
}

function setBusy(busy) {
  state.busy = busy;
  $('dashboard').setAttribute('aria-busy', String(busy));
  $('item-form').setAttribute('aria-busy', String(busy));
  $('editor-fields').disabled = busy;
  for (const id of ['logout', 'logout-forget', 'add-item', 'refresh', 'retry-load', 'close-editor', 'cancel-editor', 'refresh-draft', 'cancel-delete', 'confirm-delete']) $(id).disabled = busy;
  $('save-item').disabled = busy || state.conflict || !state.loaded;
  $('save-item').textContent = busy ? 'Сохраняем…' : 'Сохранить блюдо';
  document.querySelectorAll('[data-item-action]').forEach((button) => { button.disabled = busy || state.conflict || !state.loaded; });
}

function setAuthBusy(busy) {
  busy = busy || auth.logoutPending;
  auth.busy = busy;
  if (busy) hidePasswords();
  for (const id of ['username', 'password', 'password-toggle', 'enrollment-password-toggle', 'enrollment-password-confirm-toggle', 'login-submit', 'verification-code', 'verify-submit', 'code-mode', 'auth-back', 'check-setup',
    'enrollment-username', 'enrollment-password', 'enrollment-password-confirm', 'enrollment-start', 'enrollment-back',
    'enrollment-code', 'enrollment-confirm', 'enrollment-cancel', 'saved-recovery-codes', 'recovery-logout', 'auth-forget-device']) {
    $(id).disabled = busy || (auth.setupRequired && id !== 'check-setup');
  }
  for (const id of ['login-form', 'verify-form', 'enrollment-form', 'enrollment-verify-form', 'enrollment-recovery-form']) $(id).setAttribute('aria-busy', String(busy));
  $('login-submit').textContent = busy ? 'Проверяем…' : 'Продолжить ↗';
  $('verify-submit').textContent = busy ? 'Проверяем…' : 'Подтвердить вход ↗';
  $('enrollment-start').textContent = busy ? 'Готовим…' : 'Показать QR-код ↗';
  $('enrollment-confirm').textContent = busy ? 'Проверяем…' : 'Подтвердить подключение ↗';
  $('enrollment-continue').disabled = busy || !auth.recoveryPending || !$('saved-recovery-codes').checked;
}

function setCodeMode(recovery) {
  auth.recovery = recovery;
  const input = $('verification-code');
  input.value = '';
  input.inputMode = recovery ? 'text' : 'numeric';
  input.autocomplete = recovery ? 'off' : 'one-time-code';
  input.maxLength = recovery ? 100 : 6;
  input.minLength = recovery ? 1 : 6;
  input.toggleAttribute('data-recovery', recovery);
  input.removeAttribute('aria-invalid');
  if (recovery) input.removeAttribute('pattern');
  else input.setAttribute('pattern', '[0-9]{6}');
  $('verification-label').textContent = recovery ? 'Резервный код' : 'Код из Яндекс ID (Ключ)';
  $('verification-help').textContent = recovery
    ? 'Введите один из сохранённых резервных кодов. Каждый код можно использовать только один раз.'
    : 'В Яндекс ID (Ключ) выберите «Восемь утра» и введите 6 цифр. Код можно вставить целиком.';
  $('code-mode').textContent = recovery ? 'Использовать код из Яндекс ID (Ключ)' : 'Использовать резервный код';
  message($('verification-error'), '');
}

function clearEnrollment() {
  hidePasswords();
  auth.generation += 1;
  clearTimeout(auth.enrollmentTimer);
  auth.enrollmentTimer = null;
  auth.enrollmentToken = '';
  auth.enrollmentPhase = '';
  auth.requiresNewPassword = false;
  auth.recoveryPending = false;
  $('enrollment-qr-image').removeAttribute('src');
  $('enrollment-secret').textContent = '';
  $('enrollment-manual').open = false;
  $('enrollment-expires').textContent = '';
  for (const id of ['enrollment-username', 'enrollment-password', 'enrollment-password-confirm', 'enrollment-code']) $(id).value = '';
  $('enrollment-code').removeAttribute('aria-invalid');
  $('enrollment-recovery-codes').replaceChildren();
  $('saved-recovery-codes').checked = false;
  for (const id of ['enrollment-form', 'enrollment-verify-form', 'enrollment-recovery-form']) $(id).hidden = true;
  for (const id of ['enrollment-error', 'enrollment-verify-error', 'recovery-error']) message($(id), '');
}

function clearChallenge() {
  clearEnrollment();
  auth.trustedUsername = '';
  auth.challengeToken = '';
  $('password').value = '';
  setCodeMode(false);
  $('verify-form').hidden = true;
}

function showLogin(error = '') {
  stopIdleSession();
  clearChallenge();
  state.csrfToken = '';
  state.loaded = false;
  $('dashboard').hidden = true;
  $('logout').hidden = true;
  $('signout-actions').hidden = true;
  $('connection-status').hidden = true;
  $('login-panel').hidden = false;
  $('login-form').hidden = auth.setupRequired;
  $('auth-setup').hidden = !auth.setupRequired;
  $('auth-heading').textContent = auth.setupRequired ? 'Настроим доступ' : 'Рады видеть вас';
  $('auth-description').textContent = auth.setupRequired
    ? 'Для работы с меню нужен защищённый аккаунт администратора.'
    : 'Войдите, чтобы добавлять блюда, обновлять фотографии и цены.';
  message($('login-error'), error);
  message($('session-lock-note'), '');
  setAuthBusy(auth.busy);
}

function showVerification(challengeToken, trustedUsername = '') {
  clearChallenge();
  auth.challengeToken = challengeToken;
  auth.trustedUsername = trustedUsername;
  $('login-form').hidden = true;
  $('auth-setup').hidden = true;
  $('verify-form').hidden = false;
  $('auth-heading').textContent = 'Подтвердите, что это вы';
  $('auth-description').textContent = 'Остался ещё один шаг: код для «Восемь утра» из Яндекс ID (Ключ) или резервный код.';
  $('code-mode').hidden = Boolean(trustedUsername);
  $('auth-forget-device').hidden = !trustedUsername;
  $('auth-back').textContent = trustedUsername ? 'Войти с паролем / другой аккаунт' : '← К почте и паролю';
  if (trustedUsername) {
    $('username').value = trustedUsername;
    $('auth-heading').textContent = 'С возвращением';
    $('auth-description').textContent = `${trustedUsername} · Устройство знакомо. Введите код из приложения, чтобы продолжить.`;
  }
  message($('login-error'), '');
}

function showEnrollment(data) {
  clearChallenge();
  auth.challengeToken = data.challengeToken;
  auth.enrollmentPhase = 'details';
  auth.requiresNewPassword = data.requiresNewPassword === true;
  auth.setupRequired = false;
  $('login-form').hidden = true;
  $('auth-setup').hidden = true;
  $('enrollment-form').hidden = false;
  // This preset appears only after the server has verified the existing password.
  $('enrollment-username').value = data.username?.includes('@') ? data.username : 'v.utra@yandex.ru';
  $('enrollment-password').required = auth.requiresNewPassword;
  $('enrollment-password-confirm').required = auth.requiresNewPassword;
  $('enrollment-password-option').textContent = auth.requiresNewPassword ? 'обязательно' : 'необязательно';
  $('enrollment-password-help').textContent = auth.requiresNewPassword
    ? 'Для защищённого входа задайте новый пароль — от 8 до 1024 символов.'
    : 'Можно оставить текущий пароль или задать новый — не менее 8 символов.';
  $('auth-heading').textContent = 'Подключим Яндекс ID (Ключ)';
  $('auth-description').textContent = 'Это первая настройка. Добавим вход по коду с телефона — в следующий раз QR-код уже не понадобится.';
  message($('login-error'), '');
}

function expireEnrollment() {
  if (!auth.enrollmentToken) return;
  // Let an already submitted verification finish; the server checks expiry itself.
  if (auth.busy) { auth.enrollmentTimer = setTimeout(expireEnrollment, 1000); return; }
  showLogin('Время настройки истекло. Войдите снова, чтобы получить новый QR-код.');
  $('password').focus();
}

async function showEnrollmentQr(data, generation = auth.generation) {
  if (typeof data.enrollmentToken !== 'string' || !data.enrollmentToken
    || typeof data.secret !== 'string' || !/^[A-Z2-7]{16,128}$/.test(data.secret)
    || !Number.isFinite(data.expiresIn) || data.expiresIn <= 0 || data.expiresIn > 300) {
    throw new ApiError('Не удалось подготовить QR-код. Начните вход заново.', 500);
  }
  let qrDataUrl = data.qrDataUrl;
  if (qrDataUrl === undefined || qrDataUrl === null) {
    let uri;
    try { uri = new URL(data.otpauthUri); } catch { /* Rejected below. */ }
    if (typeof data.otpauthUri !== 'string' || data.otpauthUri.length > 4096 || !uri
      || uri.protocol !== 'otpauth:' || uri.hostname !== 'totp' || uri.username || uri.password || uri.hash || uri.pathname.length < 2
      || uri.searchParams.getAll('secret').length !== 1 || uri.searchParams.get('secret') !== data.secret
      || !['', 'SHA1'].includes((uri.searchParams.get('algorithm') || '').toUpperCase())
      || !['', '6'].includes(uri.searchParams.get('digits') || '') || !['', '30'].includes(uri.searchParams.get('period') || '')) {
      throw new ApiError('Не удалось подготовить QR-код. Начните вход заново.', 500);
    }
    // Vite bundles this installed package into a local chunk; no QR service sees the secret.
    try {
      const module = await import('qrcode');
      if (generation !== auth.generation) return;
      qrDataUrl = await (module.default || module).toDataURL(data.otpauthUri, {
        type: 'image/png', width: 320, margin: 4, errorCorrectionLevel: 'M',
        color: { dark: '#000000FF', light: '#FFFFFFFF' },
      });
    } catch {
      throw new ApiError('Не удалось создать QR-код в браузере. Начните вход заново.', 500);
    }
  }
  if (generation !== auth.generation) return;
  if (typeof qrDataUrl !== 'string' || qrDataUrl.length > 200000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(qrDataUrl)) {
    throw new ApiError('Не удалось подготовить QR-код. Начните вход заново.', 500);
  }
  auth.enrollmentToken = data.enrollmentToken;
  auth.enrollmentPhase = 'qr';
  $('enrollment-form').hidden = true;
  $('enrollment-verify-form').hidden = false;
  $('enrollment-qr-image').setAttribute('src', qrDataUrl);
  $('enrollment-secret').textContent = data.secret;
  $('enrollment-expires').textContent = `QR-код действует ${Math.ceil(data.expiresIn / 60)} мин. Затем понадобится начать вход заново.`;
  $('auth-heading').textContent = 'Добавьте «Восемь утра»';
  $('auth-description').textContent = 'Отсканируйте QR-код приложением Яндекс ID (Ключ) на своём телефоне.';
  clearTimeout(auth.enrollmentTimer);
  auth.enrollmentTimer = setTimeout(expireEnrollment, data.expiresIn * 1000);
}

function showRecoveryCodes(data) {
  if (data.authenticated !== true || typeof data.csrfToken !== 'string' || !data.csrfToken
    || !Array.isArray(data.recoveryCodes) || !data.recoveryCodes.length || data.recoveryCodes.length > 20
    || data.recoveryCodes.some((code) => typeof code !== 'string' || !/^[a-fA-F0-9-]{32,47}$/.test(code))) {
    throw new ApiError('Не удалось получить резервные коды. Начните вход заново или обратитесь к администратору сервера.', 500);
  }
  const username = $('enrollment-username').value.trim();
  clearChallenge();
  acceptSessionTiming(data, { initial: true });
  clearLockMarker();
  state.csrfToken = data.csrfToken;
  auth.recoveryPending = true;
  auth.enrollmentPhase = 'recovery';
  auth.enrollmentAvailable = false;
  auth.mfaRequired = true;
  $('username').value = username;
  $('enrollment-recovery-form').hidden = false;
  $('auth-heading').textContent = 'Сохраните резервные коды';
  $('auth-description').textContent = 'Код подтверждён, вход с телефона подключён. Осталось сохранить запасной способ входа.';
  $('enrollment-recovery-codes').replaceChildren(...data.recoveryCodes.map((code) => {
    const row = element('li');
    row.append(element('code', '', code));
    return row;
  }));
}

async function cancelEnrollment(error = '') {
  const body = {};
  if (auth.challengeToken) body.challengeToken = auth.challengeToken;
  if (auth.enrollmentToken) body.enrollmentToken = auth.enrollmentToken;
  showLogin(error);
  $('password').focus();
  if (Object.keys(body).length) {
    try { await api('enroll/cancel', { method: 'POST', body }); }
    catch { /* Local secrets are already gone; abandoned server tokens also expire. */ }
  }
}

async function checkSession() {
  await waitForPendingLogout();
  const generation = idle.generation;
  const session = await api('session');
  if (generation !== idle.generation) return;
  if (session.authenticated === true && typeof session.csrfToken === 'string' && session.csrfToken) {
    const locked = readLockMarker();
    if (locked) {
      state.csrfToken = session.csrfToken;
      idle.username = validUsername(session.username) ? session.username : '';
      await lockSession({ reason: 'logout', forgetDevice: locked.forgetDevice === true });
      return;
    }
    acceptSessionTiming(session, { initial: true });
    state.csrfToken = session.csrfToken;
    await enterDashboard();
    return;
  }
  auth.production = session.production === true;
  auth.mfaRequired = session.mfaRequired === true;
  auth.enrollmentAvailable = session.enrollmentAvailable === true;
  auth.setupRequired = !auth.enrollmentAvailable && (session.ready === false || (auth.production && session.configured === false));
  showLogin();
  if (typeof session.trustedUsername === 'string' && validUsername(session.trustedUsername)) {
    auth.setupRequired = false;
    showVerification('', session.trustedUsername);
    setAuthBusy(false);
  }
}

function sessionExpired(error) {
  if (error.status !== 401) return false;
  if (error.code === 'client_locked') return true;
  if (!state.csrfToken) return true;
  void lockSession({ reason: 'expired' });
  return true;
}

function validateMenu(data) {
  if (!Array.isArray(data.items) || data.revision === undefined || data.revision === null) {
    throw new ApiError('Сервер вернул неполные данные меню. Обновите страницу или проверьте настройку сервера.');
  }
  state.items = data.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || (Object.hasOwn(item, 'availableForOrder') && typeof item.availableForOrder !== 'boolean')) {
      throw new ApiError('Сервер вернул некорректную доступность блюда. Обновите меню.');
    }
    return { ...item, availableForOrder: Object.hasOwn(item, 'availableForOrder') ? item.availableForOrder : true };
  });
  state.revision = data.revision;
  state.loaded = true;
}

function imageUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value, location.href);
    return url.origin === location.origin && /\/(menu-images|uploads|assets)\//.test(url.pathname) ? url.href : '';
  } catch {
    return '';
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function itemCard(item) {
  const card = element('article', 'admin-item');
  const photo = element('div', 'admin-item-photo');
  const placeholder = element('div', 'admin-item-placeholder');
  const sun = element('span');
  sun.innerHTML = '<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M4.93 19.07 19.07 4.93"/></svg>';
  sun.setAttribute('aria-hidden', 'true');
  placeholder.append(sun, element('p', '', 'Без фотографии'));
  photo.append(placeholder);
  const src = imageUrl(item.image);
  if (src) {
    placeholder.hidden = true;
    const img = element('img');
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => { img.hidden = true; placeholder.hidden = false; });
    img.src = src;
    photo.append(img);
  }
  photo.append(element('span', `item-status${item.published ? '' : ' is-hidden'}`, item.published ? 'На сайте' : 'Скрыто'));
  const body = element('div', 'admin-item-body');
  body.append(element('p', 'item-category', categories[item.category] || 'Завтраки'));
  const title = element('div', 'item-title-row');
  title.append(element('h2', '', item.name), element('p', 'item-price', currency.format(item.price)));
  body.append(title, element('p', 'item-description', item.description || 'Описание пока не добавлено'), element('p', 'item-order', `Порядок в меню: ${item.order}`));
  const available = item.availableForOrder !== false;
  body.append(element('p', `item-availability${available && item.published ? '' : ' is-unavailable'}`,
    available ? (item.published ? 'Можно заказать' : 'Можно заказать после публикации') : 'Временно недоступно'));
  const actions = element('div', 'item-actions');
  const actionList = [
    ['edit', 'edit-button', 'Редактировать', `Редактировать блюдо «${item.name}»`],
    ['toggle', '', item.published ? 'Скрыть' : 'Показать', `${item.published ? 'Скрыть с сайта' : 'Показать на сайте'} блюдо «${item.name}»`],
    ['delete', 'delete-button', '×', `Удалить блюдо «${item.name}»`],
  ];
  for (const [action, className, label, accessibleLabel] of actionList) {
    const button = element('button', className, label);
    button.type = 'button';
    button.dataset.itemAction = action;
    button.dataset.itemId = item.id;
    button.setAttribute('aria-label', accessibleLabel);
    button.disabled = state.busy || state.conflict || !state.loaded;
    actions.append(button);
  }
  body.append(actions);
  card.append(photo, body);
  return card;
}

function render() {
  const query = $('search').value.trim().toLocaleLowerCase('ru');
  const category = $('category-filter').value;
  const filtered = state.items.filter((item) =>
    (category === 'all' || item.category === category)
    && `${item.name} ${item.description}`.toLocaleLowerCase('ru').includes(query),
  ).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ru'));
  $('total-count').textContent = state.items.length;
  const published = state.items.filter((item) => item.published).length;
  $('published-count').textContent = published;
  $('hidden-count').textContent = state.items.length - published;
  $('results-count').textContent = state.loaded ? `Показано: ${filtered.length} из ${state.items.length}` : 'Загружаем меню…';
  $('items').replaceChildren(...filtered.map(itemCard));
  $('empty-state').hidden = filtered.length !== 0 || !state.loaded;
  $('empty-title').textContent = state.items.length ? 'Ничего не нашлось' : 'Начнём с первого блюда';
  $('empty-description').textContent = state.items.length ? 'Попробуйте другое название или выберите все разделы.' : 'Добавьте название, описание, цену и фотографию.';
}

async function loadMenu({ preserveDraft = false } = {}) {
  if (state.busy) return;
  setBusy(true);
  try {
    validateMenu(await api('menu'));
    if (preserveDraft && draft.isNew && state.items.some((item) => item.id === draft.id)) draft.isNew = false;
    state.conflict = false;
    $('editor-conflict').hidden = true;
    render();
    notice(preserveDraft ? 'Список обновлён. Проверьте открытый черновик перед сохранением.' : 'Меню обновлено.');
    if (preserveDraft) {
      message($('editor-error'), 'Актуальное меню загружено. Ваш черновик сохранён — проверьте его перед повторным сохранением.');
    }
  } catch (error) {
    if (!sessionExpired(error)) {
      notice(error.message, { error: true, refresh: true });
      if (preserveDraft) {
        message($('editor-error'), error.message);
        $('editor-conflict').hidden = false;
      }
    }
  } finally {
    setBusy(false);
    $('add-item').disabled = !state.loaded || state.conflict;
  }
}

async function enterDashboard() {
  if (!idle.active || !state.csrfToken) return;
  const generation = idle.generation;
  clearChallenge();
  $('login-panel').hidden = true;
  $('connection-status').hidden = true;
  $('dashboard').hidden = false;
  $('logout').hidden = false;
  $('signout-actions').hidden = false;
  await loadMenu({ preserveDraft: draft.resume });
  if (generation !== idle.generation || !idle.active || idle.suspended) return;
  if (draft.resume && state.csrfToken) {
    draft.resume = false;
    $('editor-dialog').showModal();
  }
}

function markConflict(text) {
  state.conflict = true;
  notice(text, { error: true, refresh: true });
  $('editor-conflict').hidden = false;
  $('add-item').disabled = true;
}

async function persist(items) {
  try {
    validateMenu(await api('menu', { method: 'PUT', body: { items, revision: state.revision } }));
    render();
  } catch (error) {
    if (error.status === 409) markConflict('Меню изменилось в другой вкладке. Обновите данные перед следующими изменениями.');
    if (error.status === 0) markConflict('Ответ о сохранении не получен. Обновите меню, чтобы проверить, сохранились ли изменения.');
    sessionExpired(error);
    throw error;
  }
}

function clearPreviewUrl() {
  if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
  draft.previewUrl = '';
}

function updatePreview() {
  const src = draft.previewUrl || imageUrl(draft.image);
  $('preview-image').hidden = !src;
  $('photo-placeholder').hidden = !!src;
  if (src) $('preview-image').src = src;
  else $('preview-image').removeAttribute('src');
  $('remove-photo').hidden = !src;
}

function openEditor(item = null) {
  if (state.busy || !state.loaded || state.conflict) return;
  clearPreviewUrl();
  draft.id = item?.id || crypto.randomUUID();
  draft.isNew = !item;
  draft.image = item?.image || '';
  draft.file = null;
  draft.dirty = false;
  draft.resume = false;
  $('item-form').reset();
  $('item-name').value = item?.name || '';
  $('description').value = item?.description || '';
  $('price').value = item ? item.price : '';
  $('category').value = item?.category || 'signature';
  $('order').value = item ? item.order : Math.min(100000, Math.max(0, ...state.items.map((entry) => entry.order)) + 10);
  $('published').checked = item ? item.published : true;
  $('available-for-order').checked = item?.availableForOrder !== false;
  $('editor-title').textContent = item ? 'Редактировать блюдо' : 'Добавить блюдо';
  $('editor-eyebrow').textContent = item ? 'ЗАБОТА О ДЕТАЛЯХ' : 'НОВОЕ В МЕНЮ';
  $('editor-conflict').hidden = true;
  message($('editor-error'), '');
  updatePreview();
  $('editor-dialog').showModal();
  $('item-name').focus();
}

function closeEditor() {
  if (state.busy) return;
  if (draft.dirty && !window.confirm('Закрыть редактор? Несохранённые изменения будут потеряны.')) return;
  draft.dirty = false;
  draft.resume = false;
  clearPreviewUrl();
  $('editor-dialog').close();
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (auth.busy || auth.setupRequired || auth.challengeToken || auth.enrollmentPhase) return;
  const enteredUsername = $('username').value;
  const username = enteredUsername.trim();
  if (!username || !$('password').value) {
    message($('login-error'), 'Введите почту или логин и пароль.');
    (!username ? $('username') : $('password')).focus();
    return;
  }
  if (!validUsername(enteredUsername)) {
    message($('login-error'), 'Проверьте почту или логин. Почта должна содержать имя и домен с точкой; логин — от 3 до 64 латинских букв, цифр, точек, дефисов или подчёркиваний, начиная с буквы или цифры.');
    $('username').focus();
    return;
  }
  setAuthBusy(true);
  const generation = auth.generation;
  message($('login-error'), '');
  try {
    const data = await api('login', { method: 'POST', body: { username, password: $('password').value } });
    if (generation !== auth.generation) return;
    $('password').value = '';
    if (data.enrollmentRequired === true && typeof data.challengeToken === 'string' && data.challengeToken) {
      showEnrollment(data);
    } else if (data.mfaRequired === true && typeof data.challengeToken === 'string' && data.challengeToken) {
      showVerification(data.challengeToken);
    } else {
      throw new ApiError('Сервер не подтвердил вход. Проверьте настройку доступа.');
    }
  } catch (error) {
    $('password').value = '';
    message($('login-error'), error.message);
  } finally {
    setAuthBusy(false);
    if (!$('enrollment-form').hidden) $('enrollment-username').focus();
    else if (!$('verify-form').hidden) $('verification-code').focus();
    else if (!$('login-form').hidden && !$('login-panel').hidden) $('password').focus();
  }
});

$('verify-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (auth.busy || (!auth.challengeToken && !auth.trustedUsername) || auth.enrollmentPhase) return;
  const input = $('verification-code');
  const code = input.value.trim();
  if ((!auth.recovery && !/^\d{6}$/.test(code)) || (auth.recovery && (!code || code.length > 100))) {
    input.setAttribute('aria-invalid', 'true');
    message($('verification-error'), auth.recovery ? 'Введите резервный код.' : 'Введите код из 6 цифр.');
    input.focus();
    return;
  }
  setAuthBusy(true);
  input.removeAttribute('aria-invalid');
  message($('verification-error'), '');
  const generation = auth.generation;
  try {
    if (auth.trustedUsername && !auth.challengeToken) {
      const resumed = await api('resume', { method: 'POST', body: {} });
      if (generation !== auth.generation) return;
      if (!resumed.mfaRequired || typeof resumed.challengeToken !== 'string') throw new ApiError('Не удалось подтвердить устройство. Войдите с паролем.');
      auth.challengeToken = resumed.challengeToken;
    }
    const data = await api('verify', { method: 'POST', body: { challengeToken: auth.challengeToken, code } });
    if (generation !== auth.generation) return;
    if (data.authenticated !== true || typeof data.csrfToken !== 'string' || !data.csrfToken) throw new ApiError('Сервер не подтвердил вход. Попробуйте ещё раз.');
    acceptSessionTiming(data, { initial: true });
    clearLockMarker();
    state.csrfToken = data.csrfToken;
    await enterDashboard();
  } catch (error) {
    if ((error.status === 410 || error.code === 'challenge_expired') && auth.trustedUsername) {
      showVerification('', auth.trustedUsername);
      message($('verification-error'), 'Введите свежий код из приложения.');
    } else if (error.status === 410 || error.code === 'challenge_expired' || error.code === 'device_expired') {
      showLogin(error.message);
    } else {
      // A rejected code is retryable while the server keeps the challenge valid.
      message($('verification-error'), error.message);
      input.setAttribute('aria-invalid', 'true');
    }
  } finally {
    input.value = '';
    setAuthBusy(false);
    if (!$('verify-form').hidden) input.focus();
    else if (!$('login-panel').hidden && !$('login-form').hidden) $('password').focus();
  }
});

$('code-mode').addEventListener('click', () => {
  if (auth.busy || !auth.challengeToken || auth.trustedUsername) return;
  setCodeMode(!auth.recovery);
  $('verification-code').focus();
});

$('auth-back').addEventListener('click', async () => {
  if (auth.busy) return;
  showLogin();
  $('password').focus();
});

$('auth-forget-device').addEventListener('click', async () => {
  if (auth.busy) return;
  setAuthBusy(true);
  try {
    await api('forget-device', { method: 'POST', body: {} });
    rememberLocked(true);
    broadcastAuth({ type: 'lock', forgetDevice: true });
    idle.username = '';
    showLogin();
    $('username').value = '';
    $('username').focus();
  } catch (error) { message($('verification-error'), error.message); }
  finally { setAuthBusy(false); }
});

$('enrollment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (auth.busy || auth.enrollmentPhase !== 'details' || !auth.challengeToken) return;
  const username = $('enrollment-username').value.trim();
  const password = $('enrollment-password').value;
  const confirmation = $('enrollment-password-confirm').value;
  if (!username.includes('@') || !validUsername($('enrollment-username').value)) {
    message($('enrollment-error'), 'Введите корректную почту администратора.');
    $('enrollment-username').focus();
    return;
  }
  if ((auth.requiresNewPassword || password) && (password.length < 8 || password.length > 1024)) {
    message($('enrollment-error'), 'Новый пароль должен содержать от 8 до 1024 символов.');
    $('enrollment-password').focus();
    return;
  }
  if (password !== confirmation) {
    message($('enrollment-error'), 'Новые пароли не совпадают.');
    $('enrollment-password-confirm').focus();
    return;
  }
  setAuthBusy(true);
  const generation = auth.generation;
  message($('enrollment-error'), '');
  try {
    const data = await api('enroll/start', { method: 'POST', body: { challengeToken: auth.challengeToken, username, ...(password ? { password } : {}) } });
    if (generation !== auth.generation) return;
    await showEnrollmentQr(data, generation);
  } catch (error) {
    if (generation !== auth.generation) return;
    if (error.status === 410 || error.code === 'challenge_expired') showLogin(error.message);
    else if (error.status === 0 || error.status >= 500) await cancelEnrollment(error.message);
    else message($('enrollment-error'), error.message);
  } finally {
    $('enrollment-password').value = '';
    $('enrollment-password-confirm').value = '';
    setAuthBusy(false);
    if (!$('enrollment-verify-form').hidden) $('auth-heading').focus();
    else if (!$('login-form').hidden && !$('login-panel').hidden) $('password').focus();
  }
});

$('enrollment-verify-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (auth.busy || auth.enrollmentPhase !== 'qr' || !auth.enrollmentToken) return;
  const input = $('enrollment-code');
  const code = input.value.trim();
  if (!/^\d{6}$/.test(code)) {
    input.setAttribute('aria-invalid', 'true');
    message($('enrollment-verify-error'), 'Введите код из 6 цифр из записи «Восемь утра».');
    input.focus();
    return;
  }
  setAuthBusy(true);
  const generation = auth.generation;
  message($('enrollment-verify-error'), '');
  input.removeAttribute('aria-invalid');
  try {
    const data = await api('enroll/confirm', { method: 'POST', body: { enrollmentToken: auth.enrollmentToken, code } });
    if (generation !== auth.generation) return;
    showRecoveryCodes(data);
  } catch (error) {
    if (generation !== auth.generation) return;
    if (error.status === 410 || error.code === 'challenge_expired') showLogin(error.message);
    else if (error.status === 0 || error.status >= 500) await cancelEnrollment(error.message);
    else {
      message($('enrollment-verify-error'), error.message);
      input.setAttribute('aria-invalid', 'true');
    }
  } finally {
    input.value = '';
    setAuthBusy(false);
    if (auth.recoveryPending) $('auth-heading').focus();
    else if (!$('enrollment-verify-form').hidden) input.focus();
    else if (!$('login-form').hidden && !$('login-panel').hidden) $('password').focus();
  }
});

for (const id of ['enrollment-back', 'enrollment-cancel']) {
  $(id).addEventListener('click', () => { if (!auth.busy) return cancelEnrollment(); });
}

$('saved-recovery-codes').addEventListener('change', () => {
  $('enrollment-continue').disabled = auth.busy || !auth.recoveryPending || !$('saved-recovery-codes').checked;
});

$('enrollment-recovery-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (auth.busy || !auth.recoveryPending || !state.csrfToken || !$('saved-recovery-codes').checked) return;
  setAuthBusy(true);
  try { await enterDashboard(); }
  finally { setAuthBusy(false); }
});

$('check-setup').addEventListener('click', async () => {
  if (auth.busy) return;
  setAuthBusy(true);
  try {
    await checkSession();
  } catch (error) {
    $('auth-description').textContent = error.message;
  } finally {
    setAuthBusy(false);
    if (!$('login-form').hidden) $('username').focus();
  }
});

async function logout(forgetDevice = false) {
  if (state.busy || auth.busy) return;
  await lockSession({ reason: 'logout', forgetDevice });
}
$('logout').addEventListener('click', () => logout());
$('logout-forget').addEventListener('click', () => logout(true));
$('recovery-logout').addEventListener('click', () => logout());

$('add-item').addEventListener('click', () => openEditor());
$('search').addEventListener('input', render);
$('category-filter').addEventListener('change', render);
$('refresh').addEventListener('click', () => loadMenu());
$('retry-load').addEventListener('click', () => loadMenu());
$('refresh-draft').addEventListener('click', () => loadMenu({ preserveDraft: true }));
$('close-editor').addEventListener('click', closeEditor);
$('cancel-editor').addEventListener('click', closeEditor);
$('editor-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeEditor(); });
$('item-form').addEventListener('input', () => { draft.dirty = true; });

$('photo').addEventListener('change', () => {
  const file = $('photo').files[0];
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024 || file.size === 0) {
    message($('editor-error'), 'Выберите изображение JPG, PNG или WebP размером до 5 МБ.');
    $('photo').value = '';
    return;
  }
  clearPreviewUrl();
  draft.file = file;
  draft.previewUrl = URL.createObjectURL(file);
  draft.dirty = true;
  message($('editor-error'), '');
  updatePreview();
});
$('preview-image').addEventListener('error', () => {
  $('preview-image').hidden = true;
  $('photo-placeholder').hidden = false;
});
$('remove-photo').addEventListener('click', () => {
  clearPreviewUrl();
  draft.file = null;
  draft.image = '';
  draft.dirty = true;
  $('photo').value = '';
  updatePreview();
});

$('item-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.busy || state.conflict || !state.loaded) return;
  const name = $('item-name').value.trim();
  if (!name) {
    message($('editor-error'), 'Укажите название блюда.');
    $('item-name').focus();
    return;
  }
  if (!draft.isNew && !state.items.some((item) => item.id === draft.id)) {
    message($('editor-error'), 'Это блюдо уже удалено из меню. Скопируйте нужные данные и добавьте его как новое блюдо.');
    return;
  }
  setBusy(true);
  message($('editor-error'), '');
  try {
    if (draft.file) {
      const upload = await api('upload', { method: 'POST', body: draft.file, raw: true });
      if (!upload.url || !imageUrl(upload.url)) throw new ApiError('Сервер не вернул адрес фотографии. Попробуйте загрузить её ещё раз.');
      draft.image = upload.url;
      draft.file = null;
    }
    const item = {
      id: draft.id, name, description: $('description').value.trim(), price: Number($('price').value),
      category: $('category').value, image: draft.image, published: $('published').checked,
      availableForOrder: $('available-for-order').checked, order: Number($('order').value),
    };
    const items = draft.isNew ? [...state.items, item] : state.items.map((entry) => entry.id === item.id ? item : entry);
    await persist(items);
    draft.dirty = false;
    clearPreviewUrl();
    $('editor-dialog').close();
    notice(!item.published ? `«${name}» сохранено. Блюдо скрыто от гостей.` : item.availableForOrder
      ? `«${name}» сохранено. Видно на сайте и можно заказать.`
      : `«${name}» сохранено. Видно на сайте, временно недоступно для заказа.`);
  } catch (error) {
    sessionExpired(error);
    message($('editor-error'), error.status === 409 ? 'Не удалось сохранить: меню уже изменилось. Ваш черновик остался в форме.' : error.message);
  } finally {
    setBusy(false);
    $('add-item').disabled = state.conflict || !state.loaded;
  }
});

$('items').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-item-action]');
  if (!button || state.busy || state.conflict) return;
  const item = state.items.find((entry) => entry.id === button.dataset.itemId);
  if (!item) return;
  if (button.dataset.itemAction === 'edit') return openEditor(item);
  if (button.dataset.itemAction === 'delete') {
    deleteId = item.id;
    $('delete-description').textContent = `«${item.name}» будет удалено из меню. Если блюдо ещё пригодится, его можно просто скрыть с сайта.`;
    message($('delete-error'), '');
    $('delete-dialog').showModal();
    return;
  }
  setBusy(true);
  try {
    await persist(state.items.map((entry) => entry.id === item.id ? { ...entry, published: !entry.published } : entry));
    notice(`«${item.name}» ${item.published ? 'скрыто с сайта' : 'снова видно на сайте'}.`);
  } catch (error) {
    if (!state.conflict) notice(error.message, { error: true });
  } finally {
    setBusy(false);
    $('add-item').disabled = state.conflict || !state.loaded;
    [...document.querySelectorAll('[data-item-action="toggle"]')].find((entry) => entry.dataset.itemId === item.id)?.focus();
  }
});

$('cancel-delete').addEventListener('click', () => { if (!state.busy) $('delete-dialog').close(); });
$('delete-dialog').addEventListener('cancel', (event) => { if (state.busy) event.preventDefault(); });
$('confirm-delete').addEventListener('click', async () => {
  if (state.busy || state.conflict || !deleteId) return;
  const item = state.items.find((entry) => entry.id === deleteId);
  if (!item) return $('delete-dialog').close();
  setBusy(true);
  try {
    await persist(state.items.filter((entry) => entry.id !== deleteId));
    $('delete-dialog').close();
    notice(`«${item.name}» удалено из меню.`);
    $('add-item').focus();
  } catch (error) {
    if (state.conflict) $('delete-dialog').close();
    else message($('delete-error'), error.message);
  } finally {
    setBusy(false);
    $('add-item').disabled = state.conflict || !state.loaded;
  }
});

window.addEventListener('beforeunload', (event) => {
  if (auth.recoveryPending || auth.enrollmentToken || (draft.dirty && ($('editor-dialog').open || draft.resume))) {
    event.preventDefault();
    event.returnValue = '';
  }
});

window.addEventListener('pagehide', () => {
  // A back/forward cache entry must never retain a QR secret or one-time recovery list.
  if (auth.enrollmentPhase || auth.challengeToken || auth.busy) showLogin();
  else clearChallenge();
});

for (const type of ['pointerdown', 'pointermove', 'keydown', 'input', 'wheel', 'touchstart', 'touchmove']) {
  document.addEventListener(type, recordActivity, { capture: true, passive: true });
}

let checkingVisibleSession = false;
function suspendProtectedUi() {
  if (!idle.active || idle.suspended) return;
  idle.suspended = true;
  idle.dashboardWasVisible = !$('dashboard').hidden;
  $('dashboard').hidden = true;
  draft.resume = draft.resume || $('editor-dialog').open;
  $('editor-dialog').close();
  $('delete-dialog').close();
  clearTimeout(idle.timer);
}

async function checkVisibleSession() {
  if (document.visibilityState === 'hidden' || !idle.active || checkingVisibleSession) return;
  if (sessionNow() >= idle.deadline || sessionNow() >= idle.absoluteDeadline) suspendProtectedUi();
  const generation = idle.generation;
  checkingVisibleSession = true;
  try {
    // This endpoint never refreshes idle expiry. Focus/visibility is not user activity.
    const data = await api('session');
    if (generation !== idle.generation || !idle.active) return;
    if (data.authenticated !== true || data.csrfToken !== state.csrfToken) {
      if (validUsername(data.trustedUsername)) idle.username = data.trustedUsername;
      void lockSession({ reason: 'expired', remote: true });
      return;
    }
    const timing = data.session;
    if (timing && Number.isFinite(timing.idleExpiresAt) && Number.isFinite(timing.serverNow) && Number.isFinite(timing.idleTimeoutMs)) {
      // Another open tab may have sent actual activity while this one was suspended.
      idle.lastActivity = Math.max(idle.lastActivity, (timingObservedAt.get(data) ?? sessionNow()) + timing.idleExpiresAt - timing.serverNow - timing.idleTimeoutMs);
    }
    acceptSessionTiming(data);
    if (idle.active && idle.suspended) {
      idle.suspended = false;
      if (idle.dashboardWasVisible) {
        $('dashboard').hidden = false;
        if (draft.resume && state.loaded) { draft.resume = false; $('editor-dialog').showModal(); }
      }
    }
  } catch (error) {
    if (error.code !== 'client_locked' && generation === idle.generation && state.csrfToken) {
      void lockSession({ reason: 'expired', remote: true, persist: true });
    }
  } finally { checkingVisibleSession = false; }
}
document.addEventListener('visibilitychange', checkVisibleSession);
window.addEventListener('focus', checkVisibleSession);
window.addEventListener('pageshow', checkVisibleSession);

if (authChannel) authChannel.onmessage = ({ data }) => {
  if (!data || typeof data !== 'object') return;
  if (data.type === 'lock') {
    if (idle.active || auth.trustedUsername) void lockSession({ reason: 'logout', forgetDevice: data.forgetDevice === true, remote: true, pending: data.pending === true });
  } else if (data.type === 'logout-complete') {
    clearTimeout(remoteLogoutTimer);
    remoteLogoutTimer = null;
    if (auth.logoutPending) { auth.logoutPending = false; setAuthBusy(false); }
    pendingLogoutWake?.();
  } else if (data.type === 'activity' && idle.active && data.username === idle.username && Number.isFinite(data.deadline)) {
    const deadline = Math.min(data.deadline, idle.absoluteDeadline, sessionNow() + idle.timeoutMs);
    if (deadline > idle.deadline) {
      idle.deadline = deadline;
      idle.lastActivity = Math.max(idle.lastActivity, deadline - idle.timeoutMs);
      idle.lastAcknowledged = Math.max(idle.lastAcknowledged, idle.lastActivity);
      scheduleIdleLock();
    }
  }
};
window.addEventListener('storage', (event) => {
  if (event.key === LOCK_STORAGE_KEY && !readLockMarker()?.pendingUntil) pendingLogoutWake?.();
});

try {
  await checkSession();
} catch (error) {
  showLogin(error.message);
}
