// Shared across all pages. Choosing cookies never loads an external service.
const KEY = 'vosem_cookie_choice';
const VERSION = '2026-09-21-cookies1';
const LIFETIME = 180 * 24 * 60 * 60 * 1000;
let memory = null, storageAvailable = true, pending = null, returnFocus = null;
const listeners = new Set();
function readChoice() {
  let value = memory;
  if (storageAvailable) {
    try { value = JSON.parse(localStorage.getItem(KEY)); }
    catch { storageAvailable = false; }
  }
  if (!value || value.version !== VERSION || !['all','necessary'].includes(value.choice) ||
      !Number.isFinite(value.at) || value.at > Date.now() || Date.now() - value.at >= LIFETIME) return null;
  return value;
}
let notifiedAllowed = readChoice()?.choice === 'all';
const banner = document.createElement('section');
banner.className = 'cookie-banner';
banner.hidden = true;
banner.setAttribute('aria-label','Настройки cookie');
banner.innerHTML = `
  <div class="cookie-banner-copy">
    <p id="cookie-banner-title" class="cookie-banner-title" tabindex="-1">Немного о cookie</p>
    <p>Используем технические cookie. С вашего согласия при регистрации — Google reCAPTCHA: IP-адрес, данные браузера и cookie. <a href="privacy.html#cookies" target="_blank" rel="noopener">Подробнее<span class="visually-hidden"> (в новой вкладке)</span></a></p>
    <p class="cookie-banner-status" role="status" aria-live="polite"></p>
  </div>
  <div class="cookie-banner-actions">
    <button type="button" data-cookie-choice="all">Принять</button>
    <button type="button" data-cookie-choice="necessary">Только необходимые</button>
    <button type="button" class="cookie-banner-close" hidden>Закрыть</button>
  </div>`;
document.body.appendChild(banner);
const title = banner.querySelector('.cookie-banner-title');
const status = banner.querySelector('.cookie-banner-status');
const close = banner.querySelector('.cookie-banner-close');
function hide() {
  const restore = banner.contains(document.activeElement);
  banner.hidden = true;
  document.documentElement.classList.remove('cookie-notice-open');
  document.documentElement.style.removeProperty('--cookie-banner-space');
  if (restore && returnFocus?.isConnected) returnFocus.focus({preventScroll:true});
  returnFocus = null;
}
function updateSpace() {
  // Enough room to scroll the footer above the notice; nothing locks page scrolling.
  if (!banner.hidden) document.documentElement.style.setProperty('--cookie-banner-space',`${banner.offsetHeight + 32}px`);
}
function show({focus = false, registration = false} = {}) {
  registration = registration || Boolean(pending);
  if (banner.hidden || focus) returnFocus = document.activeElement;
  close.hidden = !readChoice() && !registration;
  status.textContent = registration
    ? 'Для онлайн-регистрации нужна проверка Google. Без неё можно вступить в клуб в кофейне.' : '';
  banner.hidden = false;
  document.documentElement.classList.add('cookie-notice-open');
  updateSpace();
  if (focus) title.focus({preventScroll:true});
}
function finishChoice(allowed) {
  const resolve = pending; pending = null;
  if (resolve) resolve(allowed);
}
function notify() {
  const allowed = readChoice()?.choice === 'all';
  if (allowed === notifiedAllowed) return;
  notifiedAllowed = allowed;
  listeners.forEach(fn => fn(allowed));
}
function save(choice) {
  memory = {version:VERSION,choice,at:Date.now()};
  try { localStorage.setItem(KEY,JSON.stringify(memory)); }
  catch { storageAvailable = false; }
  hide(); notify(); finishChoice(choice === 'all');
}
banner.querySelectorAll('[data-cookie-choice]').forEach(button => {
  button.addEventListener('click',() => save(button.dataset.cookieChoice));
});
close.addEventListener('click',() => { hide(); finishChoice(false); });
banner.addEventListener('keydown',event => {
  if (event.key === 'Escape' && !close.hidden) { hide(); finishChoice(false); }
});
document.querySelectorAll('[data-cookie-settings]').forEach(button => {
  button.hidden = false;
  button.addEventListener('click',() => show({focus:true}));
});
if ('ResizeObserver' in window) new ResizeObserver(updateSpace).observe(banner);
window.addEventListener('resize',updateSpace);
window.addEventListener('storage',event => {
  if (event.key !== KEY && event.key !== null) return;
  memory = null;
  // An acceptance in another tab must not submit this tab's waiting form.
  finishChoice(false); notify();
  if (readChoice()) hide(); else show();
});
function refresh() {
  notify();
  if (!readChoice()) show();
}
window.addEventListener('pageshow',refresh);
document.addEventListener('visibilitychange',() => { if (!document.hidden) refresh(); });
if (!readChoice()) show();
export const cookieConsent = {
  allowed: () => readChoice()?.choice === 'all',
  request: () => {
    if (readChoice()?.choice === 'all') return Promise.resolve(true);
    if (pending) return Promise.resolve(false);
    show({focus:true,registration:true});
    return new Promise(resolve => { pending = resolve; });
  },
  subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }
};
