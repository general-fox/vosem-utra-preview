import { createStaffClient, StaffError } from './staff-client.js';
import { STATUS_LABELS, permissions, editableOrder, createEditor, acceptanceProblems, integrationText, validDetail, createAcceptance, createVisiblePoll } from './staff-model.js';
import { money, normalizePhone, formatPhone } from './order-client.js';

const $ = id => document.getElementById(id);
const node = (tag, className = '', text) => { const value = document.createElement(tag); value.className = className; if (text !== undefined) value.textContent = text; return value; };
const demo = document.body.dataset.staffDemo === 'true' && location.pathname.endsWith('/staff-demo.html');
const telegram = demo ? null : window.Telegram?.WebApp;
let client; let actor = null; let settings = null; let catalog = []; let busy = false; let loadingList = false; let listGeneration = 0; let detailGeneration = 0; let active = true; let clockOffset = 0; let action = ''; let priceReview = null; let uncertainMutation = null;
const editor = createEditor();
const filter = { status: 'new', mine: false, date: null, query: '', page: 1, pageSize: 25 };
const now = () => Date.now() + clockOffset;
const stamp = (value, full = false) => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('ru-RU', { timeZone: settings?.timezone || 'Europe/Moscow', ...(full ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' }) }).format(new Date(value)) : '—';
const acceptance = createAcceptance((id, body, key) => client.request(`api/staff/orders/${encodeURIComponent(id)}/accept`, { method: 'POST', body, key, mutation: true }));

function theme() {
  document.body.dataset.theme = telegram?.colorScheme === 'dark' ? 'dark' : 'light';
  if (telegram) {
    try { telegram.setHeaderColor?.('bg_color'); telegram.setBackgroundColor?.('bg_color'); } catch { /* Older Telegram versions retain their native chrome. */ }
  }
}
function closingWarning() {
  const warn = editor.dirty || !!acceptance.pending || !!uncertainMutation;
  try { if (warn) telegram?.enableClosingConfirmation?.(); else telegram?.disableClosingConfirmation?.(); } catch { /* beforeunload remains available. */ }
}
function alertMessage(message, focus = false) { $('staff-error').textContent = message || ''; $('staff-error').hidden = !message; if (message && focus) $('staff-error').focus(); }
function lock(message) {
  client?.forget(); poll.stop(); $('staff-app').hidden = true; $('staff-lock').hidden = false; $('staff-logout').hidden = true;
  $('lock-message').textContent = message; $('auth-retry').hidden = !telegram?.initData || demo;
}
function isAuthError(error) { return error.status === 401 || ['staff_denied', 'staff_inactive', 'access_denied', 'access_revoked', 'unauthorized', 'session_expired'].includes(error.code); }
async function failure(error, { draftBody = null } = {}) {
  if (isAuthError(error)) { lock('Доступ завершён или отозван. Сохранённые заказы остаются на сервере. Откройте приложение заново из бота.'); return; }
  if (['version_conflict', 'already_claimed'].includes(error.code) && error.details?.current) {
    try {
      const current = validDetail(error.details.current, editor.detail?.order.id);
      acceptance.observe(current) || acceptance.superseded(current);
      const result = editor.receive(current);
      if (result === 'updated') { priceReview = null; renderDetail(); } else renderConflict();
    } catch { /* Keep the existing draft. */ }
  }
  if (error.code === 'prices_changed' && error.details?.preview && editor.detail) {
    priceReview = { body: structuredClone(draftBody || { expectedVersion: editor.detail.order.version, ...editor.draft }), token: error.details.priceConfirmationToken, preview: error.details.preview, changes: error.details.changes || [] };
    renderPrices(); $('guest-agreed').checked = false;
  }
  alertMessage(error.message || 'Не удалось выполнить действие. Сохранённые данные и ваши правки остаются на месте.', true);
  document.querySelectorAll('#edit-fields [aria-invalid]').forEach(field => field.removeAttribute('aria-invalid'));
  const fieldMap = { phone: 'guest-phone', name: 'guest-name', 'contact.phone': 'guest-phone', 'contact.name': 'guest-name', 'address.city': 'address-city', 'address.streetHouse': 'address-street', 'address.apartment': 'address-apartment', 'address.entrance': 'address-entrance', 'address.floor': 'address-floor', 'address.intercom': 'address-intercom', deliveryFeeMinor: 'delivery-fee', staffNote: 'staff-note', fulfillmentComment: 'fulfillment-comment', confirmedAt: 'confirmed-slot', requestedAt: 'requested-slot' };
  const invalid = $(fieldMap[error.details?.field] || '');
  if (invalid) { invalid.setAttribute('aria-invalid', 'true'); invalid.setAttribute('aria-describedby', 'staff-error'); }
  sync();
}
function sync() {
  const order = editor.detail?.order; const rights = permissions(order, actor); const frozen = !!acceptance.pending || !!uncertainMutation;
  $('staff-logout').disabled = busy || frozen;
  $('edit-fields').disabled = busy || frozen || !rights.edit;
  $('save-order').disabled = busy || frozen || !rights.edit || editor.conflict || !!priceReview || !editor.dirty && !orderHasNewPrices();
  $('save-bar').hidden = !rights.edit;
  $('save-state').textContent = editor.dirty ? 'Есть несохранённые изменения' : 'Нет несохранённых изменений';
  $('totals-note').textContent = editor.dirty ? 'Есть правки. Новая сумма появится после сохранения на сервере.' : 'Суммы рассчитаны сервером для сохранённой версии заказа.';
  $('detail-version').textContent = order ? `Сохранённая версия: ${order.version}${editor.dirty ? ' · есть несохранённые правки' : ' · изменения сохранены'}` : '';
  $('detail-version').classList.toggle('is-dirty', editor.dirty);
  for (const [id, available] of Object.entries({ 'claim-order': rights.claim, 'release-order': rights.release, 'reassign-order': rights.reassign, 'contact-attempt': rights.edit, 'cancel-order': rights.cancel })) {
    $(id).hidden = !available; $(id).disabled = busy || frozen || editor.dirty || editor.conflict;
  }
  $('accept-panel').hidden = !rights.accept && !acceptance.pending;
  const reasons = order ? acceptanceProblems(order, actor, { dirty: editor.dirty, conflict: editor.conflict, catalog, now: now(), agreed: $('guest-agreed').checked, availability: settings?.availability }) : [];
  if (priceReview) reasons.push('Сначала подтвердите и сохраните новые цены.');
  $('accept-problems').replaceChildren(...reasons.map(reason => node('li', '', reason)));
  $('accept-order').textContent = acceptance.pending ? 'Проверить принятие' : 'Принять заказ';
  $('accept-order').disabled = busy || !!uncertainMutation || !acceptance.pending && reasons.length > 0;
  $('accept-pending').hidden = !acceptance.pending;
  $('accept-pending').textContent = priceRecoveryAllowed() ? 'Результат принятия пока не подтверждён. Проверьте его тем же запросом или подтвердите новые цены в блоке согласования. После сохранения понадобится отдельно принять заказ.' : 'Ответ о принятии не получен. Проверьте результат тем же запросом. Не создавайте новое принятие.';
  $('guest-agreed').disabled = busy || frozen || !rights.accept;
  $('approve-prices').disabled = busy || !!uncertainMutation || !!acceptance.pending && !priceRecoveryAllowed() || !priceReview || !$('price-agreed').checked || editor.conflict;
  $('back-list').disabled = busy || frozen; $('refresh-detail').disabled = busy;
  $('confirm-action').disabled = busy || frozen; $('close-action').disabled = busy;
  $('load-current').disabled = busy || frozen;
  $('edit-order').setAttribute('aria-busy', String(busy));
  closingWarning();
}
function priceRecoveryAllowed() {
  return !!(acceptance.pending && priceReview?.token && !editor.dirty && priceReview.body.expectedVersion === acceptance.pending.expectedVersion && editor.detail?.order.id === acceptance.pending.id);
}
function orderHasNewPrices() {
  return !!editor.detail?.order.items.some(item => { const current = catalog.find(dish => dish.id === item.id); return current && Math.round(current.price * 100) !== item.unitPriceMinor; });
}
function renderConflict() {
  $('version-conflict').hidden = !editor.conflict;
  if (editor.incoming) $('conflict-message').textContent = `На сервере уже версия ${editor.incoming.order.version}. Статус: ${STATUS_LABELS[editor.incoming.order.status]}. Ответственный: ${editor.incoming.order.assignee?.name || 'не назначен'}. Ваши правки не заменены.`;
  sync();
}
function renderList(orders, data) {
  $('order-list').replaceChildren(...orders.map(order => {
    const button = node('button', 'staff-order-row'); button.type = 'button';
    const top = node('div', 'staff-row-top'); top.append(node('strong', '', `№ ${order.number}`), node('span', '', stamp(order.createdAt, true)));
    const receive = node('p', 'staff-row-fulfilment', order.fulfilment.type === 'pickup' ? 'Самовывоз' : 'Доставка');
    const time = order.fulfilment.confirmedAt || order.fulfilment.requestedAt;
    const timing = node('p', `staff-row-time${time ? ' is-scheduled' : ''}`, time ? `${order.fulfilment.confirmedAt ? 'Согласовано' : 'Желаемое время'}: ${stamp(time, true)}` : 'Как можно скорее');
    const bottom = node('div', 'staff-row-bottom'); bottom.append(node('span', '', `${STATUS_LABELS[order.status]} · ${order.assignee?.name || 'не назначен'}`), node('strong', '', order.totalMinor === null ? `${money(order.subtotalMinor)} + доставка` : money(order.totalMinor)));
    button.append(top, receive, timing, bottom); button.addEventListener('click', () => openOrder(order.id)); return button;
  }));
  $('list-empty').hidden = orders.length > 0; $('list-total').textContent = `Найдено: ${data.total}`;
  $('page-label').textContent = `Страница ${data.page}`; $('previous-page').disabled = data.page <= 1; $('next-page').disabled = data.page * data.pageSize >= data.total;
  $('last-sync').textContent = `Обновлено в ${stamp(new Date().toISOString())}`;
}
async function loadList() {
  if (!actor || busy) return;
  const generation = ++listGeneration; loadingList = true; $('refresh-list').disabled = true;
  try {
    const data = await client.request('api/staff/orders/search', { method: 'POST', body: { ...filter } });
    if (generation !== listGeneration) return;
    if (!Array.isArray(data.orders) || !Number.isInteger(data.total)) throw new StaffError('Не удалось прочитать список заказов.');
    renderList(data.orders, data); alertMessage('');
    if (actor.role === 'manager') await loadNotifications();
  } catch (error) { if (generation === listGeneration) await failure(error); }
  finally { if (generation === listGeneration) { loadingList = false; $('refresh-list').disabled = false; } }
}
function fillSelect(id, values, selected, blank = 'Не согласовано') {
  const list = [...values]; if (selected && !list.includes(selected)) list.unshift(selected);
  $(id).replaceChildren(new Option(blank, ''), ...list.map(value => new Option(stamp(value, true), value)));
  $(id).value = selected || '';
}
function slots() { return settings?.availability?.[$('fulfilment-type').value]?.slots || []; }
function syncDelivery() {
  const pickup = $('fulfilment-type').value === 'pickup'; $('staff-address').hidden = pickup; $('staff-address').disabled = pickup;
  $('delivery-fee-field').hidden = pickup; $('delivery-fee').disabled = pickup || settings?.delivery?.mode !== 'confirm_by_phone';
  if (pickup) $('delivery-fee').value = '0';
  $('requested-slot-field').hidden = $('requested-timing').value !== 'scheduled';
}
function fillForm() {
  const draft = editor.draft; const f = draft.fulfilment; const a = f.address || {};
  for (const [id, value] of Object.entries({ 'guest-phone': draft.contact.phone, 'guest-name': draft.contact.name, 'fulfilment-type': f.type, 'address-city': a.city, 'address-street': a.streetHouse, 'address-apartment': a.apartment, 'address-entrance': a.entrance, 'address-floor': a.floor, 'address-intercom': a.intercom, 'courier-instructions': f.courierInstructions, 'requested-timing': f.timing, 'delivery-fee': draft.deliveryFeeMinor === null ? '' : draft.deliveryFeeMinor / 100, 'staff-note': draft.staffNote, 'fulfillment-comment': draft.fulfillmentComment })) $(id).value = value ?? '';
  fillSelect('requested-slot', slots(), f.requestedAt, 'Выберите желаемое время'); fillSelect('confirmed-slot', slots(), f.confirmedAt);
  $('guest-comment').textContent = editor.detail.order.orderComment || 'Гость не оставил комментарий.';
  const phone = normalizePhone(draft.contact.phone); $('call-guest').hidden = !phone; if (phone) $('call-guest').href = `tel:${phone}`;
  syncDelivery(); renderItems(); renderTotals(); renderMenuResults();
}
function readForm() {
  const pickup = $('fulfilment-type').value === 'pickup'; const scheduled = $('requested-timing').value === 'scheduled'; const fee = $('delivery-fee').value.trim();
  return { items: editor.draft.items.map(item => ({ ...item })), contact: { phone: $('guest-phone').value.trim(), name: $('guest-name').value.trim() },
    fulfilment: { type: pickup ? 'pickup' : 'delivery', timing: scheduled ? 'scheduled' : 'asap', requestedAt: scheduled ? $('requested-slot').value || null : null,
      confirmedAt: $('confirmed-slot').value || null, address: pickup ? null : { city: $('address-city').value.trim(), streetHouse: $('address-street').value.trim(), apartment: $('address-apartment').value.trim(), entrance: $('address-entrance').value.trim(), floor: $('address-floor').value.trim(), intercom: $('address-intercom').value.trim() }, courierInstructions: pickup ? '' : $('courier-instructions').value.trim() },
    deliveryFeeMinor: pickup ? 0 : fee === '' ? null : Math.round(Number(fee) * 100), staffNote: $('staff-note').value, fulfillmentComment: $('fulfillment-comment').value };
}
function markDirty() { if (!editor.detail || busy || acceptance.pending || uncertainMutation) return; editor.edit(readForm()); priceReview = null; $('price-review').hidden = true; $('guest-agreed').checked = false; sync(); }
function renderItems() {
  $('edit-items').replaceChildren(...editor.draft.items.map(item => {
    const saved = editor.detail.order.items.find(line => line.id === item.id); const current = catalog.find(line => line.id === item.id); const line = node('div', 'staff-edit-line');
    line.append(node('h3', '', saved?.name || current?.name || 'Блюдо недоступно'));
    line.append(node('p', 'staff-item-price', saved ? `${money(saved.unitPriceMinor)} × ${saved.quantity} · ${money(saved.lineTotalMinor)} в сохранённой версии` : current ? `${money(Math.round(current.price * 100))} за порцию · будет проверено сервером` : 'Цена будет проверена сервером'));
    if (!current || !current.published || current.availableForOrder === false) line.append(node('p', 'staff-field-error', 'Недоступно для заказа. Согласуйте удаление или замену.'));
    const controls = node('div', 'staff-item-actions'); const input = node('input'); input.type = 'number'; input.min = '1'; input.max = String(settings?.maxQuantity || 99); input.step = '1'; input.value = item.quantity; input.setAttribute('aria-label', `Количество: ${saved?.name || current?.name || 'блюдо'}`);
    input.addEventListener('input', () => { const draft = readForm(); draft.items = draft.items.map(line => line.id === item.id ? { ...line, quantity: Number(input.value) } : line); editor.edit(draft); priceReview = null; $('price-review').hidden = true; $('guest-agreed').checked = false; sync(); });
    const remove = node('button', 'staff-text-button', 'Убрать'); remove.type = 'button'; remove.setAttribute('aria-label', `Убрать: ${saved?.name || current?.name || 'блюдо'}`);
    remove.addEventListener('click', () => { const draft = readForm(); draft.items = draft.items.filter(line => line.id !== item.id); editor.edit(draft); priceReview = null; $('price-review').hidden = true; $('guest-agreed').checked = false; renderItems(); sync(); });
    controls.append(node('span', 'staff-help', 'Порций'), input, remove); line.append(controls); return line;
  }));
  $('add-item-panel').hidden = !permissions(editor.detail.order, actor).edit;
}
function renderMenuResults() {
  const query = $('menu-search').value.trim().toLocaleLowerCase('ru');
  const matches = catalog.filter(item => item.published && item.availableForOrder !== false && (!query || item.name.toLocaleLowerCase('ru').includes(query))).slice(0, 12);
  $('menu-results').replaceChildren(...matches.map(item => {
    const button = node('button'); button.type = 'button'; button.append(node('span', 'staff-menu-name', item.name), node('span', 'staff-menu-price', `${money(Math.round(item.price * 100))} · +`));
    button.addEventListener('click', () => {
      const draft = readForm(); const exists = draft.items.find(line => line.id === item.id);
      if (!exists && draft.items.length >= (settings?.maxLines || 50) || exists && exists.quantity >= (settings?.maxQuantity || 99)) { alertMessage('Достигнут технический лимит состава или количества.'); return; }
      if (exists) exists.quantity++; else draft.items.push({ id: item.id, quantity: 1 });
      editor.edit(draft); priceReview = null; $('price-review').hidden = true; $('guest-agreed').checked = false; renderItems(); sync();
    }); return button;
  }));
  $('catalog-status').textContent = catalog.length ? (matches.length ? 'Добавляются только доступные позиции общего меню.' : 'Доступных блюд по запросу не найдено.') : 'Меню не загружено. Обновите карточку перед принятием.';
}
function renderTotals() {
  const order = editor.detail.order; const rows = [['Блюда', money(order.subtotalMinor)], ['Доставка', order.deliveryFeeMinor === null ? 'Не определена' : money(order.deliveryFeeMinor)], ['Итого', order.totalMinor === null ? 'Не определено' : money(order.totalMinor)]];
  $('saved-totals').replaceChildren(...rows.map(([label, value]) => { const row = node('div', 'staff-total-line'); row.append(node('span', '', label), node('strong', '', value)); return row; }));
}
function renderHistory() {
  const names = { created: 'Заявка получена', claimed: 'Взят в работу', claim: 'Взят в работу', released: 'Возвращён в новые', release: 'Возвращён в новые', reassigned: 'Переназначен', reassign: 'Переназначен', updated: 'Изменения сохранены', edited: 'Изменения сохранены', edit: 'Изменения сохранены', saved: 'Изменения сохранены', contact_attempt: 'Не дозвонились', 'contact-attempts': 'Не дозвонились', cancelled: 'Отменён', cancel: 'Отменён', accepted: 'Принят', accept: 'Принят', 'integration.retry': 'Запрошен повтор передачи' };
  const labels = { items: 'Состав', contact: 'Контакты', fulfilment: 'Получение и время', deliveryFeeMinor: 'Доставка', subtotalMinor: 'Блюда', totalMinor: 'Итого', staffNote: 'Служебная заметка', fulfillmentComment: 'Для выполнения заказа', assignee: 'Ответственный', status: 'Статус', integration: 'Передача интегратору' };
  const reasons = { guest_declined: 'Отказ гостя', unavailable: 'Нет доступных блюд', undeliverable: 'Невозможно доставить', duplicate: 'Дубль', other: 'Другая причина' };
  function describe(field, value) {
    if (value === null || value === undefined || value === '') return 'не указано';
    if (field.endsWith('Minor') && Number.isFinite(value)) return money(value);
    if (field === 'items' && Array.isArray(value)) return value.map(line => `${line.name || line.id} × ${line.quantity}`).join('; ');
    if (field === 'contact' && typeof value === 'object') return [value.name, value.phone].filter(Boolean).join(', ');
    if (field === 'fulfilment' && typeof value === 'object') return [value.type === 'delivery' ? 'Доставка' : 'Самовывоз', value.confirmedAt ? `согласовано ${stamp(value.confirmedAt, true)}` : value.requestedAt ? `желаемое ${stamp(value.requestedAt, true)}` : 'как можно скорее', value.address ? [value.address.city, value.address.streetHouse, value.address.apartment].filter(Boolean).join(', ') : ''].filter(Boolean).join(' · ');
    if (field === 'assignee' && typeof value === 'object') return value.name || 'не назначен';
    if (field === 'status') return STATUS_LABELS[value] || 'Состояние обновлено';
    if (field === 'integration') return integrationText({ status: value }).delivery;
    return typeof value === 'string' || typeof value === 'number' ? String(value) : 'данные обновлены';
  }
  $('order-history').replaceChildren(...[...(editor.detail.history || [])].reverse().map(entry => {
    const item = node('li'); item.append(node('strong', '', `${names[entry.event] || 'Заказ обновлён'} · ${entry.author?.name || 'Система'}`), node('time', '', `${stamp(entry.at, true)} · версия ${entry.version ?? '—'}`));
    if (entry.reason) item.append(node('p', '', reasons[entry.reason] || entry.reason)); if (entry.comment) item.append(node('p', '', entry.comment));
    if (entry.changes && !Array.isArray(entry.changes) && Object.keys(entry.changes).length) {
      const details = node('details'); details.append(node('summary', '', 'Что изменилось'));
      for (const [field, change] of Object.entries(entry.changes)) details.append(node('p', '', `${labels[field] || 'Данные заказа'}: ${describe(field, change?.before)} → ${describe(field, change?.after)}`));
      item.append(details);
    } return item;
  }));
}
function renderIntegration() {
  const accepted = editor.detail.order.status === 'accepted'; $('integration-panel').hidden = !accepted;
  if (!accepted) return;
  const detail = editor.detail.integration; const text = integrationText(detail); $('integration-state').textContent = text.delivery; $('cash-register-state').textContent = text.cashRegister;
  $('retry-integration').hidden = actor.role !== 'manager' || !detail?.eventId || detail.status !== 'failed';
  $('retry-integration').disabled = busy;
}
function renderPrices() {
  $('price-review').hidden = !priceReview; $('price-agreed').checked = false;
  if (!priceReview) return;
  $('price-changes').replaceChildren(...priceReview.changes.map(change => node('p', '', `${change.name || (change.id === 'delivery-fee' ? 'Доставка' : 'Блюдо')}: ${change.previousUnitPriceMinor === null ? 'не определена' : money(change.previousUnitPriceMinor)} → ${money(change.currentUnitPriceMinor)}`)), node('p', 'staff-help', `Новая сумма: ${priceReview.preview.totalMinor === null ? `${money(priceReview.preview.subtotalMinor)} + доставка` : money(priceReview.preview.totalMinor)}`));
}
function renderDetail() {
  const order = editor.detail.order; $('staff-list').hidden = true; $('staff-detail').hidden = false;
  $('detail-title').textContent = `Заказ № ${order.number}`; $('detail-created').textContent = `ПОСТУПИЛ ${stamp(order.createdAt, true)}`;
  $('detail-status').textContent = STATUS_LABELS[order.status]; $('detail-status').dataset.status = order.status;
  $('detail-owner').textContent = `Ответственный: ${order.assignee?.name || 'не назначен'}`;
  const rights = permissions(order, actor);
  $('read-only-notice').hidden = rights.edit || rights.claim;
  $('read-only-notice').textContent = order.status === 'accepted' ? 'Заказ принят и доступен для просмотра. Изменения и отмену согласуйте с ответственным за кассу.' : order.status === 'cancelled' ? 'Заказ отменён. Состав и история сохранены.' : 'Заказ ведёт другой сотрудник. Руководитель может явно переназначить его с указанием причины.';
  $('guest-agreed').checked = false; fillForm(); renderConflict(); renderHistory(); renderIntegration(); renderPrices(); sync();
  try { telegram?.BackButton?.show(); } catch { /* Browser back remains available. */ }
}
async function loadResources() {
  const [settingResult, menuResult] = await Promise.allSettled([client.request('api/staff/settings'), client.request('api/menu', { authenticated: false })]);
  if (settingResult.status === 'rejected') throw settingResult.reason;
  settings = settingResult.value; if (Number.isFinite(Date.parse(settings.serverNow))) clockOffset = Date.parse(settings.serverNow) - Date.now();
  if (menuResult.status === 'fulfilled' && Array.isArray(menuResult.value.items)) catalog = menuResult.value.items;
  else { catalog = []; alertMessage('Не удалось обновить меню. Сохранённые заказы доступны, принятие требует проверки меню.'); }
}
async function refreshCatalog() {
  try {
    const data = await client.request('api/menu', { authenticated: false });
    if (!Array.isArray(data.items)) throw new StaffError('Меню не загружено.');
    catalog = data.items;
  } catch {
    catalog = [];
    alertMessage('Заказ сохранён. Не удалось обновить меню для принятия. Обновите карточку перед продолжением.');
  }
}
async function openOrder(id) {
  if (busy || acceptance.pending || uncertainMutation) return;
  if (editor.dirty && !confirm('Отбросить несохранённые правки и открыть другой заказ?')) return;
  const generation = ++detailGeneration; busy = true; sync();
  try { await loadResources(); const data = validDetail(await client.request(`api/staff/orders/${encodeURIComponent(id)}`), id); if (generation !== detailGeneration) return; editor.open(data); priceReview = null; alertMessage(''); renderDetail(); $('detail-title').focus(); }
  catch (error) { await failure(error); }
  finally { busy = false; sync(); }
}
async function refreshDetail() {
  if (!editor.detail || busy) return;
  const id = editor.detail.order.id; const generation = detailGeneration;
  try {
    const data = validDetail(await client.request(`api/staff/orders/${encodeURIComponent(id)}`), id);
    if (generation !== detailGeneration || editor.detail?.order.id !== id) return;
    if (acceptance.observe(data)) { editor.open(data); priceReview = null; renderDetail(); alertMessage('Принятие подтверждено сервером.'); return; }
    if (acceptance.superseded(data)) { priceReview = null; alertMessage('Загружена новая сохранённая версия. Проверьте данные и отдельно подтвердите принятие.'); }
    if (uncertainMutation) {
      const savedDraft = uncertainMutation.type === 'save' && JSON.stringify(editableOrder(data.order)) === JSON.stringify(editor.draft);
      uncertainMutation = null;
      if (savedDraft) { editor.open(data); renderDetail(); alertMessage('Сохранение подтверждено сервером.'); return; }
      alertMessage('Состояние заказа загружено. Проверьте сохранённую версию перед повтором действия.');
    }
    const result = editor.receive(data);
    if (result === 'updated') { priceReview = null; renderDetail(); }
    else { renderConflict(); renderHistory(); renderIntegration(); }
  } catch (error) { await failure(error); }
}
function validateEdit(body) {
  if (!normalizePhone(body.contact.phone)) throw new StaffError('Проверьте российский номер телефона гостя.');
  body.contact.phone = normalizePhone(body.contact.phone);
  if (!body.items.length || body.items.length > (settings?.maxLines || 50) || body.items.some(item => !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > (settings?.maxQuantity || 99))) throw new StaffError('Проверьте состав и количество порций.');
  if (body.fulfilment.type === 'delivery' && (!body.fulfilment.address.city || !body.fulfilment.address.streetHouse)) throw new StaffError('Заполните город, улицу и дом для доставки.');
  if (body.fulfilment.timing === 'scheduled' && !body.fulfilment.requestedAt) throw new StaffError('Выберите желаемый слот или ближайшее время.');
  if (body.deliveryFeeMinor !== null && (!Number.isSafeInteger(body.deliveryFeeMinor) || body.deliveryFeeMinor < 0)) throw new StaffError('Укажите стоимость доставки в рублях, не меньше нуля.');
  return body;
}
async function save(body = null) {
  const recoveringPrices = priceRecoveryAllowed() && $('price-agreed').checked && body?.priceConfirmationToken === priceReview.token && body.expectedVersion === acceptance.pending.expectedVersion;
  if (busy || acceptance.pending && !recoveringPrices || uncertainMutation || !permissions(editor.detail?.order, actor).edit || editor.conflict) return;
  let payload;
  try { payload = validateEdit(body || { expectedVersion: editor.detail.order.version, ...readForm() }); } catch (error) { await failure(error); return; }
  busy = true; sync();
  try { const received = await client.request(`api/staff/orders/${editor.detail.order.id}`, { method: 'PATCH', body: payload, mutation: true }); let data; try { data = validDetail(received, editor.detail.order.id); } catch { throw new StaffError('Ответ о сохранении неполный. Обновите карточку для проверки.', { uncertain: true }); } acceptance.observe(data) || acceptance.superseded(data); editor.open(data); priceReview = null; alertMessage(''); await refreshCatalog(); renderDetail(); }
  catch (error) { if (error.uncertain) uncertainMutation = { type: 'save' }; await failure(error, { draftBody: payload }); }
  finally { busy = false; sync(); }
}
function showAction(kind) {
  if (busy || editor.dirty || editor.conflict || acceptance.pending || uncertainMutation) return;
  action = kind; $('action-form').reset(); $('action-error').textContent = '';
  const titles = { release: 'Вернуть в новые', reassign: 'Переназначить заказ', contact: 'Не дозвонились', cancel: 'Отменить заказ' };
  $('action-title').textContent = titles[kind]; $('confirm-action').textContent = titles[kind];
  $('action-description').textContent = kind === 'contact' ? 'Запишем попытку связи. Заказ останется на согласовании.' : kind === 'release' ? 'Заказ снова будет доступен команде. Состав и история сохранятся.' : kind === 'reassign' ? 'Выберите сотрудника и укажите причину. Переназначение попадёт в историю.' : 'Отмена сохранится в истории. Принятый заказ нельзя отменить здесь.';
  $('assignee-field').hidden = kind !== 'reassign'; $('cancel-reason-field').hidden = kind !== 'cancel'; $('action-confirm-field').hidden = kind !== 'cancel'; $('duplicate-field').hidden = true;
  $('action-comment-label').textContent = kind === 'reassign' ? 'Причина переназначения' : 'Комментарий';
  $('new-assignee').replaceChildren(new Option('Выберите сотрудника', ''), ...(settings?.staff || []).map(person => new Option(person.name, String(person.id))));
  $('action-dialog').showModal();
}
async function mutate(path, body) {
  if (busy || editor.dirty || editor.conflict || acceptance.pending || uncertainMutation) return;
  busy = true; sync();
  try { const received = await client.request(`api/staff/orders/${editor.detail.order.id}/${path}`, { method: 'POST', body, mutation: true }); let data; try { data = validDetail(received, editor.detail.order.id); } catch { throw new StaffError('Ответ о действии неполный. Обновите карточку для проверки.', { uncertain: true }); } editor.open(data); priceReview = null; $('action-dialog').close(); renderDetail(); alertMessage(''); }
  catch (error) { if (error.uncertain) uncertainMutation = { type: path }; await failure(error); $('action-error').textContent = error.message; }
  finally { busy = false; sync(); }
}
async function loadNotifications() {
  if (actor?.role !== 'manager') return;
  $('notification-panel').hidden = false;
  try {
    const data = await client.request('api/staff/notifications'); const failures = data.failures || [];
    const reasons = { network_unknown: 'Нет подтверждения доставки. Повтор запланирован.', rate_limited: 'Telegram временно ограничил отправку.', bot_blocked: 'Бот заблокирован получателем.', telegram_error: 'Telegram не подтвердил отправку.', order_unavailable: 'Не удалось прочитать заказ для уведомления.' };
    $('notification-failures').replaceChildren(...failures.map(item => { const row = node('div', 'staff-notification'); row.append(node('strong', '', item.orderNumber ? `Заказ № ${item.orderNumber}` : 'Уведомление команды'), node('p', '', reasons[item.error] || 'Уведомление не доставлено. Требуется проверка.')); if (Number.isInteger(item.attempts)) row.append(node('p', '', `Попыток: ${item.attempts}${Number.isFinite(item.nextAttemptAt) ? ` · следующий повтор: ${stamp(new Date(item.nextAttemptAt * 1000).toISOString(), true)}` : ''}`)); if (item.orderId) { const open = node('button', 'staff-text-button', 'Открыть заказ'); open.type = 'button'; open.addEventListener('click', () => openOrder(item.orderId)); row.append(open); } if (item.id) { const retry = node('button', 'staff-text-button', 'Повторить уведомление'); retry.type = 'button'; retry.addEventListener('click', async () => { retry.disabled = true; try { await client.request(`api/staff/notifications/${encodeURIComponent(item.id)}/retry`, { method: 'POST', body: {}, mutation: true }); await loadNotifications(); } catch (error) { await failure(error); retry.disabled = false; } }); row.append(retry); } return row; }));
    if (!failures.length) $('notification-failures').append(node('p', 'staff-help', 'Нет уведомлений, требующих внимания.'));
  } catch (error) { $('notification-failures').replaceChildren(node('p', 'staff-field-error', 'Не удалось обновить состояние уведомлений. Попробуйте обновить список.')); if (isAuthError(error)) await failure(error); }
}
const poll = createVisiblePoll(async () => { if (busy) return; if (!$('staff-detail').hidden) await refreshDetail(); else await loadList(); }, { isVisible: () => !document.hidden && active && !$('staff-app').hidden });
function back() {
  if (busy || acceptance.pending || uncertainMutation) return;
  if (editor.dirty && !confirm('Отбросить несохранённые правки и вернуться к списку?')) return;
  detailGeneration++; editor.clear(); priceReview = null; $('staff-detail').hidden = true; $('staff-list').hidden = false; alertMessage(''); closingWarning();
  try { telegram?.BackButton?.hide(); } catch { /* The visible back control remains available. */ }
  loadList();
}
async function login() {
  $('auth-retry').disabled = true;
  try {
    const session = await client.login(demo ? 'local-demo-only' : telegram?.initData);
    if (actor && actor.id !== session.staff.id) editor.clear(); actor = session.staff;
    $('staff-person').textContent = `${actor.name} · ${actor.role === 'manager' ? 'руководитель' : 'сотрудник'}`;
    $('staff-lock').hidden = true; $('staff-app').hidden = false; $('staff-logout').hidden = false; await loadResources();
    poll.start(); await loadList();
    const query = new URL(location.href).searchParams;
    const start = query.get('tgWebAppStartParam') || new URLSearchParams(telegram?.initData || '').get('start_param') || '';
    const selected = query.get('order') || /^order_([a-f0-9]{32})$/.exec(start)?.[1];
    if (selected && /^[a-f0-9]{32}$/.test(selected)) await openOrder(selected);
  } catch (error) { lock(error.message || 'Доступ только для сотрудников. Откройте приложение из бота кофейни.'); }
  finally { $('auth-retry').disabled = false; }
}
$('auth-retry').addEventListener('click', login);
$('staff-logout').addEventListener('click', async () => { if (editor.dirty && !confirm('Выйти без сохранения правок?')) return; try { await client.logout(); } finally { editor.clear(); actor = null; lock('Вы вышли. Откройте приложение заново из Telegram.'); } });
$('search-form').addEventListener('submit', event => { event.preventDefault(); Object.assign(filter, { query: $('order-search').value.trim(), date: $('filter-date').value || null, mine: $('filter-mine').checked, page: 1 }); loadList(); });
document.querySelectorAll('[data-status]').forEach(button => button.addEventListener('click', () => { filter.status = button.dataset.status; filter.page = 1; document.querySelectorAll('.staff-tabs button').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button))); loadList(); }));
$('previous-page').addEventListener('click', () => { if (filter.page > 1) { filter.page--; loadList(); } }); $('next-page').addEventListener('click', () => { filter.page++; loadList(); });
$('refresh-list').addEventListener('click', loadList); $('refresh-detail').addEventListener('click', async () => { await loadResources().catch(failure); await refreshDetail(); if (editor.detail) { renderMenuResults(); sync(); } }); $('back-list').addEventListener('click', back);
$('load-current').addEventListener('click', () => { if (!acceptance.pending && !uncertainMutation && confirm('Отбросить ваши правки и загрузить сохранённый заказ?')) { editor.discard(); priceReview = null; renderDetail(); } });
$('edit-order').addEventListener('submit', event => { event.preventDefault(); save(); });
$('edit-fields').addEventListener('input', event => {
  if (event.target.id === 'menu-search') return;
  if (event.target.id === 'fulfilment-type') return;
  if (event.target.id === 'guest-phone' && !event.inputType?.startsWith('delete') && event.target.selectionStart === event.target.value.length) event.target.value = formatPhone(event.target.value);
  markDirty();
});
$('edit-fields').addEventListener('change', event => {
  if (event.target.id === 'fulfilment-type') {
    if (editor.draft.fulfilment.type === 'pickup' && $('fulfilment-type').value === 'delivery') $('delivery-fee').value = '';
    fillSelect('requested-slot', slots(), '', 'Выберите желаемое время'); fillSelect('confirmed-slot', slots(), '');
  }
  syncDelivery(); markDirty();
});
$('menu-search').addEventListener('input', renderMenuResults);
$('guest-agreed').addEventListener('change', sync); $('price-agreed').addEventListener('change', sync);
$('approve-prices').addEventListener('click', () => { if (priceReview && $('price-agreed').checked) return save({ ...priceReview.body, priceConfirmationToken: priceReview.token }); });
$('claim-order').addEventListener('click', () => mutate('claim', { expectedVersion: editor.detail.order.version }));
for (const [id, kind] of Object.entries({ 'release-order': 'release', 'reassign-order': 'reassign', 'contact-attempt': 'contact', 'cancel-order': 'cancel' })) $(id).addEventListener('click', () => showAction(kind));
$('close-action').addEventListener('click', () => { if (!busy) $('action-dialog').close(); }); $('action-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('cancel-reason').addEventListener('change', () => { $('duplicate-field').hidden = $('cancel-reason').value !== 'duplicate'; });
$('action-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy || acceptance.pending || uncertainMutation || !editor.detail) return;
  const comment = $('action-comment').value.trim(); const body = { expectedVersion: editor.detail.order.version };
  if (action === 'reassign' && (!$('new-assignee').value || !comment)) { $('action-error').textContent = 'Выберите сотрудника и укажите причину.'; return; }
  if (action === 'cancel' && (!$('cancel-reason').value || !$('action-confirm').checked || $('cancel-reason').value === 'other' && !comment)) { $('action-error').textContent = 'Укажите причину, для «Другое» добавьте текст и подтвердите отмену.'; return; }
  if (action === 'reassign') Object.assign(body, { assigneeId: $('new-assignee').value, reason: comment });
  if (action === 'release') body.reason = comment;
  if (action === 'contact') body.comment = comment;
  if (action === 'cancel') Object.assign(body, { reason: $('cancel-reason').value, comment, confirmed: true, ...($('duplicate-id').value.trim() ? { duplicateOf: $('duplicate-id').value.trim() } : {}) });
  mutate(action === 'contact' ? 'contact-attempts' : action, body);
});
$('accept-order').addEventListener('click', async () => {
  if (busy || uncertainMutation || priceReview && !acceptance.pending || !editor.detail) return;
  if (!acceptance.pending && acceptanceProblems(editor.detail.order, actor, { dirty: editor.dirty, conflict: editor.conflict, catalog, now: now(), agreed: $('guest-agreed').checked, availability: settings?.availability }).length) return;
  busy = true; sync();
  try { const result = await acceptance.run(editor.detail.order.id, editor.detail.order.version); editor.open(result); priceReview = null; renderDetail(); alertMessage(''); }
  catch (error) { await failure(error); }
  finally { busy = false; sync(); }
});
$('retry-integration').addEventListener('click', async () => { if (busy || actor.role !== 'manager') return; busy = true; sync(); try { await client.request(`api/staff/events/${encodeURIComponent(editor.detail.integration.eventId)}/retry`, { method: 'POST', body: { expectedVersion: editor.detail.order.version }, mutation: true }); } catch (error) { await failure(error); } finally { busy = false; await refreshDetail(); sync(); } });
window.addEventListener('beforeunload', event => { if (editor.dirty || acceptance.pending || uncertainMutation || busy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { poll.stop(); client?.forget(); });
window.addEventListener('pageshow', event => { if (event.persisted && !demo) lock('Откройте приложение заново из Telegram для проверки доступа.'); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll.wake(); });
window.addEventListener('focus', () => poll.wake());
window.visualViewport?.addEventListener('resize', () => document.body.classList.toggle('keyboard-open', window.innerHeight - window.visualViewport.height > 140));
if (telegram) {
  telegram.ready(); telegram.expand(); theme();
  telegram.onEvent?.('themeChanged', theme); telegram.onEvent?.('activated', () => { active = true; poll.wake(); }); telegram.onEvent?.('deactivated', () => { active = false; });
  telegram.BackButton?.onClick(back);
}
if (demo) { $('staff-demo-notice').hidden = false; $('demo-link').hidden = true; import('./staff-demo.js').then(({ createDemoClient }) => { client = createDemoClient(); login(); }); }
else { client = createStaffClient({ configured: document.querySelector('meta[name="API_BASE_URL"]')?.content || '' }); if (!telegram?.initData) lock('Доступ только для сотрудников. Откройте «Заказы» кнопкой в боте @vosem_utra_bot.'); else login(); }
