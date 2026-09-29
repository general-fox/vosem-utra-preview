import { resolveApiBase } from './order-client.js';

export class StaffError extends Error {
  constructor(message, { status = 0, code = 'network', details = {}, uncertain = false } = {}) { super(message); Object.assign(this, { status, code, details, uncertain }); }
}
export function createStaffClient({ href = location.href, configured = '', fetcher = fetch, now = Date.now } = {}) {
  const base = resolveApiBase(href, configured);
  let token = ''; let expiresAt = 0;
  async function request(path, { method = 'GET', body, mutation = false, authenticated = true, key } = {}) {
    if (authenticated && (!token || expiresAt <= now())) { token = ''; throw new StaffError('Сессия завершилась. Откройте приложение заново из Telegram.', { status: 401, code: 'session_expired' }); }
    let response;
    try {
      response = await fetcher(new URL(path, base), { method, headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}), cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15000) });
    } catch { throw new StaffError('Нет ответа сервера. Проверьте подключение и повторите запрос.', { uncertain: mutation }); }
    let result;
    try { if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(); result = await response.json(); }
    catch { throw new StaffError('Сервер не подтвердил действие. Повторите проверку.', { status: response.status, code: 'invalid_response', uncertain: mutation }); }
    if (!response.ok) {
      if (response.status === 401) { token = ''; expiresAt = 0; }
      throw new StaffError(result.error || result.message || 'Не удалось выполнить действие.', { status: response.status, code: result.code || 'request_failed', details: result.details || {}, uncertain: mutation && response.status >= 500 });
    }
    return result;
  }
  return {
    async login(initData) {
      if (typeof initData !== 'string' || !initData.trim()) throw new StaffError('Откройте приложение кнопкой в боте кофейни.', { code: 'telegram_required' });
      const data = await request('api/staff/session', { method: 'POST', body: { initData }, authenticated: false });
      if (typeof data.token !== 'string' || data.token.length < 20 || !Number.isFinite(Date.parse(data.expiresAt)) || !/^\d+$/.test(String(data.staff?.id)) || !['employee', 'manager'].includes(data.staff?.role)) throw new StaffError('Не удалось подтвердить доступ сотрудника.', { code: 'invalid_session' });
      token = data.token; expiresAt = Math.min(Date.parse(data.expiresAt), now() + 2 * 60 * 60 * 1000);
      return { staff: data.staff, expiresAt: new Date(expiresAt).toISOString() };
    },
    request,
    async logout() { try { if (token) await request('api/staff/logout', { method: 'POST', body: {}, mutation: true }); } finally { token = ''; expiresAt = 0; } },
    forget() { token = ''; expiresAt = 0; },
  };
}
