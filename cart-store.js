export const CART_KEY = 'vosem_cart_v1';
export const CART_LIMITS = Object.freeze({ lines: 50, quantity: 99 });

export function cleanLines(value) {
  if (!Array.isArray(value)) return [];
  const lines = new Map();
  for (const item of value) {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(item.id)
      || !Number.isInteger(item.qty) || item.qty < 1) continue;
    if (!lines.has(item.id) && lines.size >= CART_LIMITS.lines) continue;
    lines.set(item.id, Math.min(CART_LIMITS.quantity, (lines.get(item.id) || 0) + item.qty));
  }
  return [...lines].map(([id, qty]) => ({ id, qty }));
}

export function createCartStore(storage) {
  let lines = []; let persisted = true;
  const listeners = new Set();
  try { lines = cleanLines(JSON.parse(storage?.getItem(CART_KEY) || '[]')); } catch { persisted = false; }
  function publish(write = true) {
    if (write) {
      try { if (!storage) throw new Error(); storage.setItem(CART_KEY, JSON.stringify(lines)); persisted = true; }
      catch { persisted = false; }
    }
    for (const listener of listeners) listener(lines.map(line => ({ ...line })));
  }
  return {
    get lines() { return lines.map(line => ({ ...line })); },
    get persisted() { return persisted; },
    add(id) {
      const found = lines.find(line => line.id === id);
      if (found?.qty >= CART_LIMITS.quantity) throw new Error('В одной позиции может быть не больше 99 порций.');
      if (!found && lines.length >= CART_LIMITS.lines) throw new Error('В корзине может быть не больше 50 разных блюд.');
      const next = cleanLines([...lines, { id, qty: 1 }]);
      if (next.length === lines.length && !found) throw new Error('Не удалось добавить блюдо. Обновите меню.');
      lines = next; publish();
    },
    setQuantity(id, qty) {
      if (!Number.isInteger(qty) || qty < 0 || qty > CART_LIMITS.quantity) throw new Error('Укажите от 1 до 99 порций.');
      lines = lines.flatMap(line => line.id !== id ? [line] : qty === 0 ? [] : [{ id, qty }]); publish();
    },
    clear() { lines = []; publish(); },
    consume(ordered) { const quantities = new Map(ordered.map(item => [item.id, item.quantity])); lines = lines.flatMap(line => { const qty = Math.max(0, line.qty - (quantities.get(line.id) || 0)); return qty ? [{ id: line.id, qty }] : []; }); publish(); },
    reload() { try { lines = cleanLines(JSON.parse(storage?.getItem(CART_KEY) || '[]')); publish(false); } catch { /* Keep the visible basket when storage is unavailable. */ } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

export function cartSummary(lines, catalog, previous = []) {
  const byId = new Map(catalog.map(item => [item.id, item]));
  const before = new Map(previous.map(item => [item.id, item]));
  const rows = lines.map(line => {
    const item = byId.get(line.id);
    const old = before.get(line.id);
    const available = !!item && item.published === true && item.availableForOrder !== false && Number.isFinite(item.price) && item.price >= 0;
    const unitMinor = item && Number.isFinite(item.price) ? Math.round(item.price * 100) : null;
    return { ...line, item: item || old || null, available, unitMinor, lineMinor: unitMinor === null ? null : unitMinor * line.qty,
      previousMinor: old && Number.isFinite(old.price) && item && old.price !== item.price ? Math.round(old.price * 100) : null };
  });
  return { rows, count: lines.reduce((sum, line) => sum + line.qty, 0), subtotalMinor: rows.reduce((sum, row) => sum + (row.lineMinor || 0), 0), unavailable: rows.some(row => !row.available) };
}

let storage;
try { storage = globalThis.localStorage; } catch { /* A blocked browser store still permits an in-memory basket. */ }
export const cartStore = createCartStore(storage);
