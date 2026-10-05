'use strict';
import { cookieConsent } from './cookies.js?v=20260921-reg3';
import { PhoneVerification } from './phone-verification.js?v=20261002-1';
const form = document.getElementById('registration-form');
const submit = document.getElementById('submit-button');
const message = document.getElementById('form-message');
const dateInput = document.getElementById('birth-date');
const phone = document.getElementById('phone');
const captchaStatus = document.getElementById('captcha-status');
const consentVersion = form.elements.namedItem('ConsentVersion').value;
const now = new Date();
dateInput.max = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
let sending = false, csrf = '', captchaWidget = null, captchaMode = 'checkbox';
let captchaAllowed = false, captchaPromise = null, captchaPending = null, uncertain = false;
let googleStarted = false, stopping = false, permissionWithdrawn = false, postedOnce = false, confirmed = false;
let recaptchaRequired = form.dataset.phoneTest !== 'true';
function sessionError(text) { const error = new Error(text); error.userMessage = true; return error; }
const phoneCheck = new PhoneVerification({ document, request: async payload => {
  const response = await request('api/register.php',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json','X-CSRF-Token':csrf},body:JSON.stringify(payload)});
  const data = await response.json();
  if (!response.ok || data.IsSuccess !== true) {
    const error = new Error(data.Message || 'Не удалось подтвердить телефон. Попробуйте ещё раз.');
    error.retryAfter = Number(data.retryAfter) || 0; error.userMessage = true;
    if (error.retryAfter > 0) error.message += ` Повторный звонок будет доступен через ${Math.ceil(error.retryAfter/60)} мин.`;
    throw error;
  }
  return data;
} });
phoneCheck.configure(form.dataset.phoneVerification === 'true',form.dataset.phoneTest === 'true');
document.getElementById('captcha-privacy').hidden = !recaptchaRequired;
document.getElementById('captcha-notice').hidden = !recaptchaRequired;
function submitLabel() { return uncertain ? 'Уточните результат у кофейни' : phoneCheck.required ? phoneCheck.challenge ? 'Подтвердить и зарегистрироваться' : 'Подтвердить номер' : 'Зарегистрироваться'; }
submit.textContent = submitLabel();
function showMessage(text) { message.textContent = text; message.hidden = false; }
function showSuccess(test = false) {
  form.reset(); form.hidden = true;
  document.querySelector('h1').textContent = 'Добро пожаловать!';
  document.querySelector('.intro').hidden = true;
  document.querySelector('.required-help').hidden = true;
  const success = document.getElementById('registration-success'); success.hidden = false; success.focus();
  if (test) {
    document.querySelector('h1').textContent = 'Номер подтверждён';
    success.querySelector('h2').textContent = 'Проверка прошла успешно';
    success.querySelector('p').textContent = 'Это тест: анкета не отправлена в FlexBonus, бонусы не начислялись.';
  }
  phoneCheck.dispose();
}
function requirePermission() {
  if (stopping || (recaptchaRequired && (permissionWithdrawn || !cookieConsent.allowed()))) throw new Error('consent_revoked');
}
async function request(url, options = {}, timeout = 50000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try { return await fetch(url,{credentials:'same-origin',cache:'no-store',...options,signal:controller.signal}); }
  finally { clearTimeout(timer); }
}
function finishCaptcha(token, error) {
  if (!captchaPending) return;
  const pending = captchaPending; captchaPending = null; clearTimeout(pending.timer);
  if (error) pending.reject(error); else pending.resolve(token);
}
function loadCaptcha(siteKey, mode) {
  requirePermission();
  if (captchaPromise) return captchaPromise;
  captchaMode = mode === 'invisible' ? 'invisible' : 'checkbox';
  form.classList.toggle('invisible-captcha',captchaMode === 'invisible');
  captchaPromise = new Promise((resolve,reject) => {
    let settled = false;
    const fail = () => {
      captchaStatus.textContent = 'Не удалось загрузить проверку. Повторите попытку или свяжитесь с кофейней.';
      finishCaptcha('',new Error('captcha_failed'));
      if (!settled) { settled = true; clearTimeout(timer); script.remove(); reject(new Error('captcha_failed')); }
    };
    const timer = setTimeout(fail,15000);
    const script = document.createElement('script');
    window.onLoyaltyCaptchaLoad = () => {
      if (settled) return;
      try {
        requirePermission();
        captchaWidget = window.grecaptcha.render('recaptcha-widget',{
          sitekey:siteKey,theme:'light',size:captchaMode === 'invisible' ? 'invisible' : 'compact',badge:'bottomright',
          callback:token => { captchaStatus.textContent = ''; finishCaptcha(token); },
          'expired-callback':() => { captchaStatus.textContent = 'Проверка истекла. Пройдите её повторно.'; finishCaptcha('',new Error('expired')); },
          'error-callback':fail
        });
        if (!settled) { settled = true; clearTimeout(timer); resolve(); }
      } catch { fail(); }
    };
    script.src = 'https://www.recaptcha.net/recaptcha/api.js?onload=onLoyaltyCaptchaLoad&render=explicit&hl=ru';
    script.async = true; script.defer = true; script.onerror = fail;
    googleStarted = true;
    document.head.appendChild(script);
  }).catch(error => { captchaPromise = null; throw error; });
  return captchaPromise;
}
async function getToken() {
  const response = await request('api/register.php',{headers:{Accept:'application/json'}});
  let data;
  try { data = await response.json(); }
  catch { throw sessionError('Сервер не смог загрузить настройки формы. Обновите страницу; если ошибка повторится, сообщите администратору.'); }
  if (!response.ok || data?.IsSuccess === false) throw sessionError(typeof data?.Message === 'string' && data.Message.trim() ? data.Message : 'Настройки подтверждения телефона пока недоступны. Сообщите администратору.');
  if (!data || typeof data.csrf !== 'string' || (data.recaptchaRequired !== false && !data.recaptchaSiteKey)) throw sessionError('Не удалось получить настройки формы. Обновите страницу; если ошибка повторится, сообщите администратору.');
  if (data.consentVersion !== consentVersion) throw new Error('consent_version');
  csrf = data.csrf;
  recaptchaRequired = data.recaptchaRequired !== false;
  phoneCheck.configure(data.phoneVerificationRequired === true,data.phoneTestMode === true);
  document.getElementById('captcha-privacy').hidden = !recaptchaRequired;
  document.getElementById('captcha-notice').hidden = !recaptchaRequired;
  if (recaptchaRequired) {
    captchaAllowed = await cookieConsent.request();
    requirePermission();
    await loadCaptcha(data.recaptchaSiteKey,data.recaptchaMode);
  }
}
function requestCaptchaToken() {
  requirePermission();
  if (captchaWidget === null) return Promise.reject(new Error('not_ready'));
  if (captchaMode !== 'invisible') {
    const token = window.grecaptcha.getResponse(captchaWidget);
    if (token) return Promise.resolve(token);
  }
  return new Promise((resolve,reject) => {
    captchaPending = {resolve,reject,timer:setTimeout(() => finishCaptcha('',new Error('timeout')),120000)};
    try {
      if (captchaMode === 'invisible') {
        window.grecaptcha.reset(captchaWidget); window.grecaptcha.execute(captchaWidget);
      } else {
        captchaStatus.textContent = 'Пройдите проверку «Я не робот» — после неё анкета отправится автоматически.';
        document.getElementById('recaptcha-widget').scrollIntoView({block:'center',behavior:'smooth'});
      }
    }
    catch { finishCaptcha('',new Error('failed')); }
  });
}
async function stopGoogle() {
  if (stopping) return;
  stopping = true;
  try { if (csrf) await request('api/register.php',{method:'DELETE',headers:{'X-CSRF-Token':csrf}},3000); } catch { /* Reload still stops Google; the server session expires. */ }
  form.reset();
  const destination = new URL(location.href);
  // A withdrawal must not accidentally encourage a duplicate of an in-flight POST.
  if (postedOnce) destination.searchParams.set('cookie-reset',confirmed ? 'success' : 'check');
  location.replace(destination.href);
}
cookieConsent.subscribe(allowed => {
  if (!recaptchaRequired) return;
  captchaAllowed = allowed;
  if (allowed) return;
  if (sending) permissionWithdrawn = true;
  if (!googleStarted && !csrf) return;
  permissionWithdrawn = true;
  finishCaptcha('',new Error('consent_revoked'));
  if (!sending) void stopGoogle();
});
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
phone.addEventListener('input', () => {
  if (phoneCheck.number && phoneCheck.number !== normalizedPhone(phone.value)) { phoneCheck.reset(); submit.textContent = submitLabel(); }
});

async function verificationPayload() {
  await getToken();
  const token = recaptchaRequired ? await requestCaptchaToken() : '';
  if (recaptchaRequired && !token) throw Error('captcha_failed');
  return {Phone:normalizedPhone(phone.value),Consent:form.elements.namedItem('Consent').checked,PhoneConsent:document.getElementById('phone-consent').checked,
    ConsentVersion:consentVersion,CaptchaConsent:captchaAllowed,RecaptchaToken:token};
}
document.getElementById('phone-check').addEventListener('click',async()=>{
  if (sending) return;
  const button=document.getElementById('phone-check'), result=document.getElementById('phone-check-result');
  button.disabled=true; sending=true; submit.disabled=true; result.hidden=false; result.textContent='Проверяем соединение без звонка…';
  try {
    await getToken();
    if (!phoneCheck.test) throw sessionError('Проверка доступна только на тестовом сайте.');
    if (!form.elements.namedItem('Consent').checked || !document.getElementById('phone-consent').checked) throw sessionError('Сначала отметьте согласия в форме.');
    const response=await request('api/register.php',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json','X-CSRF-Token':csrf},body:JSON.stringify({Action:'phone-check',Consent:true,PhoneConsent:true,ConsentVersion:consentVersion})});
    const data=await response.json();
    if (!response.ok || data.IsSuccess!==true) throw sessionError(data.Message || 'Не удалось проверить соединение.');
    result.textContent=data.connection.message;
  } catch(error) { result.textContent=error.userMessage ? error.message : 'Не удалось получить результат проверки соединения.'; }
  finally { button.disabled=false; sending=false; submit.disabled=uncertain; }
});
document.getElementById('phone-resend').addEventListener('click',async()=>{
  if (sending || uncertain || !form.reportValidity()) return;
  sending = true; submit.disabled = true;
  try {
    const payload = await verificationPayload();
    await phoneCheck.send(payload,true);
    if (normalizedPhone(phone.value)!==payload.Phone) phoneCheck.reset();
  } catch(error) { showMessage(error.message); }
  finally { sending=false;submit.disabled=false;submit.textContent=submitLabel();try{if(captchaWidget!==null)window.grecaptcha.reset(captchaWidget);}catch{} }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (sending || uncertain) return;
  for (const name of ['LastName','FirstName']) form.elements.namedItem(name).value = form.elements.namedItem(name).value.trim();
  const number = normalizedPhone(phone.value);
  phone.setCustomValidity(number ? '' : 'Введите номер телефона: +7 и 10 цифр.');
  if (!form.reportValidity()) return;
  permissionWithdrawn = false;
  sending = true; submit.disabled = true; submit.textContent = 'Проверяем…';
  form.setAttribute('aria-busy','true'); message.hidden = true;
  let posted = false;
  try {
    const verification = await verificationPayload();
    // A guest may edit fields while completing the challenge; validate them again.
    const currentNumber = normalizedPhone(phone.value);
    phone.setCustomValidity(currentNumber ? '' : 'Введите номер телефона: +7 и 10 цифр.');
    if (!form.reportValidity()) return;
    requirePermission();
    const values = new FormData(form);
    const payload = {...verification,Phone:currentNumber,Consent:values.get('Consent') === 'on'};
    for (const name of ['LastName','FirstName','MiddleName','BirthDate','Comment']) payload[name] = String(values.get(name)||'').trim();
    const verified = await phoneCheck.confirm(payload);
    if (normalizedPhone(phone.value)!==payload.Phone) { phoneCheck.reset(); showMessage('Номер изменился. Подтвердите новый номер.'); return; }
    if (!verified) return;
    submit.textContent = 'Регистрируем…'; posted = true; postedOnce = true;
    const response = await request('api/register.php',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json','X-CSRF-Token':csrf},body:JSON.stringify(payload)});
    const data = await response.json();
    if (response.ok && data.IsSuccess === true) {
      confirmed = true; showSuccess(data.TestMode === true);
    } else {
      if (response.status === 403) csrf = '';
      uncertain = data.Outcome === 'unknown';
      if (phoneCheck.required && !uncertain) phoneCheck.invalidate();
      showMessage(typeof data.Message === 'string' && data.Message.trim() ? data.Message : 'Не удалось завершить регистрацию. Свяжитесь с кофейней.');
    }
  } catch (error) {
    uncertain = posted;
    showMessage(posted
      ? 'Не удалось получить подтверждение. Возможно, анкета уже принята. Уточните результат у кофейни перед повторной отправкой.'
      : error.message === 'consent_revoked'
        ? 'Проверка Google отключена. Анкета не отправлена.'
        : error.message === 'consent_version'
        ? 'Текст согласия обновился. Обновите страницу и ознакомьтесь с ним повторно.'
        : error.userMessage ? error.message : 'Не удалось завершить проверку. Повторите попытку или свяжитесь с кофейней.');
  } finally {
    try { if (cookieConsent.allowed() && captchaWidget !== null && window.grecaptcha) window.grecaptcha.reset(captchaWidget); } catch {}
    sending = false; submit.disabled = uncertain;
    submit.textContent = submitLabel();
    captchaStatus.textContent = '';
    form.removeAttribute('aria-busy');
    if (recaptchaRequired && (permissionWithdrawn || !cookieConsent.allowed()) && (googleStarted || csrf)) await stopGoogle();
  }
});
const resetResult = new URL(location.href).searchParams.get('cookie-reset');
if (resetResult === 'success') showSuccess();
if (resetResult === 'check') {
  uncertain = true; submit.disabled = true; submit.textContent = 'Уточните результат у кофейни';
  showMessage('Настройки cookie изменены после отправки. Перед повторной регистрацией уточните у кофейни, принята ли анкета.');
}
// Only the cookie preference is read on page load; no Google or server session.
