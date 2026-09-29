import { StaffError } from './staff-client.js';

// Deliberately local fixtures: this adapter never calls an API or Telegram.
export function createDemoClient() {
  const actor = { id: '10001', name: 'Тестовый руководитель', role: 'manager' };
  const colleague = { id: '10002', name: 'Тестовый сотрудник', role: 'employee' };
  const menu = [
    { id: 'morning-eight', name: 'Завтрак «8 утра»', price: 1190, published: true, availableForOrder: true },
    { id: 'avocado-toast', name: 'Авокадо-тост с яйцом пашот и гуакамоле', price: 590, published: true, availableForOrder: true },
    { id: 'chef-syrniki', name: 'Сырники от шефа', price: 810, published: true, availableForOrder: true },
  ];
  const now = Date.now(); const slots = Array.from({ length: 20 }, (_, i) => new Date(Math.ceil(now / 1800000) * 1800000 + (i + 2) * 1800000).toISOString());
  const history = new Map(); const integrations = new Map(); const acceptedKeys = new Map();
  const records = ['new', 'processing', 'accepted', 'cancelled'].map((status, i) => {
    const id = String(i + 1).padStart(32, '0'); const item = menu[i % menu.length]; const delivery = i % 2 === 1;
    const order = { id, number: `ДЕМО-00${i + 1}`, version: 1, status, assignee: status === 'processing' || status === 'accepted' ? actor : null,
      createdAt: new Date(now - (i + 1) * 420000).toISOString(), updatedAt: new Date(now - i * 120000).toISOString(), acceptedAt: status === 'accepted' ? new Date(now).toISOString() : null, acceptedBy: status === 'accepted' ? actor : null,
      contact: { phone: '+7000000000' + (i + 1), name: `Тестовый гость ${i + 1}` },
      fulfilment: { type: delivery ? 'delivery' : 'pickup', timing: i % 2 === 1 ? 'scheduled' : 'asap', requestedAt: i % 2 === 1 ? slots[3] : null, confirmedAt: status === 'accepted' ? slots[3] : null,
        address: delivery ? { city: 'Тестовый город', streetHouse: 'Примерная улица, дом 0', apartment: '', entrance: '', floor: '', intercom: '' } : null, courierInstructions: delivery ? 'Вымышленный адрес для демонстрации.' : '' },
      items: [{ id: item.id, name: item.name, quantity: 1, unitPriceMinor: item.price * 100, lineTotalMinor: item.price * 100 }], subtotalMinor: item.price * 100,
      deliveryFeeMinor: delivery ? null : 0, totalMinor: delivery ? null : item.price * 100, currency: 'RUB', orderComment: 'Тестовый комментарий гостя. Не выполнять заказ.', staffNote: '', fulfillmentComment: '', menuRevision: 1,
      payment: { method: null, status: 'not_configured', paidAmountMinor: null } };
    history.set(id, [{ event: 'created', version: 1, at: order.createdAt, author: { id: 'guest', name: 'Гость' }, changes: [] }]);
    if (status === 'accepted') integrations.set(id, { eventId: 'demo-event-' + id, status: 'waiting_configuration', cashRegisterStatus: 'not_configured' });
    return order;
  });
  function detail(order) { return structuredClone({ order, history: history.get(order.id), integration: integrations.get(order.id) || null }); }
  function recalculate(order) {
    order.items = order.items.map(line => { const item = menu.find(item => item.id === line.id); if (!item || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) throw new StaffError('Проверьте состав тестового заказа.', { status: 422 }); return { id: item.id, name: item.name, quantity: line.quantity, unitPriceMinor: item.price * 100, lineTotalMinor: item.price * 100 * line.quantity }; });
    order.subtotalMinor = order.items.reduce((sum, item) => sum + item.lineTotalMinor, 0);
    if (order.fulfilment.type === 'pickup') { order.fulfilment.address = null; order.fulfilment.courierInstructions = ''; order.deliveryFeeMinor = 0; }
    order.totalMinor = order.deliveryFeeMinor === null ? null : order.subtotalMinor + order.deliveryFeeMinor;
  }
  return {
    async login() { return { staff: actor, expiresAt: new Date(now + 7200000).toISOString() }; }, async logout() {}, forget() {},
    async request(path, { method = 'GET', body = {} } = {}) {
      const data = typeof body === 'string' ? JSON.parse(body) : structuredClone(body);
      if (path === 'api/menu') return { items: structuredClone(menu), revision: 1 };
      if (path === 'api/staff/settings') return { timezone: 'Europe/Moscow', availability: { pickup: { asap: true, slots }, delivery: { asap: true, slots } }, delivery: { mode: 'confirm_by_phone' }, maxLines: 50, maxQuantity: 99, staff: [actor, colleague], serverNow: new Date().toISOString() };
      if (path === 'api/staff/notifications') return { enabled: true, counts: [], failures: [] };
      if (path === 'api/staff/orders/search') {
        let orders = records.filter(order => (!data.status || order.status === data.status) && (!data.mine || order.assignee?.id === actor.id) && (!data.query || [order.number, order.contact.phone].some(value => value.toLowerCase().includes(data.query.toLowerCase()))) && (!data.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(order.createdAt)) === data.date));
        return { orders: structuredClone(orders.slice((data.page - 1) * data.pageSize, data.page * data.pageSize)), total: orders.length, page: data.page, pageSize: data.pageSize, serverNow: new Date().toISOString() };
      }
      const match = /^api\/staff\/orders\/([a-f0-9]{32})(?:\/([a-z-]+))?$/.exec(path); const order = match && records.find(order => order.id === match[1]);
      if (!order) throw new StaffError('Тестовый заказ не найден.', { status: 404 });
      const action = match[2];
      if (method === 'GET') return detail(order);
      if (action === 'accept' && acceptedKeys.has(data.idempotencyKey)) return structuredClone(acceptedKeys.get(data.idempotencyKey));
      if (data.expectedVersion !== order.version) throw new StaffError('Версия изменилась.', { status: 409, code: 'version_conflict', details: { current: detail(order) } });
      if (['accepted', 'cancelled'].includes(order.status)) throw new StaffError('Этот заказ доступен только для просмотра.', { status: 409 });
      let event = action || 'updated';
      if (method === 'PATCH') { for (const field of ['items', 'contact', 'fulfilment', 'deliveryFeeMinor', 'staffNote', 'fulfillmentComment']) order[field] = data[field]; recalculate(order); }
      else if (action === 'claim') { order.status = 'processing'; order.assignee = actor; }
      else if (action === 'release') { order.status = 'new'; order.assignee = null; }
      else if (action === 'reassign') { order.assignee = [actor, colleague].find(person => person.id === data.assigneeId); if (!order.assignee) throw new StaffError('Выберите тестового сотрудника.'); order.status = 'processing'; }
      else if (action === 'cancel') { if (!data.confirmed || !data.reason) throw new StaffError('Подтвердите причину отмены.'); order.status = 'cancelled'; event = 'cancelled'; }
      else if (action === 'contact-attempts') event = 'contact_attempt';
      else if (action === 'accept') {
        if (!data.agreed || !order.fulfilment.confirmedAt || order.deliveryFeeMinor === null || !order.items.length) throw new StaffError('Согласуйте время, стоимость и состав.', { status: 422 });
        order.status = 'accepted'; order.acceptedAt = new Date().toISOString(); order.acceptedBy = actor; event = 'accepted'; integrations.set(order.id, { eventId: 'demo-event-' + order.id, status: 'waiting_configuration', cashRegisterStatus: 'not_configured' });
      } else throw new StaffError('Действие отсутствует в демонстрации.');
      order.version++; order.updatedAt = new Date().toISOString(); history.get(order.id).push({ event, version: order.version, at: order.updatedAt, author: actor, changes: [], reason: data.reason || null, comment: data.comment || null });
      const result = detail(order); if (action === 'accept') acceptedKeys.set(data.idempotencyKey, result); return result;
    },
  };
}
