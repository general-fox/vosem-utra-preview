import { normalizePhone } from './order-client.js';
import { StaffError } from './staff-client.js';

export const STATUS_LABELS = Object.freeze({ new: 'Новый', processing: 'На согласовании', accepted: 'Принят', cancelled: 'Отменён' });
export function permissions(order, actor) {
  if (!actor?.id || !['employee', 'manager'].includes(actor.role)) return { own: false, edit: false, claim: false, release: false, reassign: false, cancel: false, accept: false, retry: false };
  const manager = actor?.role === 'manager'; const own = order?.assignee && String(order.assignee.id) === String(actor?.id);
  const processing = order?.status === 'processing'; const fresh = order?.status === 'new';
  return { own: !!own, edit: !!(processing && own), claim: !!(fresh && !order?.assignee), release: !!(processing && (own || manager)), reassign: !!(manager && (fresh || processing)), cancel: !!(processing && own || fresh && manager), accept: !!(processing && own), retry: manager };
}
export function editableOrder(order) {
  return { items: order.items.map(item => ({ id: item.id, quantity: item.quantity })), contact: { ...order.contact }, fulfilment: structuredClone(order.fulfilment), deliveryFeeMinor: order.deliveryFeeMinor, staffNote: order.staffNote || '', fulfillmentComment: order.fulfillmentComment || '' };
}
export function createEditor() {
  let detail = null; let draft = null; let incoming = null;
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return {
    get detail() { return detail; }, get draft() { return draft; }, get incoming() { return incoming; },
    get dirty() { return !!detail && JSON.stringify(canonical(draft)) !== JSON.stringify(canonical(editableOrder(detail.order))); },
    get conflict() { return incoming !== null; },
    open(value) { detail = structuredClone(value); draft = editableOrder(detail.order); incoming = null; },
    edit(value) { draft = structuredClone(value); },
    receive(value) {
      if (!detail || value.order.id !== detail.order.id) return 'ignored';
      if (value.order.version < Math.max(detail.order.version, incoming?.order.version || 0)) return 'ignored';
      if (value.order.version === detail.order.version) { detail.history = value.history; detail.integration = value.integration; return 'unchanged'; }
      if (this.dirty) { incoming = structuredClone(value); return 'conflict'; }
      this.open(value); return 'updated';
    },
    discard() { if (incoming) this.open(incoming); else if (detail) draft = editableOrder(detail.order); },
    clear() { detail = null; draft = null; incoming = null; },
  };
}
export function acceptanceProblems(order, actor, { dirty = false, conflict = false, catalog = [], now = Date.now(), agreed = false, availability = null } = {}) {
  const reasons = [];
  if (!permissions(order, actor).accept) reasons.push('Заказ должен быть на согласовании и назначен вам.');
  if (dirty) reasons.push('Сначала сохраните изменения.');
  if (conflict) reasons.push('Обновите карточку: сохранённая версия изменилась.');
  if (!order?.items?.length) reasons.push('Состав заказа пуст.');
  const byId = new Map(catalog.map(item => [item.id, item]));
  for (const line of order?.items || []) {
    const current = byId.get(line.id);
    if (!current || !current.published || current.availableForOrder === false) { reasons.push('В составе есть недоступное блюдо. Согласуйте изменения с гостем.'); break; }
    if (Math.round(current.price * 100) !== line.unitPriceMinor) { reasons.push('Цены меню изменились. Сохраните состав по актуальным ценам и согласуйте сумму.'); break; }
  }
  if (!normalizePhone(order?.contact?.phone)) reasons.push('Проверьте телефон гостя.');
  if (order?.fulfilment?.type === 'delivery' && (!order.fulfilment.address?.city?.trim() || !order.fulfilment.address?.streetHouse?.trim())) reasons.push('Заполните адрес доставки.');
  if (!Number.isFinite(Date.parse(order?.fulfilment?.confirmedAt)) || Date.parse(order.fulfilment.confirmedAt) <= now) reasons.push('Установите конкретное согласованное время получения.');
  else if (availability && !availability[order.fulfilment.type]?.slots?.includes(order.fulfilment.confirmedAt)) reasons.push('Согласованное время отсутствует в актуальном расписании. Обновите слот.');
  if (!Number.isSafeInteger(order?.deliveryFeeMinor) || order.deliveryFeeMinor < 0 || !Number.isSafeInteger(order?.totalMinor)) reasons.push('Укажите стоимость доставки и сохраните окончательную сумму.');
  if (!agreed) reasons.push('Подтвердите, что состав, сумма и время согласованы с гостем.');
  return reasons;
}
export function integrationText(integration) {
  const statuses = { waiting_configuration: 'Заказ принят. Ожидает подключения интеграции.', queued: 'Заказ принят. Передача ожидается.', pending: 'Заказ принят. Передача ожидается.', sending: 'Заказ принят. Передача выполняется.', retry_scheduled: 'Заказ принят. Повтор передачи запланирован.', retry: 'Заказ принят. Повтор передачи запланирован.', failed: 'Заказ принят. Не удалось передать — требуется внимание.', delivered: 'Данные доставлены интегратору.', succeeded: 'Данные доставлены интегратору.' };
  return { delivery: statuses[integration?.status] || 'Состояние передачи уточняется.', cashRegister: integration?.cashRegisterStatus === 'not_configured' ? 'Касса: не подключено.' : 'Касса: нет подтверждения создания заказа.' };
}
export function validDetail(data, expectedId) {
  const order = data?.order;
  if (!order || typeof order.id !== 'string' || expectedId && order.id !== expectedId || !Number.isInteger(order.version) || order.version < 1 || !STATUS_LABELS[order.status] || !Array.isArray(order.items) || !order.contact || !order.fulfilment || !Array.isArray(data.history)) throw new StaffError('Сервер вернул неполную карточку. Обновите заказ.', { code: 'invalid_response' });
  return data;
}
export function createAcceptance(send, createKey = () => crypto.randomUUID()) {
  let pending = null; let busy = false;
  return {
    get pending() { return pending; }, get busy() { return busy; },
    async run(id, expectedVersion) {
      if (busy) throw new StaffError('Дождитесь ответа сервера.', { code: 'busy' });
      if (!pending) { const key = createKey(); pending = { id, key, expectedVersion, body: JSON.stringify({ expectedVersion, idempotencyKey: key, agreed: true }), uncertain: false }; }
      busy = true;
      try {
        const received = await send(pending.id, pending.body, pending.key);
        let result;
        try { result = validDetail(received, pending.id); } catch { throw new StaffError('Сервер не подтвердил результат принятия. Проверьте тем же запросом.', { code: 'invalid_response', uncertain: true }); }
        if (result.order.status !== 'accepted' || !result.integration?.eventId) throw new StaffError('Принятие ещё не подтверждено. Проверьте результат тем же запросом.', { uncertain: true, code: 'invalid_response' });
        pending = null; return result;
      } catch (error) { pending.uncertain ||= error.uncertain === true; if (!pending.uncertain) pending = null; throw error; }
      finally { busy = false; }
    },
    observe(data) { if (pending && data.order.id === pending.id && data.order.status === 'accepted' && data.integration?.eventId) { validDetail(data, pending.id); pending = null; return true; } return false; },
    superseded(data) {
      if (!pending || data.order.id !== pending.id || data.order.status === 'accepted' || data.order.version <= pending.expectedVersion) return false;
      validDetail(data, pending.id);
      // A committed, newer non-accepted version makes the frozen acceptance fail
      // its server-side version check, including a delayed original request.
      pending = null; return true;
    },
  };
}
export function createVisiblePoll(refresh, { isVisible = () => !document.hidden, set = setTimeout, clear = clearTimeout, interval = 15000 } = {}) {
  let timer = null; let running = false; let stopped = true;
  function schedule() { if (!stopped) timer = set(tick, interval); }
  async function tick() { timer = null; if (stopped || running || !isVisible()) { schedule(); return; } running = true; try { await refresh(); } catch { /* The refresh handler owns its visible error; polling continues. */ } finally { running = false; schedule(); } }
  return { start() { if (!stopped) return; stopped = false; schedule(); }, stop() { stopped = true; if (timer !== null) clear(timer); timer = null; }, async wake() { if (!stopped && isVisible() && !running) { if (timer !== null) clear(timer); await tick(); } } };
}
