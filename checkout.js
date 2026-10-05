import { cartStore, cartSummary, CART_KEY } from './cart-store.js';
import { money, requestJson, fetchCatalog, formatPhone, createSubmission, OrderError } from './order-client.js';
import { localSlot, validateDraft, validateQuote, validateReceipt } from './checkout-model.js';
import { kdsStatusView, trackingIdFromHash } from './kds-status.js';

const $ = id => document.getElementById(id);
const el = (tag, className, text) => { const item = document.createElement(tag); item.className = className; if (text !== undefined) item.textContent = text; return item; };
let config = null; let catalog = []; let baseline = []; let catalogLive = false; let quote = null; let quotedDraft = null;
let busy = false; let completed = false; let clockOffset = 0; let expiryTimer;
let trackedId = null; let trackingTimer; let trackingBusy = false; let trackingActive = false;
const submitter = createSubmission(async (body, key) => validateReceipt(await requestJson('api/orders', { method: 'POST', body, key, csrf: config?.csrfToken })));
const radio = name => document.querySelector(`input[name="${name}"]:checked`)?.value || '';
const now = () => Date.now() + clockOffset;
function values() {
  return { type: radio('fulfilment'), timing: radio('timing'), phone: $('phone').value, name: $('guest-name').value, city: $('city').value, streetHouse: $('street-house').value,
    apartment: $('apartment').value, entrance: $('entrance').value, floor: $('floor').value, intercom: $('intercom').value,
    courierInstructions: $('courier-instructions').value, date: $('requested-date').value, slot: $('requested-time').value,
    orderComment: $('order-comment').value, consent: $('order-consent').checked };
}
function ready() { return config?.enabled === true && typeof config.csrfToken === 'string' && !!config.csrfToken && !!config.settings?.consent?.version && catalogLive; }
function syncControls() {
  const pending = submitter.pending;
  $('order-fields').disabled = busy || pending;
  $('quote-button').disabled = busy || pending || !ready() || !cartStore.lines.length || cartSummary(cartStore.lines, catalog).unavailable;
  $('send-order').disabled = busy || !pending && (!ready() || !quote || Date.parse(quote.expiresAt) <= now());
  $('send-order').textContent = busy ? 'Подождите…' : pending ? 'Проверить отправку' : 'Отправить заказ';
  $('uncertain-notice').hidden = !pending || busy;
  $('change-basket').hidden = pending;
  document.querySelectorAll('[data-checkout-remove]').forEach(button => { button.disabled = busy || pending; });
  $('checkout-form').setAttribute('aria-busy', String(busy));
}
function invalidateQuote(message = 'Состав или данные изменились. Проверьте сумму ещё раз.') {
  if (submitter.pending) return;
  clearTimeout(expiryTimer); quote = null; quotedDraft = null;
  $('quote-status').textContent = message; $('quote-status').classList.remove('is-changed'); renderSummary(); syncControls();
}
function showErrors(errors, message = '') {
  document.querySelectorAll('.field-error').forEach(item => { item.textContent = ''; });
  document.querySelectorAll('[aria-invalid]').forEach(item => item.removeAttribute('aria-invalid'));
  const summary = $('checkout-errors'); summary.replaceChildren();
  if (message) summary.append(el('p', '', message));
  const controls = { type: 'type-pickup', timing: 'time-asap', consent: 'order-consent' };
  for (const [field, text] of Object.entries(errors || {})) {
    const message = typeof text === 'string' ? text : 'Проверьте поле.';
    const output = $(field + '-error'); const input = $(controls[field] || field);
    if (output) output.textContent = message;
    if (input) input.setAttribute('aria-invalid', 'true');
    summary.append(el('p', '', message));
  }
  summary.hidden = !summary.childElementCount;
  if (!summary.hidden) summary.focus();
}
function totalRows(target, amounts, confirmed = false) {
  target.replaceChildren();
  const row = (label, text, total = false) => { const item = el('div', `checkout-total-row${total ? ' is-total' : ''}`); item.append(el('span', '', label), el('strong', '', text)); target.append(item); };
  row('Блюда', money(amounts.subtotalMinor));
  if (confirmed) {
    row('Доставка', amounts.deliveryFeeMinor === null ? 'После подтверждения' : money(amounts.deliveryFeeMinor));
    if (amounts.totalMinor === null) row('Окончательная сумма', 'После подтверждения');
    else row('Итого', money(amounts.totalMinor), true);
  }
}
function renderSummary() {
  if (completed) return;
  const summary = cartSummary(cartStore.lines, catalog, baseline);
  $('checkout-empty').hidden = summary.rows.length > 0;
  $('checkout-layout').hidden = summary.rows.length === 0;
  const quoteItems = quote ? new Map(quote.items.map(item => [item.id, item])) : null;
  $('checkout-lines').replaceChildren(...summary.rows.map(row => {
    const priced = quoteItems?.get(row.id); const line = el('div', 'checkout-summary-line');
    line.append(el('h3', '', priced?.name || row.item?.name || 'Недоступное блюдо'));
    const amounts = el('div', 'checkout-line-values');
    amounts.append(el('span', '', `${row.qty} × ${row.unitMinor === null && !priced ? 'цена уточняется' : money(priced?.unitPriceMinor ?? row.unitMinor)}`), el('span', '', priced || row.lineMinor !== null ? money(priced?.lineTotalMinor ?? row.lineMinor) : '—'));
    line.append(amounts);
    if (!row.available) line.append(el('p', 'checkout-line-warning', 'Блюдо недоступно. Уберите его перед отправкой.'));
    const oldMinor = priced && row.unitMinor !== priced.unitPriceMinor ? row.unitMinor : row.previousMinor;
    if (oldMinor !== null) line.append(el('p', 'checkout-line-warning', `Цена изменилась: ${money(oldMinor)} → ${money(priced?.unitPriceMinor ?? row.unitMinor)}`));
    if (!row.available) {
      const remove = el('button', 'checkout-line-remove', 'Убрать из корзины'); remove.type = 'button'; remove.dataset.checkoutRemove = row.id;
      remove.addEventListener('click', () => { if (!busy && !submitter.pending) cartStore.setQuantity(row.id, 0); }); line.append(remove);
    }
    return line;
  }));
  totalRows($('checkout-totals'), quote || summary, !!quote);
  syncControls();
}
function availableSlots() {
  return (config?.availability?.[radio('fulfilment')]?.slots || []).filter(iso => typeof iso === 'string' && Date.parse(iso) > now()).map(iso => localSlot(iso, config.settings.timezone)).filter(Boolean);
}
function renderTimes(preserve = true) {
  const date = $('requested-date').value; const chosen = preserve ? $('requested-time').value : '';
  $('requested-time').replaceChildren(new Option('Выберите время', ''), ...availableSlots().filter(slot => slot.date === date).map(slot => new Option(slot.time, slot.value)));
  if ([...$('requested-time').options].some(option => option.value === chosen)) $('requested-time').value = chosen;
}
function syncFulfilment() {
  const type = radio('fulfilment'); const delivery = type === 'delivery'; const time = radio('timing');
  $('address-fields').hidden = !delivery; $('address-fields').disabled = !delivery;
  $('pickup-address').hidden = type !== 'pickup' || !config?.settings?.cafeAddress;
  $('pickup-address').textContent = config?.settings?.cafeAddress ? `Самовывоз: ${config.settings.cafeAddress}` : '';
  const terms = [];
  if (delivery && config?.settings?.delivery) {
    const tariff = config.settings.delivery;
    if (tariff.zoneNotice) terms.push(tariff.zoneNotice);
    if (tariff.mode === 'confirm_by_phone') terms.push(config.mode === 'production' ? 'Стоимость доставки и окончательную сумму сотрудник подтвердит по телефону.' : 'Тестовый тариф доставки не задан. Стоимость доставки и окончательная сумма пока неизвестны.');
    else if (Number.isInteger(tariff.feeMinor)) terms.push(`Доставка: ${money(tariff.feeMinor)}.${Number.isInteger(tariff.freeFromMinor) ? ` Бесплатно при сумме блюд от ${money(tariff.freeFromMinor)}.` : ''}`);
  }
  const minimum = config?.settings?.minimumSubtotalMinor?.[type];
  if (Number.isInteger(minimum) && minimum > 0) terms.push(`Минимальная сумма блюд: ${money(minimum)}.`);
  $('delivery-zone').hidden = !terms.length; $('delivery-zone').textContent = terms.join(' ');
  const avail = config?.availability?.[type];
  $('time-asap').disabled = !avail?.asap; $('time-scheduled').disabled = !avail?.slots?.length;
  if (type && !avail?.asap && avail?.slots?.length && time === 'asap') $('time-scheduled').checked = true;
  const slots = availableSlots(); const dates = [...new Map(slots.map(slot => [slot.date, slot])).values()]; const previous = $('requested-date').value;
  $('requested-date').replaceChildren(new Option('Выберите дату', ''), ...dates.map(slot => new Option(slot.label, slot.date)));
  if (dates.some(slot => slot.date === previous)) $('requested-date').value = previous;
  renderTimes();
  $('scheduled-fields').hidden = radio('timing') !== 'scheduled';
  $('requested-date').disabled = $('scheduled-fields').hidden; $('requested-time').disabled = $('scheduled-fields').hidden;
  $('time-notice').textContent = !type ? 'Сначала выберите способ получения.' : !avail?.asap && !slots.length ? 'Сейчас нет доступного времени для этого способа получения.' : !avail?.asap ? 'Ближайшее время недоступно. Выберите дату и время из расписания.' : `Время указано для ${type === 'delivery' ? 'прибытия к вашему адресу' : 'выдачи в кофейне'}.`;
}
async function loadSettings() {
  busy = true; syncControls(); $('retry-settings').hidden = true;
  try {
    const [settingResult, menuResult] = await Promise.allSettled([requestJson('api/ordering'), fetchCatalog({ allowStatic: true })]);
    if (menuResult.status === 'fulfilled') { catalog = menuResult.value.items; catalogLive = menuResult.value.live; if (!baseline.length) baseline = catalog.map(item => ({ ...item })); }
    else catalogLive = false;
    if (settingResult.status === 'fulfilled') {
      config = settingResult.value;
      const serverTime = Date.parse(config.serverNow); if (Number.isFinite(serverTime)) clockOffset = serverTime - Date.now();
    } else config = null;
    const test = !config || config.mode !== 'production';
    document.querySelector('.checkout-intro > p:last-child').textContent = test ? 'Проверьте оформление самовывоза или доставки с вымышленными данными. Заказ не исполняется.' : 'Выберите, как получить заказ. Состав, сумму и время сотрудник подтвердит по телефону.';
    $('phone-help').textContent = test ? 'Для проверки используйте +7 (000) 000-00-00. Звонка не будет.' : 'Сотрудник позвонит по этому номеру для подтверждения.';
    $('time-confirmation').textContent = test ? 'Время демонстрационное; приготовление не запускается.' : 'Точное время подтвердит сотрудник по телефону.';
    document.querySelector('.summary-note').textContent = test ? (config?.kds?.enabled ? 'Тестовая заявка поступит в КДС. Используйте вымышленные данные. Банковской оплаты нет.' : 'Заявка сохранится только на тестовом стенде. Звонка и исполнения заказа не будет.') : 'После отправки дождитесь звонка сотрудника. Заказ ещё нужно подтвердить.';
    $('ordering-status').classList.toggle('is-test', test);
    $('ordering-status').textContent = test ? `Тестовая версия. Используйте только вымышленные контакты и адрес. ${ready() ? 'Заявка сохранится в тестовом окружении.' : 'Отправка заказов недоступна; оформление можно посмотреть без отправки.'}` : ready() ? (config.notice || 'После отправки заявки дождитесь звонка сотрудника.') : (config.notice || 'Онлайн-заказы пока недоступны. Свяжитесь с кофейней, чтобы уточнить возможность заказа.');
    $('retry-settings').hidden = ready();
    const settings = config?.settings;
    if (settings) {
      if (!$('city').value && typeof settings.defaultCity === 'string') $('city').value = settings.defaultCity;
      $('payment-notice').textContent = settings.paymentNotice || '';
      if (settings.consent?.text) {
        const link = $('consent-link'); $('consent-copy').replaceChildren(document.createTextNode(settings.consent.text + ' '), link);
        try { const url = new URL(settings.consent.url, location.href); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) link.href = url.href; } catch { /* Keep the dedicated local document. */ }
      }
    }
    syncFulfilment();
    const savedId = trackingIdFromHash(location.hash);
    if (savedId && config?.csrfToken && !completed) {
      try {
        const data = await requestJson(`api/orders/${savedId}/status`);
        showResult(validateReceipt(data), { consume: false });
        renderTracking(data.delivery);
      } catch {
        // Preserve the reference and stop new submissions until the old result is known.
        completed = true; $('checkout-layout').hidden = true; $('order-result').hidden = false;
        $('result-title').textContent = 'Не удалось открыть сохранённый заказ';
        document.querySelector('.result-status').textContent = 'Статус не подтверждён';
        document.querySelector('.result-status').nextElementSibling.textContent = 'Обновите страницу в том же браузере. Если доступ не восстановится, уточните результат у сотрудника КДС перед новым заказом.';
        $('cafe-phone').hidden = true;
      }
    }
    if (!catalogLive) $('quote-status').textContent = 'Цены не подтверждены сервером. Отправка недоступна.';
  } catch { $('ordering-status').textContent = 'Не удалось загрузить условия оформления. Корзина сохранена.'; $('retry-settings').hidden = false; }
  finally { busy = false; renderSummary(); syncControls(); }
}
function setQuote(value, draft, changed = false) {
  quote = validateQuote(value, draft); quotedDraft = structuredClone(draft);
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => { if (!submitter.pending && !busy) invalidateQuote('Срок расчёта истёк. Проверьте актуальную сумму перед отправкой.'); }, Math.max(0, Date.parse(quote.expiresAt) - now()));
  const unknown = quote.deliveryFeeMinor === null;
  $('quote-status').textContent = `${changed ? 'Расчёт изменился. Проверьте новые цены и сумму перед повторной отправкой. ' : 'Состав и сумма проверены сервером. '}${unknown ? 'Доставка и окончательная сумма — после подтверждения. ' : ''}Расчёт действует до ${new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: config.settings.timezone }).format(new Date(quote.expiresAt))}.`;
  $('quote-status').classList.toggle('is-changed', changed);
  renderSummary();
}
async function handleApiError(error) {
  if (error.code === 'item_unavailable') {
    for (const item of error.data?.details?.items || []) catalog = catalog.map(row => row.id === item.id ? { ...row, availableForOrder: false } : row);
  }
  if (error.code === 'quote_changed' && error.data?.details?.quote && quotedDraft) {
    try { setQuote(error.data.details.quote, quotedDraft, true); } catch { invalidateQuote('Расчёт изменился. Проверьте состав и сумму ещё раз.'); }
  } else if (!submitter.pending) invalidateQuote(error.code === 'quote_expired' ? 'Срок расчёта истёк. Проверьте сумму ещё раз.' : 'Проверьте данные и запросите новый расчёт.');
  const fieldMap = { items: 'basket', fulfilment: 'type', address: 'city', 'address.city': 'city', 'address.streetHouse': 'street-house', 'address.apartment': 'apartment', 'address.entrance': 'entrance', 'address.floor': 'floor', 'address.intercom': 'intercom', name: 'guest-name', orderComment: 'order-comment', courierInstructions: 'courier-instructions', phone: 'phone', consent: 'consent' };
  const errors = { ...error.fields }; const serverField = error.data?.details?.field;
  if (serverField) errors[fieldMap[serverField] || serverField] = error.message;
  if (error.code === 'invalid_time') errors.timing = error.message;
  showErrors(errors, error.message || 'Не удалось выполнить действие. Корзина сохранена.');
  renderSummary();
}
$('checkout-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || submitter.pending || !ready()) return;
  const draft = validateDraft(values(), cartStore.lines, config, now());
  const summary = cartSummary(cartStore.lines, catalog);
  if (summary.unavailable) draft.errors.basket = 'В корзине есть недоступные блюда. Уберите их перед оформлением.';
  const minimum = config.settings.minimumSubtotalMinor?.[draft.body.fulfilment.type];
  if (Number.isInteger(minimum) && summary.subtotalMinor < minimum) draft.errors.basket = `Минимальная сумма блюд: ${money(minimum)}. Добавьте блюда в корзину.`;
  if (Object.keys(draft.errors).length) { showErrors(draft.errors); return; }
  showErrors({}); busy = true; syncControls();
  try {
    const previous = quote;
    const data = await requestJson('api/orders/quote', { method: 'POST', body: draft.body, csrf: config.csrfToken });
    const current = validateQuote(data.quote, draft.body);
    const changed = current.items.some(item => { const listed = catalog.find(row => row.id === item.id); return listed && Math.round(listed.price * 100) !== item.unitPriceMinor; }) || !!previous && previous.totalMinor !== current.totalMinor;
    setQuote(current, draft.body, changed);
    $('quote-status').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
  } catch (error) { await handleApiError(error); }
  finally { busy = false; syncControls(); }
});
function showResult(order, { consume = true } = {}) {
  completed = true; clearTimeout(expiryTimer); quote = null; quotedDraft = null;
  if (consume) { cartStore.reload(); cartStore.consume(order.items); }
  $('checkout-layout').hidden = true; $('checkout-empty').hidden = true; $('retry-settings').hidden = true; $('order-result').hidden = false;
  const test = config?.mode !== 'production';
  $('result-title').textContent = test ? `Тестовая заявка №${order.number} сохранена` : `Заказ №${order.number} получен`;
  $('result-environment').textContent = test ? 'ТЕСТОВЫЙ ЗАКАЗ' : 'ВОСЕМЬ УТРА';
  const status = document.querySelector('.result-status');
  status.textContent = test ? 'Сохранено на тестовом стенде' : 'Ожидает подтверждения';
  status.nextElementSibling.textContent = test ? 'Это проверка оформления. Заказ не передан на кухню и не будет исполнен. КДС и касса пока не подключены.' : 'Сотрудник позвонит, чтобы подтвердить состав, сумму и время.';
  const summary = $('result-summary'); summary.replaceChildren();
  for (const item of order.items) summary.append(el('p', '', `${item.name} · ${item.quantity} × ${money(item.unitPriceMinor)}`));
  summary.append(el('p', '', order.totalMinor === null ? `Блюда: ${money(order.subtotalMinor)}. Доставка и окончательная сумма — после подтверждения.` : `Итого: ${money(order.totalMinor)}`));
  const type = order.fulfilment.type === 'pickup' ? 'Самовывоз' : 'Доставка';
  let when = 'как можно скорее';
  if (order.fulfilment.timing === 'scheduled' && Number.isFinite(Date.parse(order.fulfilment.requestedAt))) when = new Intl.DateTimeFormat('ru-RU', { timeZone: config.settings.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(order.fulfilment.requestedAt));
  summary.append(el('p', '', `${type} · ${when}. Время требует подтверждения.`));
  const phone = config?.settings?.cafePhone;
  if (!test && typeof phone === 'string' && /^[+\d\s()-]+$/.test(phone)) { $('cafe-phone').href = `tel:${phone.replace(/[^+\d]/g, '')}`; $('cafe-phone').textContent = phone; }
  else $('cafe-phone').hidden = true;
  $('checkout-form').reset(); $('result-title').focus();
  if (order.trackingId) {
    trackedId = order.trackingId;
    history.replaceState(null, '', `#order=${trackedId}`);
    renderTracking({ state: 'queued' });
  }
}
function renderTracking(delivery) {
  const view = kdsStatusView(delivery); const status = document.querySelector('.result-status');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  status.textContent = view.title;
  status.nextElementSibling.textContent = view.description + ' Это тест: банковской оплаты нет, готовить и доставлять заказ не нужно.';
  if (delivery?.pendingNumber) status.textContent += ` · №${delivery.pendingNumber}`;
  trackingActive = view.poll; clearTimeout(trackingTimer);
  if (trackingActive && trackedId) trackingTimer = setTimeout(syncTracking, 5000);
}
async function syncTracking() {
  if (!trackedId || trackingBusy || !trackingActive) return;
  trackingBusy = true;
  try {
    const data = await requestJson(`api/orders/${trackedId}/sync`, { method: 'POST', body: {}, csrf: config.csrfToken, timeoutMs: 45000 });
    renderTracking(data.delivery);
  } catch (error) {
    document.querySelector('.result-status').nextElementSibling.textContent = [403, 404].includes(error.status)
      ? 'Не удалось получить доступ к заказу. Обновите страницу в том же браузере; перед новым заказом уточните результат у сотрудника КДС.'
      : 'Связь с сервером прервалась. Проверяем состояние сохранённой заявки; повторный заказ не создаётся.';
    trackingActive = ![403, 404].includes(error.status);
    if (trackingActive) trackingTimer = setTimeout(syncTracking, 15000);
  } finally { trackingBusy = false; }
}
$('send-order').addEventListener('click', async () => {
  if (busy || completed) return;
  if (!submitter.pending && (!ready() || !quote || Date.parse(quote.expiresAt) <= now())) { invalidateQuote('Срок расчёта истёк. Проверьте сумму ещё раз.'); return; }
  const body = quotedDraft && quote ? { ...quotedDraft, quoteId: quote.quoteId } : null;
  busy = true; showErrors({}); syncControls();
  try { const order = await submitter.submit(body); showResult(order); }
  catch (error) {
    if (submitter.pending) showErrors({}, 'Не удалось подтвердить сохранение заказа. Корзина и данные сохранены на этой странице. Проверьте отправку тем же запросом; если ошибка повторяется, свяжитесь с кофейней.');
    else await handleApiError(error);
  } finally { busy = false; syncControls(); }
});
for (const eventName of ['input', 'change']) $('checkout-form').addEventListener(eventName, event => {
  if (busy || submitter.pending) return;
  if (event.target.id === 'phone' && eventName === 'input') {
    const end = event.target.selectionStart === event.target.value.length;
    if (end && !event.inputType?.startsWith('delete')) event.target.value = formatPhone(event.target.value);
  }
  if (eventName === 'change' && (event.target.name === 'fulfilment' || event.target.name === 'timing')) syncFulfilment();
  if (eventName === 'change' && event.target.id === 'requested-date') renderTimes(false);
  if (quote) invalidateQuote();
});
$('retry-settings').addEventListener('click', () => { if (!busy && !submitter.pending) { invalidateQuote('Сумма будет проверена перед отправкой.'); loadSettings(); } });
cartStore.subscribe(() => { if (!completed && !submitter.pending) invalidateQuote('Корзина изменилась. Проверьте состав и сумму.'); });
window.addEventListener('storage', event => { if (event.key === CART_KEY && !submitter.pending && !busy) cartStore.reload(); });
window.addEventListener('beforeunload', event => { if (submitter.pending || busy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pageshow', event => { if (event.persisted && !submitter.pending && !completed) { invalidateQuote('Проверьте актуальную сумму перед отправкой.'); loadSettings(); } });
window.addEventListener('pagehide', () => clearTimeout(trackingTimer));
window.addEventListener('pageshow', event => { if (event.persisted && trackedId && trackingActive) trackingTimer = setTimeout(syncTracking, 1000); });
loadSettings();
