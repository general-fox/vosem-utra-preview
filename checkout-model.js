import { normalizePhone, OrderError } from './order-client.js';

export function localSlot(iso, timezone = 'Europe/Moscow') {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, label: `${parts.day}.${parts.month}.${parts.year}`, value: iso };
  } catch { return null; }
}

export function validateDraft(values, lines, config, now = Date.now()) {
  const errors = {};
  const maxLines = Math.min(50, config?.settings?.maxLines || 50); const maxQuantity = Math.min(99, config?.settings?.maxQuantity || 99);
  if (!['pickup', 'delivery'].includes(values.type)) errors.type = 'Выберите самовывоз или доставку.';
  const phone = normalizePhone(values.phone);
  if (!phone) errors.phone = 'Укажите российский номер из 11 цифр, начиная с +7 или 8.';
  if ((values.name || '').length > 100) errors['guest-name'] = 'Имя должно быть не длиннее 100 символов.';
  if ((values.orderComment || '').length > 1000) errors['order-comment'] = 'Комментарий должен быть не длиннее 1000 символов.';
  if (!lines.length || lines.length > maxLines || lines.some(line => !Number.isInteger(line.qty) || line.qty < 1 || line.qty > maxQuantity)) errors.basket = `В корзине может быть до ${maxLines} разных блюд, до ${maxQuantity} порций каждой позиции.`;
  let address = null;
  if (values.type === 'delivery') {
    address = { city: values.city.trim(), streetHouse: values.streetHouse.trim(), apartment: values.apartment.trim(), entrance: values.entrance.trim(), floor: values.floor.trim(), intercom: values.intercom.trim() };
    if (!address.city) errors.city = 'Укажите город или населённый пункт.';
    if (!address.streetHouse) errors['street-house'] = 'Укажите улицу, дом или строение.';
    for (const [field, limit] of Object.entries({ city: 100, streetHouse: 250, apartment: 50, entrance: 30, floor: 30, intercom: 50 })) if (address[field].length > limit) errors[field === 'streetHouse' ? 'street-house' : field] = `Сократите поле адреса до ${limit} символов.`;
    if (values.courierInstructions.length > 1000) errors['courier-instructions'] = 'Указания курьеру должны быть не длиннее 1000 символов.';
  }
  let requestedAt = null;
  const availability = config?.availability?.[values.type];
  if (values.timing === 'scheduled') {
    if (!values.date) errors['requested-date'] = 'Выберите дату получения.';
    if (!values.slot) errors['requested-time'] = 'Выберите время получения.';
    const slot = values.slot && localSlot(values.slot, config?.settings?.timezone);
    if (values.slot && (!slot || slot.date !== values.date || !availability?.slots?.includes(values.slot) || Date.parse(values.slot) <= now)) errors['requested-time'] = 'Это время недоступно. Выберите актуальный слот.';
    requestedAt = values.slot || null;
  } else if (values.timing !== 'asap' || availability?.asap !== true) errors.timing = 'Ближайшее время недоступно. Выберите дату и время из расписания.';
  if (!values.consent || !config?.settings?.consent?.version) errors.consent = 'Прочитайте и подтвердите условия обработки данных для заказа.';
  return { errors, body: {
    items: lines.map(line => ({ id: line.id, quantity: line.qty })),
    fulfilment: { type: values.type, timing: values.timing, requestedAt, address, courierInstructions: values.type === 'delivery' ? values.courierInstructions.trim() : '' },
    contact: { phone, name: values.name.trim() }, orderComment: values.orderComment.trim(), consent: { accepted: values.consent === true, version: config?.settings?.consent?.version || '' },
  } };
}

function validTotals(value) {
  if (!Array.isArray(value?.items) || !value.items.length || value.items.length > 50 || value.currency !== 'RUB') return false;
  if (new Set(value.items.map(item => item.id)).size !== value.items.length) return false;
  if (value.items.some(item => typeof item.id !== 'string' || typeof item.name !== 'string' || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99 || !Number.isSafeInteger(item.unitPriceMinor) || item.unitPriceMinor < 0 || item.lineTotalMinor !== item.unitPriceMinor * item.quantity)) return false;
  if (!Number.isSafeInteger(value.subtotalMinor) || value.subtotalMinor !== value.items.reduce((sum, item) => sum + item.lineTotalMinor, 0)) return false;
  return value.deliveryFeeMinor === null ? value.totalMinor === null : Number.isSafeInteger(value.deliveryFeeMinor) && value.deliveryFeeMinor >= 0 && value.totalMinor === value.subtotalMinor + value.deliveryFeeMinor;
}
export function validateQuote(value, draft) {
  if (!validTotals(value) || typeof value.quoteId !== 'string' || !value.quoteId || !Number.isInteger(value.menuRevision) || value.menuRevision < 1 || !Number.isFinite(Date.parse(value.expiresAt)) || value.fulfilment?.type !== draft.fulfilment.type
    || value.items.length !== draft.items.length || value.items.some(item => !draft.items.some(line => line.id === item.id && line.quantity === item.quantity))
    || draft.fulfilment.type === 'pickup' && (value.deliveryFeeMinor !== 0 || value.fulfilment.address !== null)) throw new OrderError('Сервер вернул неполный расчёт. Повторите проверку состава.', { code: 'invalid_quote' });
  return value;
}
export function validateReceipt(data) {
  const order = data?.order;
  if (!validTotals(order) || !['string', 'number'].includes(typeof order.number) || !String(order.number).trim() || String(order.number).length > 100 || !Number.isFinite(Date.parse(order.createdAt)) || order.status !== 'new' || !['pickup', 'delivery'].includes(order.fulfilment?.type)) throw new OrderError('Сервер не подтвердил сохранение заказа. Повторите проверку отправки.', { code: 'invalid_receipt', uncertain: true });
  return order;
}
