'use strict';
const form = document.getElementById('registration-form');
const submit = document.getElementById('submit-button');
const message = document.getElementById('form-message');
const dateInput = document.getElementById('birth-date');
const phone = document.getElementById('phone');
const now = new Date();
dateInput.max = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
let sending = false;
let csrf = '';
let captchaWidget = null;
let captchaLoading = false;
let captchaMode = 'checkbox';
let captchaPending = null;
function finishCaptcha(token, error) {
  if (!captchaPending) return;
  const pending = captchaPending;
  captchaPending = null;
  clearTimeout(pending.timer);
  if (error) pending.reject(error); else pending.resolve(token);
}
function requestCaptchaToken() {
  if (captchaWidget === null) return Promise.reject(new Error('captcha_not_ready'));
  if (captchaMode !== 'invisible') return Promise.resolve(window.grecaptcha.getResponse(captchaWidget));
  return new Promise((resolve,reject) => {
    captchaPending = {resolve,reject,timer:setTimeout(() => finishCaptcha('',new Error('captcha_timeout')),120000)};
    try { window.grecaptcha.reset(captchaWidget); window.grecaptcha.execute(captchaWidget); }
    catch { finishCaptcha('',new Error('captcha_failed')); }
  });
}
function loadCaptcha(siteKey, mode) {
  if (captchaLoading) return;
  captchaMode = mode === 'invisible' ? 'invisible' : 'checkbox';
  form.classList.toggle('invisible-captcha',captchaMode === 'invisible');
  const status = document.getElementById('captcha-status');
  if (!siteKey) { status.textContent = 'Проверка «Я не робот» временно недоступна. Попробуйте позже.'; return; }
  captchaLoading = true;
  const fail = () => { status.textContent = 'Не удалось загрузить проверку. Обновите страницу и попробуйте ещё раз.'; finishCaptcha('',new Error('captcha_failed')); };
  const timeout = setTimeout(fail,15000);
  window.onLoyaltyCaptchaLoad = () => {
    clearTimeout(timeout);
    try {
      captchaWidget = window.grecaptcha.render('recaptcha-widget', {
        sitekey:siteKey, theme:'light', size:captchaMode === 'invisible' ? 'invisible' : 'compact', badge:'bottomright',
        callback:token => { status.textContent = ''; finishCaptcha(token); },
        'expired-callback':() => { status.textContent = 'Проверка истекла. Повторите проверку перед отправкой.'; finishCaptcha('',new Error('captcha_expired')); },
        'error-callback':fail
      });
      status.textContent = '';
    } catch { fail(); }
  };
  const script = document.createElement('script');
  script.src = 'https://www.google.com/recaptcha/api.js?onload=onLoyaltyCaptchaLoad&render=explicit&hl=ru';
  script.async = true; script.defer = true;
  script.onerror = () => { clearTimeout(timeout); fail(); };
  document.head.appendChild(script);
}
function showMessage(text) { message.textContent = text; message.hidden = false; }
function normalizedPhone(value) {
  let digits = value.replace(/\D/g, '');
  if (digits.length === 10) digits = '7' + digits;
  if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
  return /^7\d{10}$/.test(digits) ? '+' + digits : null;
}
function formatPhone(digits) {
  if (!digits) return '';
  let text = '+7 (' + digits.slice(0,3);
  if (digits.length > 3) text += ') ' + digits.slice(3,6);
  if (digits.length > 6) text += '-' + digits.slice(6,8);
  if (digits.length > 8) text += '-' + digits.slice(8,10);
  return text;
}
function phoneCaret(text, count) {
  if (!text) return 0;
  if (count <= 0) return 4;
  let seen = 0;
  for (let i = 4; i < text.length; i++) {
    if (/\d/.test(text[i]) && ++seen === count) return i + 1;
  }
  return text.length;
}
function applyPhoneMask() {
  const raw = phone.value;
  const caret = phone.selectionStart ?? raw.length;
  let digits = raw.replace(/\D/g,'');
  const hasPrefix = /^\s*\+7/.test(raw) || /^[78]/.test(digits) && (digits.length === 11 || digits.length < 10);
  let before = raw.slice(0,caret).replace(/\D/g,'').length;
  if (hasPrefix) { digits = digits.slice(1); before = Math.max(0,before - 1); }
  phone.value = formatPhone(digits.slice(0,10));
  const position = phoneCaret(phone.value,before);
  phone.setSelectionRange(position,position);
  phone.setCustomValidity('');
}
phone.addEventListener('input', applyPhoneMask);
phone.addEventListener('beforeinput', event => {
  // Delete digits across formatting characters without trapping the cursor.
  if (!event.cancelable || !['deleteContentBackward','deleteContentForward'].includes(event.inputType)) return;
  const start = phone.selectionStart, end = phone.selectionEnd;
  if (start !== end || start === null || !phone.value.startsWith('+7 (')) return;
  const positions = [...phone.value].map((c,i) => i >= 4 && /\d/.test(c) ? i : -1).filter(i => i >= 0);
  const backward = event.inputType === 'deleteContentBackward';
  const index = backward ? positions.filter(i => i < start).pop() : positions.find(i => i >= start);
  event.preventDefault();
  if (index === undefined) return;
  const digitIndex = positions.indexOf(index);
  const digits = positions.map(i => phone.value[i]);
  digits.splice(digitIndex,1);
  phone.value = formatPhone(digits.join(''));
  const position = phoneCaret(phone.value,digitIndex);
  phone.setSelectionRange(position,position);
  phone.setCustomValidity('');
});
phone.addEventListener('blur', applyPhoneMask);
async function getToken() {
  const r = await fetch('api/register.php', {credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
  const data = await r.json();
  if (!r.ok || typeof data.csrf !== 'string') throw new Error('token');
  csrf = data.csrf;
  loadCaptcha(data.recaptchaSiteKey,data.recaptchaMode);
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (sending) return;
  for (const name of ['LastName','FirstName']) {
    const field = form.elements.namedItem(name);
    field.value = field.value.trim();
  }
  const number = normalizedPhone(phone.value);
  phone.setCustomValidity(number ? '' : 'Введите номер телефона: +7 и 10 цифр.');
  if (!form.reportValidity()) return;
  sending = true; submit.disabled = true; submit.textContent = 'Регистрируем…';
  form.setAttribute('aria-busy','true'); message.hidden = true;
  let posted = false;
  try {
    if (location.protocol === 'file:') { showMessage('Откройте страницу на сайте, чтобы зарегистрироваться.'); return; }
    if (!csrf) await getToken();
    submit.textContent = 'Проверяем…';
    let captchaToken;
    try { captchaToken = await requestCaptchaToken(); }
    catch { showMessage('Не удалось завершить проверку. Попробуйте ещё раз или обновите страницу.'); return; }
    if (!captchaToken) { showMessage('Пройдите проверку «Я не робот» перед регистрацией.'); return; }
    submit.textContent = 'Регистрируем…';
    const values = new FormData(form);
    const payload = {Email:'', Phone:number, Consent:values.get('Consent') === 'on', RecaptchaToken:captchaToken};
    for (const name of ['LastName','FirstName','MiddleName','BirthDate','Comment']) payload[name] = String(values.get(name) || '').trim();
    posted = true;
    const response = await fetch('api/register.php', {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(payload)});
    const data = await response.json();
    if (response.ok && data.IsSuccess === true) {
      form.reset(); form.hidden = true;
      document.querySelector('h1').textContent = 'Добро пожаловать!';
      document.querySelector('.intro').hidden = true;
      const success = document.getElementById('registration-success');
      success.hidden = false; success.focus();
    } else {
      if (response.status === 403) csrf = '';
      showMessage(typeof data.Message === 'string' && data.Message.trim() ? data.Message : 'Регистрация не завершена. Попробуйте позже.');
    }
  } catch {
    showMessage(posted ? 'Не удалось получить подтверждение регистрации. Возможно, данные уже приняты. Уточните у кофейни перед повторной отправкой.' : 'Не удалось подключиться к регистрации. Попробуйте позже.');
  } finally {
    if ((posted || captchaMode === 'invisible') && captchaWidget !== null) window.grecaptcha.reset(captchaWidget);
    sending = false; submit.disabled = false; submit.textContent = 'Зарегистрироваться'; form.removeAttribute('aria-busy');
  }
});
document.getElementById('captcha-status').textContent = 'Это публичный предпросмотр. Отправка формы будет подключена после переноса серверной части.';
submit.disabled = true;
submit.textContent = 'Регистрация временно недоступна';
