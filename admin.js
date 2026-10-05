import { normalizeMenuCategories, normalizeMenuData, categoryDescendantIds, categoryPath, orderedCategories } from './menu-categories.js';

const $ = (id) => document.getElementById(id);
const manualMenu = $('site-profile').getAttribute('content') === 'catalog';
const currency = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 });
const state = { items: [], categories: [], sourceCategories: [], mode: 'site', siteCategory: null, cashGroupId: null,
  siteSearch: '', cashSearch: '', keeperSync: { configured: false, updatedAt: null }, syncing: false, revision: null, csrfToken: '', busy: false, loaded: false, conflict: false };
// Login challenges, password grants and entered codes live only in page memory.
const auth = { challengeToken: '', recovery: false, busy: false, setupRequired: false, production: false, mfaRequired: false, passwordOnly: false,
  enrollmentAvailable: false, enrollmentToken: '', enrollmentPhase: '', enrollmentTimer: null, generation: 0,
  requiresNewPassword: false, recoveryPending: false, trustedUsername: '', logoutPending: false };
const draft = { id: null, image: '', file: null, previewUrl: '', dirty: false, resume: false };
const passwordReset = { token: '', passwordToken: '', email: '', retryAt: 0, verifyAt: 0, completeAt: 0, expiresAt: 0, resumeUntil: 0, timer: null, generation: 0 };
const RESET_STORAGE_KEY = 'vosem-utra-password-reset';
const categoryDraft = { categories: [], items: [], selectedId: null, revision: null, dirty: false, resume: false };
const categoryControls = { selects: [], rows: [] };
let categoryDrag = null;
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
  ['reset-password', 'новый пароль'],
  ['reset-password-confirm', 'повтор пароля'],
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
  constructor(message, status = 0, code = '', retryAfter = 0) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
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
  if (auth.passwordOnly) {
    if (validUsername(username)) $('username').value = username;
    $('password').focus(); message($('session-lock-note'), note); return;
  }
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
  clearCategoryDrag();
  categoryDraft.resume = categoryDraft.resume || $('categories-dialog').open;
  $('categories-dialog').close();
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
  const draftNote = draft.resume || categoryDraft.resume ? ' Черновик сохранён в этой вкладке.' : '';
  const note = reason === 'idle'
    ? `Панель закрыта после 15 минут без действий.${draftNote}`
    : reason === 'expired' ? `Сессия завершилась.${draftNote}` : `Вы вышли из панели.${draftNote}`;
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
  const timeout = setTimeout(() => controller.abort(), path === 'sync-availability' ? 90000 : 20000);
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
      const retryHeader = response.headers.get('retry-after');
      const retrySeconds = /^\d+$/.test(retryHeader || '') ? Number(retryHeader) : (Date.parse(retryHeader) - Date.now()) / 1000;
      const retryAfter = Number.isFinite(retrySeconds) ? Math.min(86400, Math.max(0, Math.ceil(retrySeconds))) : 0;
      throw new ApiError(detail || `Не удалось выполнить запрос (${response.status}). Попробуйте ещё раз.`, response.status, data.code || data.error?.code || '', retryAfter);
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
  $('categories-fields').disabled = busy;
  for (const id of ['logout', 'logout-forget', 'add-dish', 'empty-browse-cash', 'manage-categories', 'close-categories', 'cancel-categories', 'refresh', 'retry-load', 'close-editor', 'cancel-editor', 'refresh-draft', 'cancel-delete', 'confirm-delete']) $(id).disabled = busy;
  $('save-categories').disabled = busy || state.conflict || !state.loaded;
  $('save-categories').textContent = busy ? 'Сохраняем…' : 'Сохранить группы';
  $('save-item').disabled = busy || state.conflict || !state.loaded;
  $('empty-browse-cash').disabled = busy || state.conflict || !state.loaded;
  $('manage-categories').disabled = busy || !state.loaded;
  $('save-item').textContent = busy ? 'Сохраняем…' : 'Сохранить блюдо';
  renderKeeperSync();
  document.querySelectorAll('[data-item-action]').forEach((button) => { button.disabled = busy || state.conflict || !state.loaded; });
}

function setAuthBusy(busy) {
  busy = busy || auth.logoutPending;
  auth.busy = busy;
  if (busy) hidePasswords();
  for (const id of ['username', 'password', 'password-toggle', 'enrollment-password-toggle', 'enrollment-password-confirm-toggle', 'login-submit', 'verification-code', 'verify-submit', 'code-mode', 'auth-back', 'check-setup',
    'enrollment-username', 'enrollment-password', 'enrollment-password-confirm', 'enrollment-start', 'enrollment-back',
    'enrollment-code', 'enrollment-confirm', 'enrollment-cancel', 'saved-recovery-codes', 'recovery-logout', 'auth-forget-device',
    'forgot-password', 'reset-email', 'reset-code', 'reset-password', 'reset-password-confirm', 'reset-password-toggle', 'reset-password-confirm-toggle',
    'reset-request-submit', 'reset-code-submit', 'reset-password-submit', 'reset-request-back', 'reset-code-back', 'reset-password-back', 'reset-change-email', 'reset-resend', 'reset-have-code']) {
    $(id).disabled = busy || (auth.setupRequired && id !== 'check-setup');
  }
  for (const id of ['login-form', 'verify-form', 'enrollment-form', 'enrollment-verify-form', 'enrollment-recovery-form', 'reset-request-form', 'reset-code-form', 'reset-password-form']) $(id).setAttribute('aria-busy', String(busy));
  $('reset-request-submit').textContent = busy ? 'Отправляем…' : 'Получить код ↗';
  $('reset-code-submit').textContent = busy ? 'Проверяем…' : 'Подтвердить код ↗';
  $('reset-password-submit').textContent = busy ? 'Сохраняем…' : 'Сохранить пароль ↗';
  updateResetResend();
  $('login-submit').textContent = busy ? 'Проверяем…' : auth.passwordOnly ? 'Войти ↗' : 'Продолжить ↗';
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

function updateResetResend() {
  clearTimeout(passwordReset.timer);
  passwordReset.timer = null;
  const remaining = Math.max(0, Math.ceil((passwordReset.retryAt - sessionNow()) / 1000));
  const verifyWait = Math.max(0, Math.ceil((passwordReset.verifyAt - sessionNow()) / 1000));
  const completeWait = Math.max(0, Math.ceil((passwordReset.completeAt - sessionNow()) / 1000));
  const codeLeft = Math.max(0, Math.ceil((passwordReset.expiresAt - sessionNow()) / 1000));
  const blocked = auth.busy || auth.setupRequired;
  $('reset-resend').disabled = auth.busy || auth.setupRequired || remaining > 0;
  $('reset-resend').textContent = remaining ? `Новое письмо через ${resetDuration(remaining)}` : 'Отправить код повторно';
  $('reset-request-submit').disabled = blocked || remaining > 0;
  $('reset-code-submit').disabled = blocked || verifyWait > 0 || (passwordReset.expiresAt > 0 && !codeLeft);
  $('reset-password-submit').disabled = blocked || completeWait > 0;
  message($('reset-request-wait'), remaining ? `Повторная отправка станет доступна через ${resetDuration(remaining)}.` : '');
  message($('reset-code-wait'), verifyWait ? `Проверить код снова можно через ${resetDuration(verifyWait)}.` : '');
  message($('reset-password-wait'), completeWait ? `Сохранить пароль снова можно через ${resetDuration(completeWait)}.` : '');
  if (passwordReset.expiresAt) $('reset-code-help').textContent = codeLeft
    ? `Код действует ещё ${resetDuration(codeLeft)}. Ожидание нового письма не мешает ввести этот код.`
    : remaining ? 'Срок действия кода истёк. Запросите новое письмо, когда закончится ожидание на кнопке ниже.'
      : 'Срок действия кода истёк. Запросите новое письмо кнопкой ниже.';
  else $('reset-code-help').textContent = 'Введите 8 цифр из письма. Код действует 10 минут с момента запроса. Новое письмо для проверки не требуется.';
  if ((remaining || verifyWait || completeWait || codeLeft) &&
      ['reset-request-form', 'reset-code-form', 'reset-password-form'].some(id => !$(id).hidden)) passwordReset.timer = setTimeout(updateResetResend, 1000);
}

function resetDuration(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function resetRetrySeconds(seconds) { return Math.min(180, Math.max(1, Number(seconds) || 60)); }

// Only the mail-request handle is retained in this tab; it cannot reset a password
// without the email code. Never store the code, new password, or password grant.
function rememberPasswordReset() {
  try {
    if (!passwordReset.email || passwordReset.passwordToken) { globalThis.sessionStorage?.removeItem(RESET_STORAGE_KEY); return; }
    const { token, email, retryAt, verifyAt, expiresAt, resumeUntil } = passwordReset;
    globalThis.sessionStorage?.setItem(RESET_STORAGE_KEY, JSON.stringify({ token, email, retryAt, verifyAt, expiresAt, resumeUntil }));
  } catch { /* Restricted browser storage: the current tab can still complete recovery. */ }
}

function readPasswordReset() {
  try {
    const saved = JSON.parse(globalThis.sessionStorage?.getItem(RESET_STORAGE_KEY) || 'null');
    if (saved && (saved.token === '' || /^[a-f0-9]{64}$/.test(saved.token)) && validUsername(saved.email) && saved.email.includes('@') &&
        ['retryAt', 'verifyAt', 'expiresAt'].every(key => Number.isFinite(saved[key]) && saved[key] >= 0) &&
        Number.isFinite(saved.resumeUntil ?? saved.expiresAt) && (saved.resumeUntil ?? saved.expiresAt) <= sessionNow() + 600000 &&
        saved.expiresAt <= sessionNow() + 600000 && Math.max(saved.resumeUntil ?? saved.expiresAt, saved.retryAt, saved.verifyAt) > sessionNow() &&
        Math.max(saved.retryAt, saved.verifyAt) <= sessionNow() + 86400000) {
      saved.resumeUntil ??= saved.expiresAt;
      saved.retryAt = Math.min(saved.retryAt, sessionNow() + 180000);
      saved.verifyAt = Math.min(saved.verifyAt, sessionNow() + 180000);
      return saved;
    }
    globalThis.sessionStorage?.removeItem(RESET_STORAGE_KEY);
  } catch { /* Invalid or unavailable storage cannot grant access. */ }
  return null;
}

function showResetCode() {
  $('login-form').hidden = true;
  $('reset-request-form').hidden = true;
  $('reset-code-form').hidden = false;
  $('reset-code').value = '';
  $('auth-heading').textContent = 'Введите код из письма';
  $('auth-description').textContent = passwordReset.email;
  message($('reset-delivery-note'), passwordReset.token
    ? 'Если эта почта привязана к администратору, на неё придёт код восстановления.'
    : 'Введите уже полученный код для этой почты. Новое письмо не отправлялось.');
  updateResetResend();
}

function resumePasswordReset(saved) {
  if (!saved || auth.setupRequired || state.csrfToken) return false;
  // Assign the allowlisted fields only, never a stored password grant or auth state.
  for (const key of ['token', 'email', 'retryAt', 'verifyAt', 'expiresAt', 'resumeUntil']) passwordReset[key] = saved[key];
  rememberPasswordReset(); showResetCode();
  return true;
}

function clearPasswordReset() {
  passwordReset.generation += 1;
  clearTimeout(passwordReset.timer);
  passwordReset.timer = null;
  passwordReset.token = ''; passwordReset.passwordToken = ''; passwordReset.email = ''; passwordReset.retryAt = 0;
  passwordReset.verifyAt = 0; passwordReset.completeAt = 0; passwordReset.expiresAt = 0; passwordReset.resumeUntil = 0;
  rememberPasswordReset();
  for (const id of ['reset-email', 'reset-code', 'reset-password', 'reset-password-confirm']) $(id).value = '';
  for (const id of ['reset-request-form', 'reset-code-form', 'reset-password-form']) $(id).hidden = true;
  for (const id of ['reset-request-error', 'reset-code-error', 'reset-password-error', 'reset-delivery-note', 'reset-request-wait', 'reset-code-wait', 'reset-password-wait']) message($(id), '');
}

function showPasswordReset(email = '') {
  showLogin();
  $('login-form').hidden = true;
  $('reset-request-form').hidden = false;
  $('reset-email').value = email.includes('@') ? email : '';
  $('auth-heading').textContent = 'Восстановим пароль';
  $('auth-description').textContent = 'Укажите почту, с которой входите в админку. Получите письмо или введите код, который уже пришёл.';
  $('reset-email').focus();
}

function showNewPassword(token, email, temporary = false) {
  passwordReset.token = ''; passwordReset.passwordToken = token; passwordReset.email = email;
  passwordReset.expiresAt = 0; passwordReset.verifyAt = 0; rememberPasswordReset();
  $('reset-code').value = ''; $('login-form').hidden = true; $('reset-request-form').hidden = true;
  $('reset-code-form').hidden = true; $('reset-password-form').hidden = false;
  $('reset-password-step').textContent = temporary ? 'Новый пароль' : '3 из 3 · Новый пароль';
  $('auth-heading').textContent = 'Придумайте новый пароль';
  $('auth-description').textContent = temporary ? 'Замените временный пароль на свой. Затем войдите с новым паролем.'
    : auth.passwordOnly ? 'После смены пароля войдите с почтой и новым паролем.'
      : 'После смены пароля войдите заново. Подтверждение через приложение останется подключённым.';
}

async function sendResetCode(email, errorId) {
  if (auth.busy || sessionNow() < passwordReset.retryAt) return;
  if (!email.includes('@') || !validUsername(email)) { message($(errorId), 'Укажите почту администратора.'); return; }
  const generation = passwordReset.generation;
  setAuthBusy(true); message($(errorId), '');
  try {
    const data = await api('password-reset/request', { method: 'POST', body: { email } });
    if (generation !== passwordReset.generation) return;
    if (typeof data.resetToken !== 'string' || !/^[a-f0-9]{64}$/.test(data.resetToken)) throw new ApiError('Не удалось запросить код. Повторите попытку.');
    passwordReset.email = email; passwordReset.token = data.resetToken; passwordReset.passwordToken = '';
    passwordReset.retryAt = sessionNow() + resetRetrySeconds(data.retryAfter) * 1000;
    passwordReset.expiresAt = (timingObservedAt.get(data) ?? sessionNow()) + Math.min(600, Math.max(1, Number(data.expiresIn) || 600)) * 1000;
    passwordReset.resumeUntil = passwordReset.expiresAt;
    rememberPasswordReset(); showResetCode();
  } catch (error) {
    if (generation === passwordReset.generation) {
      if (error.status === 429) {
        passwordReset.retryAt = sessionNow() + resetRetrySeconds(error.retryAfter) * 1000;
        rememberPasswordReset();
      }
      message($(errorId), error.message);
    }
  }
  finally { setAuthBusy(false); if (generation === passwordReset.generation && !$('reset-code-form').hidden) $('reset-code').focus(); }
}

$('forgot-password').addEventListener('click', () => { if (!auth.busy) showPasswordReset($('username').value.trim()); });
$('reset-request-form').addEventListener('submit', async (event) => {
  event.preventDefault(); await sendResetCode($('reset-email').value.trim().toLowerCase(), 'reset-request-error');
});
$('reset-have-code').addEventListener('click', () => {
  if (auth.busy || auth.setupRequired) return;
  const email = $('reset-email').value.trim().toLowerCase();
  if (!email.includes('@') || !validUsername(email)) { message($('reset-request-error'), 'Укажите почту администратора.'); $('reset-email').focus(); return; }
  if (email !== passwordReset.email) { passwordReset.token = ''; passwordReset.expiresAt = 0; }
  passwordReset.email = email;
  passwordReset.resumeUntil = sessionNow() + 600000;
  rememberPasswordReset(); showResetCode(); $('reset-code').focus();
});
$('reset-resend').addEventListener('click', async () => {
  if (sessionNow() < passwordReset.retryAt) return;
  await sendResetCode(passwordReset.email, 'reset-code-error');
});
$('reset-change-email').addEventListener('click', () => { if (!auth.busy) showPasswordReset(passwordReset.email); });
for (const id of ['reset-request-back', 'reset-code-back', 'reset-password-back']) $(id).addEventListener('click', () => {
  if (auth.busy) return;
  const email = passwordReset.email || $('reset-email').value;
  showLogin(); if (email) $('username').value = email; $('password').focus();
});
$('reset-code-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (auth.busy || sessionNow() < passwordReset.verifyAt) return;
  if (passwordReset.expiresAt && sessionNow() >= passwordReset.expiresAt) { updateResetResend(); return; }
  const code = $('reset-code').value.replace(/\s/g, '');
  if (!/^[0-9]{8}$/.test(code)) { message($('reset-code-error'), 'Введите 8 цифр из письма.'); return; }
  const generation = passwordReset.generation;
  setAuthBusy(true); message($('reset-code-error'), '');
  try {
    const body = passwordReset.token ? { resetToken: passwordReset.token, code } : { email: passwordReset.email, code };
    const data = await api('password-reset/verify', { method: 'POST', body });
    if (generation !== passwordReset.generation) return;
    if (typeof data.passwordToken !== 'string' || !/^[a-f0-9]{64}$/.test(data.passwordToken)) throw new ApiError('Не удалось подтвердить код. Запросите его заново.');
    showNewPassword(data.passwordToken, passwordReset.email);
  } catch (error) {
    if (generation === passwordReset.generation) {
      if (error.status === 429) { passwordReset.verifyAt = sessionNow() + resetRetrySeconds(error.retryAfter) * 1000; rememberPasswordReset(); }
      message($('reset-code-error'), error.message);
    }
  }
  finally { setAuthBusy(false); if (generation === passwordReset.generation && !$('reset-password-form').hidden) $('reset-password').focus(); }
});
$('reset-password-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (auth.busy || sessionNow() < passwordReset.completeAt) return;
  const password = $('reset-password').value;
  if ([...password].length < 8 || [...password].length > 1024) { message($('reset-password-error'), 'Новый пароль должен содержать от 8 до 1024 символов.'); return; }
  if (password !== $('reset-password-confirm').value) { message($('reset-password-error'), 'Пароли не совпадают.'); return; }
  const generation = passwordReset.generation;
  setAuthBusy(true); message($('reset-password-error'), '');
  try {
    const data = await api('password-reset/complete', { method: 'POST', body: { passwordToken: passwordReset.passwordToken, password } });
    if (generation !== passwordReset.generation) return;
    if (data.passwordChanged !== true) throw new ApiError('Не удалось подтвердить смену пароля.');
    const email = passwordReset.email;
    showLogin(); $('username').value = email;
    message($('session-lock-note'), auth.passwordOnly ? 'Пароль изменён. Войдите с почтой и новым паролем.' : 'Пароль изменён. Войдите с новым паролем и подтвердите вход кодом из приложения.');
  } catch (error) {
    if (generation === passwordReset.generation) {
      if (error.status === 429) passwordReset.completeAt = sessionNow() + resetRetrySeconds(error.retryAfter) * 1000;
      message($('reset-password-error'), error.message);
    }
  }
  finally { setAuthBusy(false); if (!$('login-form').hidden) $('password').focus(); }
});

function clearChallenge() {
  clearPasswordReset();
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
    : manualMenu ? 'Войдите, чтобы добавлять блюда, обновлять фотографии и цены.' : 'Войдите, чтобы размещать блюда из кассы, обновлять фотографии и цены.';
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
  const savedReset = readPasswordReset();
  await waitForPendingLogout();
  const generation = idle.generation;
  const session = await api('session');
  if (generation !== idle.generation) return;
  auth.passwordOnly = session.authMode === 'password';
  $('device-login-help').textContent = auth.passwordOnly ? 'Введите почту и пароль администратора.'
    : 'Запомним этот браузер: в следующий раз понадобится только код из приложения. На чужом устройстве выберите «Выйти и забыть устройство».';
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
  if (resumePasswordReset(savedReset)) return;
  if (!auth.passwordOnly && typeof session.trustedUsername === 'string' && validUsername(session.trustedUsername)) {
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
  const items = data.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || (Object.hasOwn(item, 'availableForOrder') && typeof item.availableForOrder !== 'boolean')
      || (Object.hasOwn(item, 'hiddenOnSite') && typeof item.hiddenOnSite !== 'boolean')) {
      throw new ApiError('Сервер вернул некорректную доступность блюда. Обновите меню.');
    }
    return { ...item, availableForOrder: Object.hasOwn(item, 'availableForOrder') ? item.availableForOrder : true };
  });
  try {
    const normalized = normalizeMenuData({ ...data, items });
    const { categories, sourceCategories } = normalized;
    state.categories = orderedCategories(categories).map((category, order) => ({ ...category, parentId: null, order }));
    state.items = normalized.items.map((item) => ({ ...item, published: !!item.category && item.hiddenOnSite !== true, availableForOrder: !!item.category && item.hiddenOnSite !== true && item.source?.testOnly !== true }));
    state.sourceCategories = sourceCategories;
  } catch {
    throw new ApiError('Сервер вернул некорректные группы. Обновите меню или обратитесь к администратору.');
  }
  if (data.keeperSync && typeof data.keeperSync.configured === 'boolean') state.keeperSync = { ...data.keeperSync };
  state.revision = data.revision;
  state.loaded = true;
  updateCategoryControls();
  renderKeeperSync();
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

function categoryLabel(id) {
  return categoryPath(state.categories, id).map((entry) => entry.name).join(' / ');
}

function updateCategoryControls() {
  const editor = $('category');
  const selectedEditor = editor.value;
  const entries = orderedCategories(state.categories).filter((entry) => !entry.source);
  const option = (value, label) => {
    const node = element('option', '', label);
    node.value = value;
    return node;
  };
  if (!entries.some((entry) => entry.id === state.siteCategory)) state.siteCategory = entries[0]?.id || null;
  if (!state.sourceCategories.some((entry) => entry.id === state.cashGroupId)) state.cashGroupId = null;
  editor.replaceChildren(option('', 'Не размещать на сайте'), ...entries.map((entry) => option(entry.id, categoryLabel(entry.id))));
  editor.value = state.categories.some((entry) => entry.id === selectedEditor) ? selectedEditor : '';
  const buttons = entries.map((entry) => {
    const ids = categoryDescendantIds(state.categories, entry.id);
    const count = state.items.filter((item) => ids.has(item.category)).length;
    const button = element('button', 'admin-category-tab');
    button.type = 'button';
    button.dataset.categoryId = entry.id;
    button.setAttribute('aria-controls', 'items');
    button.setAttribute('aria-pressed', 'false');
    button.append(element('span', '', entry.parentId ? categoryLabel(entry.id) : entry.name), element('span', 'admin-category-count', String(count)));
    return button;
  });
  $('category-tabs').replaceChildren(...buttons);
}

function keeperAvailabilityLabel(item) {
  if (manualMenu) return '';
  const availability = item?.keeperAvailability;
  if (!availability) return '';
  if (availability.forbidden === true) return 'В стоп-листе';
  if (typeof availability.remaining === 'number' && Number.isFinite(availability.remaining)) {
    return availability.remaining <= 0 ? 'Нет в наличии' : `Осталось: ${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(availability.remaining)} порц.`;
  }
  return '';
}

function renderKeeperSync() {
  if (manualMenu) return;
  const sync = state.keeperSync;
  $('sync-availability').disabled = state.busy || !state.loaded || state.conflict || !sync.configured;
  $('sync-availability').setAttribute('aria-busy', String(state.syncing));
  $('sync-availability-label').textContent = state.syncing ? 'Синхронизируем…' : 'Синхронизировать стоп-лист и остатки';
  const timestamp = sync.updatedAt ? new Date(sync.updatedAt) : null;
  $('keeper-sync-status').textContent = !sync.configured ? 'Подключение к кассе не настроено' : timestamp && Number.isFinite(timestamp.getTime())
    ? `Проверено: ${new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(timestamp)}`
    : 'Стоп-лист и остатки ещё не проверялись';
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
  photo.append(element('span', `item-status${item.published ? '' : ' is-hidden'}`,
    item.published ? 'На сайте' : item.category ? 'Скрыто с сайта' : 'Только на кассе'));
  const body = element('div', 'admin-item-body');
  const category = element('div', 'item-category-line');
  category.append(element('p', 'item-category', item.category ? categoryLabel(item.category) : 'Группа на сайте не выбрана'));
  if (!manualMenu && item.source?.provider === 'kds') category.append(element('span', 'item-source', 'Из кассы'));
  body.append(category);
  const title = element('div', 'item-title-row');
  title.append(element('h2', '', item.name), element('p', 'item-price', currency.format(item.price)));
  body.append(title, element('p', 'item-description', item.description || 'Описание пока не добавлено'));
  const testOnly = item.source?.testOnly === true;
  const keeperBlocked = item.keeperAvailability?.forbidden === true || (typeof item.keeperAvailability?.remaining === 'number' && item.keeperAvailability.remaining < 1);
  const available = !testOnly && item.availableForOrder !== false && !keeperBlocked;
  if (!manualMenu) body.append(element('p', `item-availability${available && item.published ? '' : ' is-unavailable'}`,
    testOnly ? 'Тестовое блюдо · заказ недоступен' : available ? (item.published ? 'Можно заказать' : 'Можно заказать после публикации') : 'Временно недоступно'));
  const keeperLabel = keeperAvailabilityLabel(item);
  if (keeperLabel) body.append(element('p', 'item-availability is-unavailable', keeperLabel));
  const actions = element('div', 'item-actions');
  const actionList = [['edit', 'edit-button', 'Редактировать', `Редактировать блюдо «${item.name}»`]];
  if (item.category) actionList.push(['visibility', 'visibility-button', item.hiddenOnSite ? 'Показать на сайте' : 'Скрыть с сайта', `${item.hiddenOnSite ? 'Показать на сайте' : 'Скрыть с сайта'} блюдо «${item.name}»`]);
  if (!item.category) actionList.push(['place', '', 'На сайт', `Выбрать группу на сайте для блюда «${item.name}»`]);
  if (manualMenu || !item.source) actionList.push(['delete', 'delete-button', '', `Удалить блюдо «${item.name}»`]);
  else if (state.mode === 'site') actionList.push(['detach', 'detach-button', 'Убрать с сайта', `Убрать блюдо «${item.name}» с сайта, оставив на кассе`]);
  for (const [action, className, label, accessibleLabel] of actionList) {
    const button = element('button', className, label);
    button.type = 'button';
    button.dataset.itemAction = action;
    button.dataset.itemId = item.id;
    button.setAttribute('aria-label', accessibleLabel);
    if (action === 'delete') {
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('focusable', 'false');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M6 6l12 12M18 6L6 18');
      icon.append(path);
      button.append(icon);
    }
    button.disabled = state.busy || state.conflict || !state.loaded;
    actions.append(button);
  }
  body.append(actions);
  card.append(photo, body);
  return card;
}

function cashGroupForItem(item) {
  if (item.source?.provider !== 'kds') return null;
  return state.sourceCategories.find((entry) => entry.source.organizationId === item.source.organizationId
    && entry.source.externalId === item.source.groupExternalId) || null;
}

function cashGroupCard(group) {
  const descendants = categoryDescendantIds(state.sourceCategories, group.id);
  const count = state.items.filter((item) => descendants.has(cashGroupForItem(item)?.id)).length;
  const children = state.sourceCategories.filter((entry) => entry.parentId === group.id).length;
  const button = element('button', 'cash-group-card');
  button.type = 'button';
  button.dataset.cashGroupId = group.id;
  button.setAttribute('aria-label', `Открыть группу «${group.name}»`);
  const top = element('span', 'cash-group-top');
  const icon = element('span', 'cash-group-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = '<svg viewBox="0 0 32 32" fill="none"><path d="M4 10V7a2 2 0 0 1 2-2h7l3 4h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V10Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M4 12h24" stroke="currentColor" stroke-width="1.4"/></svg>';
  const arrow = element('span', 'cash-group-arrow', '↗');
  arrow.setAttribute('aria-hidden', 'true');
  top.append(icon, arrow);
  button.append(top, element('span', 'cash-group-name', group.name), element('span', 'cash-group-count',
    `${children ? `Подгрупп: ${children} · ` : ''}Блюд: ${count}`));
  return button;
}

function openCashGroup(id) {
  if (id !== null && !state.sourceCategories.some((entry) => entry.id === id)) return;
  state.cashGroupId = id;
  state.cashSearch = '';
  $('search').value = '';
  render();
}

function setMenuMode(mode) {
  if (!['site', 'cash'].includes(mode)) return;
  state[`${state.mode}Search`] = $('search').value;
  state.mode = mode;
  $('search').value = state[`${mode}Search`];
  render();
}

function renderCashBreadcrumbs() {
  const path = categoryPath(state.sourceCategories, state.cashGroupId);
  const nodes = [{ id: '', name: 'Меню кассы' }, ...path].map((entry, index) => {
    if (index === path.length) {
      const current = element('span', '', entry.name);
      current.setAttribute('aria-current', 'page');
      return current;
    }
    const button = element('button', '', entry.name);
    button.type = 'button'; button.dataset.cashGroupId = entry.id;
    return button;
  });
  $('cash-breadcrumbs').replaceChildren(...nodes);
  $('cash-back').hidden = !state.cashGroupId;
}

function render() {
  const cashMode = !manualMenu && state.mode === 'cash';
  $('add-dish').hidden = !manualMenu;
  $('add-dish').disabled = state.busy || !state.loaded || state.conflict;
  const query = $('search').value.trim().toLocaleLowerCase('ru');
  const categoryIds = categoryDescendantIds(state.categories, state.siteCategory);
  const cashIds = state.cashGroupId ? categoryDescendantIds(state.sourceCategories, state.cashGroupId)
    : new Set(state.sourceCategories.map((entry) => entry.id));
  let groups = [];
  let filtered;
  if (cashMode) {
    groups = orderedCategories(state.sourceCategories).filter((entry) => query
      ? cashIds.has(entry.id) && entry.name.toLocaleLowerCase('ru').includes(query)
      : entry.parentId === state.cashGroupId);
    filtered = state.items.filter((item) => {
      const group = cashGroupForItem(item);
      return group && (query ? cashIds.has(group.id) : group.id === state.cashGroupId);
    });
  } else filtered = state.items.filter((item) => categoryIds.has(item.category));
  filtered = filtered.filter((item) => `${item.name} ${item.description}`.toLocaleLowerCase('ru').includes(query))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ru'));
  $('mode-site').setAttribute('aria-pressed', String(!cashMode));
  $('mode-cash').setAttribute('aria-pressed', String(cashMode));
  $('category-tabs').hidden = cashMode;
  $('cash-navigation').hidden = !cashMode;
  $('manage-categories').hidden = cashMode;
  $('menu-toolbar').classList.toggle('is-cash', cashMode);
  $('search').placeholder = cashMode ? 'Найти в меню кассы' : 'Найти блюдо';
  for (const button of $('category-tabs').children) button.setAttribute('aria-pressed', String(button.dataset.categoryId === state.siteCategory));
  const group = state.sourceCategories.find((entry) => entry.id === state.cashGroupId);
  $('category-heading').textContent = cashMode ? group?.name || 'Меню кассы' : categoryLabel(state.siteCategory) || 'Группы сайта';
  $('category-context').textContent = cashMode ? query ? 'Поиск в этой группе и всех вложенных группах.'
    : 'Откройте группу или выберите блюдо для размещения на сайте.' : 'Все блюда группы, включая скрытые с сайта.';
  if (cashMode) renderCashBreadcrumbs();
  $('cash-groups').replaceChildren(...groups.map(cashGroupCard));
  $('cash-groups').hidden = !cashMode || groups.length === 0;
  $('menu-dish-grid').classList.toggle('is-cash', cashMode);
  $('results-count').textContent = state.loaded ? `${cashMode && groups.length ? `Групп: ${groups.length} · ` : ''}Блюд: ${filtered.length}` : 'Загружаем меню…';
  $('items').replaceChildren(...filtered.map(itemCard));
  $('empty-state').hidden = filtered.length !== 0 || groups.length !== 0 || !state.loaded;
  $('empty-title').textContent = query ? 'Ничего не нашлось' : cashMode ? 'В этой группе пока нет блюд' : 'В этой группе пока нет блюд';
  $('empty-description').textContent = query ? 'Попробуйте другое название или откройте другую группу.'
    : cashMode ? state.sourceCategories.length ? 'Вернитесь к предыдущей группе и выберите другую.' : 'Меню кассы пока не загружено.'
      : manualMenu ? 'Нажмите «Добавить блюдо», чтобы заполнить эту группу.' : 'Выберите блюдо во вкладке «На кассе» и укажите группу сайта.';
  $('empty-browse-cash').hidden = manualMenu || !!query || cashMode;
  $('empty-browse-cash').disabled = state.busy || state.conflict || !state.loaded;
}

async function loadMenu({ preserveDraft = false, announce = false } = {}) {
  if (state.busy) return false;
  setBusy(true);
  try {
    validateMenu(await api('menu'));
    state.conflict = false;
    $('editor-conflict').hidden = true;
    render();
    notice(preserveDraft ? 'Список обновлён. Проверьте открытый черновик перед сохранением.' : announce ? 'Меню обновлено.' : '');
    if (preserveDraft) {
      message($('editor-error'), 'Актуальное меню загружено. Ваш черновик сохранён — проверьте его перед повторным сохранением.');
    }
    return true;
  } catch (error) {
    if (!sessionExpired(error)) {
      notice(error.message, { error: true, refresh: true });
      if (preserveDraft) {
        message($('editor-error'), error.message);
        $('editor-conflict').hidden = false;
      }
    }
    return false;
  } finally {
    setBusy(false);
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
  $('logout-forget').hidden = auth.passwordOnly;
  await loadMenu({ preserveDraft: draft.resume });
  if (generation !== idle.generation || !idle.active || idle.suspended) return;
  if (draft.resume && state.csrfToken) {
    draft.resume = false;
    $('editor-dialog').showModal();
  } else if (categoryDraft.resume && state.csrfToken) {
    categoryDraft.resume = false;
    $('categories-dialog').showModal();
    if (categoryDraft.revision !== state.revision) showCategoryReopenNotice();
  }
}

function markConflict(text) {
  state.conflict = true;
  notice(text, { error: true, refresh: true });
  $('editor-conflict').hidden = false;
}

async function persist(items, { categories = state.categories } = {}) {
  try {
    validateMenu(await api('menu', { method: 'PUT', body: { items: items.map(({ keeperAvailability, ...item }) => item), categories, sourceCategories: state.sourceCategories, categoryMappings: [], revision: state.revision } }));
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

function openEditor(item) {
  if (state.busy || !state.loaded || state.conflict || (!item && !manualMenu) || (item && !state.items.some((entry) => entry.id === item.id))) return;
  const isNew = !item;
  if (isNew && !state.categories.length) { notice('Сначала добавьте группу для нового блюда.'); return; }
  item ??= { id: crypto.randomUUID(), category: state.siteCategory || state.categories[0]?.id };
  clearPreviewUrl();
  draft.id = item.id;
  draft.isNew = isNew;
  draft.image = item?.image || '';
  draft.file = null;
  draft.dirty = false;
  draft.resume = false;
  $('item-form').reset();
  $('item-name').value = item?.name || '';
  $('description').value = item?.description || '';
  $('price').value = item.price ?? '';
  const groupOptions = categoryOptions(state.categories, { placeholder: 'Не размещать на сайте' });
  $('category').replaceChildren(...(item.source ? groupOptions : groupOptions.slice(1)));
  $('category').value = item.category || '';
  $('show-on-site').checked = item.hiddenOnSite !== true;
  $('editor-source-note').hidden = manualMenu || item?.source?.provider !== 'kds';
  const keeperLabel = keeperAvailabilityLabel(item);
  const testNote = item.source?.testOnly ? 'Тестовое блюдо: только для просмотра, заказать его нельзя.' : '';
  $('editor-keeper-status').textContent = [testNote, keeperLabel ? `${keeperLabel}. Данные кассы обновляются кнопкой синхронизации.` : ''].filter(Boolean).join(' ');
  $('editor-keeper-status').hidden = manualMenu || (!keeperLabel && !testNote);
  $('category').disabled = false;
  $('category').required = !item.source;
  $('editor-title').textContent = isNew ? 'Добавить блюдо' : 'Редактировать блюдо';
  $('editor-eyebrow').textContent = 'ЗАБОТА О ДЕТАЛЯХ';
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

function categoryOptions(categories, { placeholder = '', exclude = new Set() } = {}) {
  const option = (value, label) => {
    const node = element('option', '', label);
    node.value = value;
    return node;
  };
  return [option('', placeholder), ...orderedCategories(categories).filter((entry) => !exclude.has(entry.id))
    .map((entry) => option(entry.id, categoryPath(categories, entry.id).map((parent) => parent.name).join(' / ')))];
}

function markCategoriesDirty() { categoryDraft.dirty = true; }

function refreshCategoryLabels() {
  // Keep the visible name and accessible movement labels consistent.
  for (const row of categoryControls.rows) {
    const category = categoryDraft.categories.find((entry) => entry.id === row.id);
    if (!category) continue;
    const name = category.name.trim() || 'Без названия';
    row.label.textContent = name;
    row.handle.setAttribute('aria-label', `Переместить группу «${name}»`);
    row.up.setAttribute('aria-label', `Переместить «${name}» выше`);
    row.down.setAttribute('aria-label', `Переместить «${name}» ниже`);
  }
}

function selectedCategory() {
  return categoryDraft.categories.find((entry) => entry.id === categoryDraft.selectedId);
}

function focusCategoryRow(id, action = 'select') {
  const row = categoryControls.rows.find((entry) => entry.id === id);
  const target = row?.[action];
  (target && !target.disabled ? target : row?.handle || $('new-category-name')).focus();
}

function reorderCategory(id, targetIndex, { focus = 'handle' } = {}) {
  if (state.busy) return;
  const entries = [...categoryDraft.categories].sort((a, b) => a.order - b.order);
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  const destination = Math.max(0, Math.min(entries.length - 1, targetIndex));
  if (destination === index) return;
  const [moved] = entries.splice(index, 1);
  entries.splice(destination, 0, moved);
  categoryDraft.categories = entries.map((entry, order) => ({ ...entry, parentId: null, order }));
  markCategoriesDirty();
  renderCategoryManager();
  $('group-sort-announcement').textContent = `«${moved.name}»: место ${destination + 1} из ${entries.length}. Сохраните группы, чтобы применить порядок.`;
  focusCategoryRow(id, focus);
}

function renderCategoryManager() {
  const entries = [...categoryDraft.categories].sort((a, b) => a.order - b.order);
  if (!selectedCategory()) categoryDraft.selectedId = entries[0]?.id || null;
  const selected = selectedCategory();
  categoryControls.rows = [];
  const rows = entries.map((entry, index) => {
    const row = element('li', 'category-sort-row');
    row.dataset.groupId = entry.id;
    row.classList.toggle('is-selected', entry.id === categoryDraft.selectedId);
    const handle = element('button', 'category-drag-handle', '⠿');
    handle.type = 'button'; handle.dataset.groupDrag = entry.id;
    handle.setAttribute('aria-describedby', 'group-sort-help');
    const select = element('button', 'category-sort-select');
    select.type = 'button'; select.dataset.groupSelect = entry.id;
    select.setAttribute('aria-pressed', String(entry.id === categoryDraft.selectedId));
    const label = element('span', 'category-sort-name', entry.name);
    const count = categoryDraft.items.filter((item) => item.category === entry.id).length;
    select.append(label, element('span', 'category-sort-count', `Блюд: ${count}`));
    const controls = element('div', 'category-sort-actions');
    const up = element('button', 'category-sort-arrow', '↑');
    const down = element('button', 'category-sort-arrow', '↓');
    for (const [button, direction] of [[up, -1], [down, 1]]) {
      button.type = 'button'; button.dataset.groupMove = entry.id; button.dataset.direction = String(direction);
    }
    up.disabled = index === 0; down.disabled = index === entries.length - 1;
    controls.append(up, down); row.append(handle, select, controls);
    categoryControls.rows.push({ id: entry.id, row, label, handle, select, up, down });
    return row;
  });
  $('category-sort-list').replaceChildren(...rows);
  $('category-sort-list').hidden = !entries.length;
  refreshCategoryLabels();
  $('delete-category').hidden = !selected;
  $('category-delete-panel').hidden = true;
  const count = categoryDraft.items.filter((item) => item.category === selected?.id).length;
  $('selected-category-count').textContent = selected ? `Блюд в группе: ${count}. Изменения применятся после сохранения.` : 'Добавьте первую группу для размещения блюд на сайте.';
  if (!selected) $('new-category-section').open = true;
}

function clearCategoryDrag() {
  if (!categoryDrag) return;
  const { pointerId, row } = categoryDrag;
  categoryDrag = null;
  row.classList.remove('is-dragging'); row.style.removeProperty('transform');
  for (const entry of categoryControls.rows) {
    entry.row.classList.remove('drop-before', 'drop-after');
  }
  if ($('category-sort-list').hasPointerCapture?.(pointerId)) $('category-sort-list').releasePointerCapture(pointerId);
}

function beginCategoryDrag(event) {
  const handle = event.target.closest('button[data-group-drag]');
  if (!handle || state.busy || (event.button !== undefined && event.button !== 0)) return;
  const entry = categoryControls.rows.find((row) => row.id === handle.dataset.groupDrag);
  if (!entry) return;
  clearCategoryDrag();
  const index = categoryControls.rows.indexOf(entry);
  categoryDrag = { id: entry.id, pointerId: event.pointerId, row: entry.row, startY: event.clientY, target: index, active: false };
  $('category-sort-list').setPointerCapture?.(event.pointerId);
  handle.focus();
  event.preventDefault();
}

function moveCategoryDrag(event) {
  if (!categoryDrag || event.pointerId !== categoryDrag.pointerId) return;
  const drag = categoryDrag;
  const distance = event.clientY - drag.startY;
  if (!drag.active && Math.abs(distance) < 5) return;
  drag.active = true;
  event.preventDefault();
  drag.row.classList.add('is-dragging');
  drag.row.style.transform = `translateY(${distance}px)`;
  const list = $('category-sort-list');
  const box = list.getBoundingClientRect();
  if (event.clientY < box.top + 30) list.scrollTop -= 12;
  else if (event.clientY > box.bottom - 30) list.scrollTop += 12;
  const others = categoryControls.rows.filter((entry) => entry.id !== drag.id);
  let target = others.findIndex((entry) => {
    const rect = entry.row.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2;
  });
  if (target < 0) target = others.length;
  drag.target = target;
  for (const entry of categoryControls.rows) entry.row.classList.remove('drop-before', 'drop-after');
  if (others[target]) others[target].row.classList.add('drop-before');
  else others.at(-1)?.row.classList.add('drop-after');
}

function finishCategoryDrag(event, cancelled = false) {
  if (!categoryDrag || event.pointerId !== categoryDrag.pointerId) return;
  const { id, target, active } = categoryDrag;
  clearCategoryDrag();
  if (active && !cancelled) reorderCategory(id, target);
}

function prepareCategoryDeletion() {
  if (state.busy || !selectedCategory()) return;
  const selected = selectedCategory();
  const items = categoryDraft.items.filter((item) => item.category === selected.id);
  const alternatives = categoryDraft.categories.filter((entry) => entry.id !== selected.id);
  const canDetach = !manualMenu && items.every((item) => item.source?.provider === 'kds');
  const options = categoryOptions(categoryDraft.categories, { placeholder: 'Выберите другую группу', exclude: new Set([selected.id]) });
  if (items.length && canDetach) {
    const detach = element('option', '', 'Убрать с сайта, оставить на кассе'); detach.value = '__cash__'; options.push(detach);
  }
  $('delete-category-destination').replaceChildren(...options);
  $('delete-category-destination').value = '';
  $('delete-category-destination-field').hidden = !items.length;
  $('delete-category-title').textContent = `Удалить «${selected.name.trim() || 'Без названия'}»?`;
  $('delete-category-description').textContent = `Блюд в группе: ${items.length}. Остальные группы останутся без изменений.`;
  const blocked = items.length && !canDetach && !alternatives.length;
  $('delete-category-help').textContent = manualMenu
    ? items.length ? alternatives.length ? 'Выберите другую группу для переноса блюд. Они останутся в меню.' : 'Сначала добавьте другую группу для переноса блюд или удалите блюда из этой группы.' : 'Группа будет удалена после нажатия «Сохранить группы».'
    : blocked
    ? 'Здесь есть блюда без связи с кассой. Сначала добавьте другую группу, чтобы перенести их и сохранить в меню.'
    : items.length && !canDetach ? 'Здесь есть блюда без связи с кассой: выберите другую группу для переноса. Блюда сохранят свои настройки публикации.'
      : items.length ? 'Перенесите блюда в другую группу или уберите их с сайта. На кассе блюда останутся.'
        : 'Группа будет удалена только после нажатия «Сохранить группы».';
  $('confirm-delete-category').disabled = !!blocked || items.length > 0;
  $('category-delete-panel').hidden = false;
  if (items.length && !blocked) $('delete-category-destination').focus();
  else $('cancel-delete-category').focus();
}

function deleteSelectedCategory() {
  if (state.busy || $('category-delete-panel').hidden) return;
  const selected = selectedCategory();
  if (!selected) return;
  const items = categoryDraft.items.filter((item) => item.category === selected.id);
  const destination = $('delete-category-destination').value;
  const targetExists = categoryDraft.categories.some((entry) => entry.id !== selected.id && entry.id === destination);
  const canDetach = destination === '__cash__' && items.every((item) => item.source?.provider === 'kds');
  if (items.length && !targetExists && !canDetach) {
    message($('categories-error'), 'Выберите другую группу для блюд. Удаление не должно оставлять их без места в меню.');
    return;
  }
  categoryDraft.items = categoryDraft.items.map((item) => item.category !== selected.id ? item : canDetach
    ? { ...item, category: null, published: false, availableForOrder: false } : { ...item, category: destination });
  categoryDraft.categories = categoryDraft.categories.filter((entry) => entry.id !== selected.id)
    .map((entry, order) => ({ ...entry, parentId: null, order }));
  categoryDraft.selectedId = targetExists ? destination : null;
  markCategoriesDirty();
  message($('categories-error'), '');
  renderCategoryManager();
  focusCategoryRow(categoryDraft.selectedId);
}

function showCategoryReopenNotice(prefix = 'Меню обновилось.') {
  message($('categories-error'), `${prefix} Закройте это окно и снова нажмите «Редактировать группы», чтобы увидеть сохранённый список.`);
}

function resetCategoryManager() {
  clearCategoryDrag();
  categoryDraft.categories = orderedCategories(state.categories).filter((category) => !category.source).map((category, order) => ({ ...category, parentId: null, order }));
  categoryDraft.items = state.items.map((item) => ({ ...item }));
  categoryDraft.selectedId = state.siteCategory;
  categoryDraft.revision = state.revision;
  categoryDraft.dirty = false;
  categoryDraft.resume = false;
  $('new-category-name').value = '';
  message($('categories-error'), '');
  renderCategoryManager();
}

function openCategoryManager() {
  if (state.busy || !state.loaded || state.conflict) return;
  resetCategoryManager();
  $('categories-dialog').showModal();
  focusCategoryRow(categoryDraft.selectedId);
}

function closeCategoryManager() {
  if (state.busy) return;
  if (categoryDraft.dirty && !window.confirm('Закрыть группы? Несохранённые изменения будут потеряны.')) return;
  clearCategoryDrag();
  categoryDraft.dirty = false;
  categoryDraft.resume = false;
  $('categories-dialog').close();
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
    if (auth.passwordOnly && data.authMode === 'password' && data.passwordChangeRequired === true && /^[a-f0-9]{64}$/.test(data.passwordToken || '')) {
      clearChallenge(); showNewPassword(data.passwordToken, username, true);
    } else if (auth.passwordOnly && data.authMode === 'password' && data.authenticated === true && typeof data.csrfToken === 'string' && data.csrfToken) {
      acceptSessionTiming(data, { initial: true });
      clearLockMarker(); state.csrfToken = data.csrfToken;
      await enterDashboard();
    } else if (!auth.passwordOnly && data.enrollmentRequired === true && typeof data.challengeToken === 'string' && data.challengeToken) {
      showEnrollment(data);
    } else if (!auth.passwordOnly && data.mfaRequired === true && typeof data.challengeToken === 'string' && data.challengeToken) {
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
    else if (!$('reset-password-form').hidden) $('reset-password').focus();
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

$('empty-browse-cash').addEventListener('click', () => setMenuMode('cash'));
$('manage-categories').addEventListener('click', async () => {
  if (state.busy || !state.loaded || $('categories-dialog').open) return;
  if (await loadMenu()) openCategoryManager();
});
$('close-categories').addEventListener('click', closeCategoryManager);
$('cancel-categories').addEventListener('click', closeCategoryManager);
$('categories-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeCategoryManager(); });
$('category-sort-list').addEventListener('click', (event) => {
  if (state.busy) return;
  const move = event.target.closest('button[data-group-move]');
  if (move) {
    const index = categoryControls.rows.findIndex((row) => row.id === move.dataset.groupMove);
    reorderCategory(move.dataset.groupMove, index + Number(move.dataset.direction), { focus: Number(move.dataset.direction) < 0 ? 'up' : 'down' });
    return;
  }
  const select = event.target.closest('button[data-group-select]');
  if (!select) return;
  categoryDraft.selectedId = select.dataset.groupSelect;
  message($('categories-error'), ''); renderCategoryManager();
  focusCategoryRow(categoryDraft.selectedId);
});
$('category-sort-list').addEventListener('keydown', (event) => {
  const handle = event.target.closest('button[data-group-drag]');
  if (!handle || !['ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Escape') { clearCategoryDrag(); return; }
  const index = categoryControls.rows.findIndex((row) => row.id === handle.dataset.groupDrag);
  const target = event.key === 'Home' ? 0 : event.key === 'End' ? categoryControls.rows.length - 1 : index + (event.key === 'ArrowUp' ? -1 : 1);
  reorderCategory(handle.dataset.groupDrag, target);
});
$('category-sort-list').addEventListener('pointerdown', beginCategoryDrag);
$('category-sort-list').addEventListener('pointermove', moveCategoryDrag);
$('category-sort-list').addEventListener('pointerup', (event) => finishCategoryDrag(event));
$('category-sort-list').addEventListener('pointercancel', (event) => finishCategoryDrag(event, true));
$('category-sort-list').addEventListener('lostpointercapture', (event) => finishCategoryDrag(event, true));
$('delete-category').addEventListener('click', prepareCategoryDeletion);
$('delete-category-destination').addEventListener('change', () => {
  const selected = selectedCategory();
  const items = categoryDraft.items.filter((item) => item.category === selected?.id);
  const destination = $('delete-category-destination').value;
  $('confirm-delete-category').disabled = !selected || !(categoryDraft.categories.some((entry) => entry.id !== selected.id && entry.id === destination)
    || (destination === '__cash__' && items.every((item) => item.source?.provider === 'kds')));
});
$('cancel-delete-category').addEventListener('click', () => {
  $('category-delete-panel').hidden = true; $('delete-category').focus();
});
$('confirm-delete-category').addEventListener('click', deleteSelectedCategory);
$('new-category-name').addEventListener('input', markCategoriesDirty);
function appendNewCategory({ focus = true } = {}) {
  if (state.busy) return false;
  const name = $('new-category-name').value.trim();
  if (!name || name.length > 160) {
    message($('categories-error'), 'Введите название новой группы — до 160 символов.');
    $('new-category-name').focus();
    return false;
  }
  if (categoryDraft.categories.length >= 100) {
    message($('categories-error'), 'В меню может быть не больше 100 групп.');
    return false;
  }
  const parentId = null;
  if (categoryDraft.categories.some((entry) => entry.parentId === parentId && entry.name.trim().toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) {
    message($('categories-error'), 'Группа с таким названием здесь уже есть. Выберите другое название.');
    $('new-category-name').focus();
    return false;
  }
  const category = { id: `site-${crypto.randomUUID()}`, name, parentId,
    order: Math.min(100000, Math.max(0, ...categoryDraft.categories.map((entry) => entry.order)) + 1) };
  try { normalizeMenuCategories([...categoryDraft.categories, category]); }
  catch { message($('categories-error'), 'Проверьте название новой группы.'); return false; }
  categoryDraft.categories.push(category);
  categoryDraft.selectedId = category.id;
  $('new-category-name').value = '';
  markCategoriesDirty();
  message($('categories-error'), '');
  renderCategoryManager();
  if (focus) $('new-category-name').focus();
  return true;
}
$('add-category').addEventListener('click', () => appendNewCategory());
$('categories-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.busy || state.conflict || !state.loaded) return;
  if (categoryDraft.revision !== state.revision) {
    showCategoryReopenNotice();
    return;
  }
  if ($('new-category-name').value.trim() && !appendNewCategory({ focus: false })) return;
  if (!categoryDraft.dirty) { $('categories-dialog').close(); return; }
  let categories;
  try { categories = normalizeMenuCategories(categoryDraft.categories.map((entry, order) => ({ ...entry, parentId: null, order }))); }
  catch { message($('categories-error'), 'Проверьте названия групп. Каждой группе нужно непустое название.'); return; }
  setBusy(true);
  message($('categories-error'), '');
  try {
    await persist(categoryDraft.items, { categories });
    categoryDraft.dirty = false;
    $('categories-dialog').close();
    notice('Группы сайта сохранены.');
  } catch (error) {
    sessionExpired(error);
    if (state.conflict) showCategoryReopenNotice(error.status === 0 ? 'Ответ о сохранении не получен.' : 'Меню обновилось.');
    else message($('categories-error'), error.message);
  } finally { setBusy(false); }
});
$('category-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-category-id]');
  if (!button) return;
  state.siteCategory = button.dataset.categoryId;
  render();
});
$('add-dish').addEventListener('click', () => openEditor());
$('sync-availability').addEventListener('click', async () => {
  if (manualMenu) return;
  if (state.busy || !state.loaded || state.conflict || !state.keeperSync.configured) return;
  state.syncing = true;
  setBusy(true);
  try {
    validateMenu(await api('sync-availability', { method: 'POST', body: {} }));
    render();
    notice('Стоп-лист и остатки обновлены.');
  } catch (error) {
    if (!sessionExpired(error)) notice(error.message, { error: true });
  } finally {
    state.syncing = false;
    setBusy(false);
  }
});
$('mode-site').addEventListener('click', () => setMenuMode('site'));
$('mode-cash').addEventListener('click', () => setMenuMode('cash'));
for (const id of ['cash-groups', 'cash-breadcrumbs']) $(id).addEventListener('click', (event) => {
  const button = event.target.closest('button[data-cash-group-id]');
  if (button) openCashGroup(button.dataset.cashGroupId || null);
});
$('cash-back').addEventListener('click', () => openCashGroup(state.sourceCategories.find((entry) => entry.id === state.cashGroupId)?.parentId || null));
$('search').addEventListener('input', render);
$('refresh').addEventListener('click', () => loadMenu({ announce: true }));
$('retry-load').addEventListener('click', () => loadMenu({ announce: true }));
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
  if (!(manualMenu && draft.isNew) && !state.items.some((item) => item.id === draft.id)) {
    message($('editor-error'), 'Это блюдо больше недоступно в меню. Обновите список и выберите блюдо снова.');
    return;
  }
  const existingItem = state.items.find((entry) => entry.id === draft.id);
  const selectedCategory = $('category').value;
  if ((!selectedCategory && !existingItem?.source)
    || (selectedCategory && !state.categories.some((entry) => !entry.source && entry.id === selectedCategory))) {
    message($('editor-error'), 'Выберите группу блюда. Возможно, список групп был обновлён.');
    $('category').focus();
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
      ...(existingItem?.source ? { source: existingItem.source } : {}),
      id: draft.id, name, description: $('description').value.trim(), price: Number($('price').value),
      category: selectedCategory || null, image: draft.image, hiddenOnSite: !$('show-on-site').checked, published: !!selectedCategory && $('show-on-site').checked,
      availableForOrder: !!selectedCategory && $('show-on-site').checked && existingItem?.source?.testOnly !== true, order: existingItem?.order ?? Math.max(0, ...state.items.map(entry => entry.order)) + 1,
    };
    const items = draft.isNew ? [...state.items, item] : state.items.map((entry) => entry.id === item.id ? item : entry);
    await persist(items);
    draft.dirty = false;
    clearPreviewUrl();
    $('editor-dialog').close();
    notice(item.hiddenOnSite ? `«${name}» сохранено. Скрыто с сайта, доступно в админке.` : manualMenu ? `«${name}» сохранено${item.category ? '. Видно на сайте.' : '.'}` : !item.category ? `«${name}» сохранено в меню кассы. На сайте блюдо не размещено.` : item.source?.testOnly
      ? `«${name}» сохранено для просмотра. Тестовые блюда заказать нельзя.` : item.availableForOrder
      ? `«${name}» сохранено. Видно на сайте и можно заказать.`
      : `«${name}» сохранено. Видно на сайте, временно недоступно для заказа.`);
  } catch (error) {
    sessionExpired(error);
    message($('editor-error'), error.status === 409 ? 'Не удалось сохранить: меню уже изменилось. Ваш черновик остался в форме.' : error.message);
  } finally {
    setBusy(false);
  }
});

$('items').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-item-action]');
  if (!button || state.busy || state.conflict) return;
  const item = state.items.find((entry) => entry.id === button.dataset.itemId);
  if (!item) return;
  if (button.dataset.itemAction === 'edit') return openEditor(item);
  if (button.dataset.itemAction === 'place') { openEditor(item); $('category').focus(); return; }
  if (button.dataset.itemAction === 'visibility' && item.category) {
    const hiddenOnSite = item.hiddenOnSite !== true;
    setBusy(true);
    try {
      await persist(state.items.map(entry => entry.id === item.id ? { ...entry, hiddenOnSite } : entry));
      notice(hiddenOnSite ? `«${item.name}» скрыто с сайта. Блюдо осталось в этой группе в админке.` : `«${item.name}» снова видно на сайте.`);
    } catch (error) {
      if (!sessionExpired(error) && !state.conflict) notice(error.message, { error: true });
    } finally {
      setBusy(false);
    }
    $('items').querySelector(`[data-item-id="${item.id}"][data-item-action="visibility"]`)?.focus();
    return;
  }
  if (button.dataset.itemAction === 'delete' || button.dataset.itemAction === 'detach') {
    if (!manualMenu && item.source && state.mode !== 'site') return;
    deleteId = item.id;
    $('delete-title').textContent = !manualMenu && item.source ? 'Убрать блюдо с сайта?' : 'Удалить блюдо?';
    $('confirm-delete').textContent = !manualMenu && item.source ? 'Убрать с сайта' : 'Удалить';
    $('delete-description').textContent = !manualMenu && item.source ? `«${item.name}» исчезнет из группы сайта и останется в своей группе во вкладке «На кассе». Его можно будет разместить снова.`
      : `«${item.name}» будет удалено из меню. Если блюдо ещё пригодится, его можно просто скрыть с сайта.`;
    message($('delete-error'), '');
    $('delete-dialog').showModal();
    return;
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
    await persist(!manualMenu && item.source ? state.items.map((entry) => entry.id === deleteId
      ? { ...entry, category: null, published: false, availableForOrder: false } : entry) : state.items.filter((entry) => entry.id !== deleteId));
    $('delete-dialog').close();
    notice(!manualMenu && item.source ? `«${item.name}» убрано с сайта и осталось в меню кассы.` : `«${item.name}» удалено из меню.`);
    $('search').focus();
  } catch (error) {
    if (state.conflict) $('delete-dialog').close();
    else message($('delete-error'), error.message);
  } finally {
    setBusy(false);
  }
});

window.addEventListener('beforeunload', (event) => {
  if (auth.recoveryPending || auth.enrollmentToken || (draft.dirty && ($('editor-dialog').open || draft.resume))
    || (categoryDraft.dirty && ($('categories-dialog').open || categoryDraft.resume))) {
    event.preventDefault();
    event.returnValue = '';
  }
});

window.addEventListener('pagehide', () => {
  const savedReset = readPasswordReset();
  // A back/forward cache entry must never retain a QR secret or one-time recovery list.
  if (auth.enrollmentPhase || auth.challengeToken || auth.busy || !$('reset-request-form').hidden || !$('reset-code-form').hidden || passwordReset.token || passwordReset.passwordToken) showLogin();
  else clearChallenge();
  // Preserve only an outstanding mail request when visiting email/reloading.
  if (savedReset) {
    try { globalThis.sessionStorage?.setItem(RESET_STORAGE_KEY, JSON.stringify(savedReset)); } catch { /* Optional. */ }
  }
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
  clearCategoryDrag();
  categoryDraft.resume = categoryDraft.resume || $('categories-dialog').open;
  $('categories-dialog').close();
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
        else if (categoryDraft.resume && state.loaded) { categoryDraft.resume = false; $('categories-dialog').showModal(); }
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
window.addEventListener('pageshow', () => {
  if (!auth.busy && !$('login-form').hidden) resumePasswordReset(readPasswordReset());
  updateResetResend();
  return checkVisibleSession();
});

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
