export const money = minor => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(minor / 100);
export function resolveApiBase(href, configured = '') {
  const base = new URL(configured || './', href);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Некорректный адрес сервера заказов.');
  if (new URL(href).protocol === 'https:' && base.protocol !== 'https:') throw new Error('Сервер заказов должен использовать HTTPS.');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return base;
}
export function apiBase() { return resolveApiBase(location.href, document.querySelector('meta[name="API_BASE_URL"]')?.content?.trim()); }
export function apiUrl(path) { return new URL(path.replace(/^\//, ''), apiBase()); }
export class OrderError extends Error {
  constructor(message, { status = 0, code = 'network', fields = {}, data = null, uncertain = false } = {}) { super(message); Object.assign(this, { status, code, fields, data, uncertain }); }
}
export async function requestJson(path, { method = 'GET', body, key, csrf, fetcher = fetch } = {}) {
  let response;
  try {
    response = await fetcher(apiUrl(path), { method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}), credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  } catch { throw new OrderError('Не удалось получить ответ сервера. Проверьте подключение.', { uncertain: method === 'POST' }); }
  let data;
  try { if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(); data = await response.json(); }
  catch { throw new OrderError('Сервер заказов недоступен. Заказ не подтверждён.', { status: response.status, code: 'api_unavailable', uncertain: method === 'POST' }); }
  if (!response.ok) throw new OrderError(data.message || data.error || 'Не удалось выполнить действие. Попробуйте ещё раз.', { status: response.status, code: data.code, fields: data.fields || data.details?.fields || {}, data, uncertain: method === 'POST' && response.status >= 500 });
  return data;
}

export async function fetchCatalog({ allowStatic = false } = {}) {
  try {
    const data = await requestJson('api/menu');
    if (!Array.isArray(data.items)) throw new OrderError('Сервер вернул неполное меню.');
    return { ...data, live: true };
  } catch (error) {
    if (!allowStatic || ![404, 405].includes(error.status) && !(error.status >= 200 && error.status < 300 && error.code === 'api_unavailable')) throw error;
    const page = new URL('./', location.href);
    for (const path of ['data/menu.json', 'public/data/menu.json']) {
      const response = await fetch(new URL(path, page), { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
      if (!response.ok) continue;
      const data = await response.json();
      if (Array.isArray(data.items)) return { ...data, live: false, revision: null };
    }
    throw error;
  }
}

export function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (String(value || '').trim().startsWith('+') && !/^7\d{10}$/.test(digits)) return null;
  if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
  if (digits.length === 10) digits = '7' + digits;
  return /^7\d{10}$/.test(digits) ? '+' + digits : null;
}
export function formatPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (String(value || '').trim().startsWith('+') && digits && digits[0] !== '7') return String(value).slice(0, 25);
  if (digits[0] === '8') digits = '7' + digits.slice(1);
  if (digits && digits[0] !== '7') digits = '7' + digits;
  digits = digits.slice(0, 11);
  if (!digits) return '';
  const local = digits.slice(1);
  return '+7' + (local ? ' (' + local.slice(0, 3) : '') + (local.length >= 3 ? ') ' : '') + local.slice(3, 6) + (local.length > 6 ? '-' + local.slice(6, 8) : '') + (local.length > 8 ? '-' + local.slice(8, 10) : '');
}

// The exact serialized request stays in memory across uncertain retries.
export function createSubmission(send, createKey = () => crypto.randomUUID()) {
  let pending = null; let busy = false; let wasUncertain = false;
  return {
    get pending() { return pending !== null; },
    get busy() { return busy; },
    async submit(body) {
      if (busy) throw new OrderError('Дождитесь ответа сервера.', { code: 'busy' });
      if (!pending) { const key = createKey(); pending = { body: JSON.stringify({ ...body, idempotencyKey: key }), key }; }
      busy = true;
      try { const result = await send(pending.body, pending.key); pending = null; wasUncertain = false; return result; }
      catch (error) { wasUncertain ||= error.uncertain === true; if (!wasUncertain) pending = null; throw error; }
      finally { busy = false; }
    },
  };
}
