import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthService, AuthError, equalSecret } from './auth.mjs';
import { enrollmentQr } from './qr.mjs';
import { normalizeMenuCategories, normalizeMenuItems, normalizeMenuSource, normalizeMenuData } from '../menu-categories.js';
export { makePasswordRecord } from './auth.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const COOKIE = 'vosem_admin';
const DEVICE_COOKIE = 'vosem_admin_device';
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new ApiError(status, message, code); };

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function readBody(req, limit) {
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > limit) { req.resume(); fail(413, 'Файл или запрос слишком большой.', 'too_large'); }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAborted); };
    const onError = (error) => { cleanup(); reject(error); };
    const onAborted = () => onError(new ApiError(400, 'Загрузка прервана.', 'aborted'));
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        req.resume();
        reject(new ApiError(413, 'Файл или запрос слишком большой.', 'too_large'));
      } else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onAborted);
  });
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') fail(415, 'Ожидается JSON.', 'content_type');
  const body = await readBody(req, 1024 * 1024);
  try {
    const value = JSON.parse(body.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { fail(400, 'Некорректный JSON.', 'invalid_json'); }
}

function textField(value, field, maximum, minimum = 0) {
  if (typeof value !== 'string' || value.trim().length < minimum || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail(400, `Проверьте поле «${field}».`, 'invalid_item');
  }
  return value.trim();
}

export function validateCategories(categories) {
  try { return normalizeMenuCategories(categories); }
  catch { fail(400, 'Проверьте структуру групп меню.', 'invalid_categories'); }
}

export function validateItems(items, categories = undefined) {
  if (!Array.isArray(items) || items.length > 300) fail(400, 'Меню должно содержать не более 300 позиций.', 'invalid_items');
  const tree = validateCategories(categories);
  try { items = normalizeMenuItems(items, tree); }
  catch { fail(400, 'Выберите группу меню.', 'invalid_category'); }
  const ids = new Set();
  return items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(400, `Некорректная позиция ${index + 1}.`, 'invalid_item');
    const id = textField(item.id, 'идентификатор', 100, 1);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) || ids.has(id)) fail(400, 'Идентификаторы позиций должны быть уникальными.', 'invalid_id');
    ids.add(id);
    if (typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price < 0 || item.price > 1000000 || Math.abs(item.price * 100 - Math.round(item.price * 100)) > 0.00001) fail(400, 'Укажите корректную цену в рублях.', 'invalid_price');
    if (typeof item.published !== 'boolean') fail(400, 'Укажите видимость позиции.', 'invalid_published');
    if (Object.hasOwn(item, 'hiddenOnSite') && typeof item.hiddenOnSite !== 'boolean') fail(400, 'Укажите видимость позиции.', 'invalid_visibility');
    let availableForOrder = Object.hasOwn(item, 'availableForOrder') ? item.availableForOrder : true;
    if (typeof availableForOrder !== 'boolean') fail(400, 'Укажите доступность позиции для заказа.', 'invalid_availability');
    if (!Number.isInteger(item.order) || item.order < 0 || item.order > 100000) fail(400, 'Укажите корректный порядок позиции.', 'invalid_order');
    let image = textField(item.image, 'фотография', 250);
    if (image) {
      if (!image.startsWith('/')) image = `/${image}`;
      if (!/^\/(menu-images|uploads)\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:jpe?g|png|webp)$/i.test(image) || image.includes('..')) fail(400, 'Загрузите фотографию JPG, PNG или WebP.', 'invalid_image');
    }
    let source;
    try { source = normalizeMenuSource(item.source); } catch { fail(400, 'Некорректный источник блюда.', 'invalid_source'); }
    if (source?.testOnly || item.category === null || item.hiddenOnSite === true) availableForOrder = false;
    return { id, name: textField(item.name, 'название', 160, 1), description: textField(item.description, 'описание', 2000), price: item.price, category: item.category, image, published: item.hiddenOnSite === true ? false : item.published, availableForOrder, order: item.order, ...(source ? { source } : {}), ...(Object.hasOwn(item, 'hiddenOnSite') ? { hiddenOnSite: item.hiddenOnSite } : {}) };
  });
}

function validateMenuData(menu, options = {}) {
  try {
    const data = normalizeMenuData(menu, options);
    // Persisted website groups are flat. Public response normalizers remain separate:
    // they must retain effective stop-list restrictions from the server.
    const categories = data.categories.map(category => ({ ...category, parentId:null }));
    const items = data.items.map(item => ({ ...item, published:item.category !== null && item.hiddenOnSite !== true,
      availableForOrder:item.category !== null && item.hiddenOnSite !== true && item.source?.testOnly !== true }));
    return { ...data, categories, items:validateItems(items, categories) };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(400, 'Проверьте группы сайта и каталог кассы. Выберите для блюда группу на сайте.', 'invalid_category_mapping');
  }
}
export { validateMenuData as normalizeStoredMenu };

function validateCatalogEdit(body, menu) {
  const sourceError = () => fail(400, 'Источник блюда и группы кассы изменяются только при выгрузке из кассы.', 'immutable_source');
  const sameSource = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (Object.hasOwn(body, 'sourceCategories')) {
    let submitted;
    try { submitted = normalizeMenuCategories(body.sourceCategories); } catch { sourceError(); }
    if (!sameSource(submitted, menu.sourceCategories)) sourceError();
  }
  if (Array.isArray(body.categories) && body.categories.some(group => group?.source != null)) sourceError();
  if (Array.isArray(body.categories) && body.categories.some(group => group?.parentId != null)) {
    fail(400, 'Группы сайта находятся на одном уровне. Вложенность сохраняется только в меню кассы.', 'flat_site_groups');
  }
  const existing = new Map(menu.items.map(item => [item.id, item]));
  const submittedItems = Object.hasOwn(body, 'items') ? body.items : menu.items;
  if (!Array.isArray(submittedItems)) fail(400, 'Меню должно содержать не более 300 позиций.', 'invalid_items');
  const items = submittedItems.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(400, 'Некорректная позиция меню.', 'invalid_item');
    const previous = existing.get(item.id);
    if (!previous) fail(400, 'Блюда добавляются только при выгрузке из кассы.', 'import_only');
    if (Object.hasOwn(item, 'source')) {
      let submitted;
      try { submitted = normalizeMenuSource(item.source); } catch { sourceError(); }
      if (!sameSource(submitted, previous.source)) sourceError();
    }
    // Legacy clients may omit source metadata. It is always owned by the importer.
    const result = { ...item };
    if (previous.source) result.source = previous.source;
    else delete result.source;
    return result;
  });
  return validateMenuData({ ...menu, ...body, sourceCategories:menu.sourceCategories, items }, { allowLegacyMappings:false });
}

async function atomicWrite(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, filename);
}

function detectedImage(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (buffer.length >= 20 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(buffer.toString('ascii', 12, 16))) return 'image/webp';
  return null;
}

/** A single instance must be shared for all requests to preserve sessions and writes. */
export function createMenuMiddleware(options = {}) {
  const projectRoot = options.projectRoot ?? ROOT;
  const dataDir = options.dataDir ?? path.join(projectRoot, '.data');
  const menuFile = path.join(dataDir, 'menu.json');
  const uploadsDir = path.join(dataDir, 'uploads');
  const seedPath = options.seedPath ?? path.join(projectRoot, 'public', 'data', 'menu.json');
  const publicOrigin = Object.hasOwn(options, 'publicOrigin') ? options.publicOrigin : process.env.PUBLIC_ORIGIN;
  const auth = createAuthService({ ...options, dataDir, publicOrigin });
  let initialization;
  let writeQueue = Promise.resolve();

  async function readSavedMenu({ locked = false } = {}) {
    const read = async () => {
      const raw = await readFile(menuFile, 'utf8');
      const saved = JSON.parse(raw);
      if (!Number.isSafeInteger(saved.revision) || saved.revision < 1 || saved.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Некорректная версия сохранённого меню.');
      const normalized = validateMenuData(saved);
      const migrated = saved.categories?.some(category => category.source || category.parentId != null) || saved.categoryMappings?.length
        || saved.items?.some((item, index) => item.published !== normalized.items[index].published
          || (item.availableForOrder ?? true) !== normalized.items[index].availableForOrder);
      const menu = { ...normalized, revision:saved.revision + (migrated ? 1 : 0) };
      if (migrated) {
        const backup = path.join(dataDir, `menu-before-flat-groups-${saved.revision}-${randomUUID()}.json`);
        await writeFile(backup, raw, { mode:0o600, flag:'wx' });
        await atomicWrite(menuFile, menu);
      }
      return menu;
    };
    if (locked) return read();
    const reading = writeQueue.then(read);
    writeQueue = reading.catch(() => {});
    return reading;
  }

  function initialize() {
    if (!initialization) initialization = (async () => {
      await mkdir(dataDir, { recursive: true });
      try {
        await readSavedMenu();
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const seed = JSON.parse(await readFile(seedPath, 'utf8'));
        await atomicWrite(menuFile, { ...validateMenuData(seed), revision: 1 });
      }
    })();
    return initialization;
  }

  const sessionToken = (req) => req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const deviceToken = (req) => req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${DEVICE_COOKIE}=`))?.slice(DEVICE_COOKIE.length + 1);
  const peer = (req) => req.socket.remoteAddress ?? 'unknown';

  async function requireSession(req, csrf = false) {
    const session = await auth.session(sessionToken(req));
    if (!session) fail(401, 'Войдите в панель управления.', 'unauthorized');
    if (csrf && !equalSecret(req.headers['x-csrf-token'], session.csrfToken)) fail(403, 'Сессия устарела. Обновите страницу и повторите действие.', 'csrf');
    return session;
  }

  function checkOrigin(req) {
    const protocol = req.socket.encrypted ? 'https' : 'http';
    const host = req.headers.host;
    if (!host || !/^[a-zA-Z0-9.:[\]-]+$/.test(host)) fail(403, 'Некорректный адрес запроса.', 'origin');
    const expected = publicOrigin ?? `${protocol}://${host}`;
    if (req.headers.origin !== expected || req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Запрос должен быть отправлен с этого сайта.', 'origin');
  }

  function cookie(req, token, maxAge, name = COOKIE) {
    const secure = req.socket.encrypted || publicOrigin?.startsWith('https://');
    return `${name}=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  async function serveUpload(req, res, pathname) {
    const name = pathname.slice('/uploads/'.length);
    if (!/^[a-f0-9-]{36}\.(jpg|png|webp)$/.test(name)) fail(404, 'Фотография не найдена.', 'not_found');
    const filename = path.join(uploadsDir, name);
    try {
      const resolved = await realpath(filename);
      const root = await realpath(uploadsDir);
      if (path.dirname(resolved) !== root || !(await stat(resolved)).isFile()) fail(404, 'Фотография не найдена.', 'not_found');
      const content = await readFile(resolved);
      const ext = path.extname(name).slice(1);
      res.writeHead(200, { 'Content-Type': ext === 'jpg' ? 'image/jpeg' : `image/${ext}`, 'Content-Length': content.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) { if (error.code === 'ENOENT') fail(404, 'Фотография не найдена.', 'not_found'); throw error; }
  }

  return async function menuMiddleware(req, res, next) {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { return sendJson(res, 400, { error: 'Некорректный адрес.', code: 'invalid_url' }); }
    const segments = pathname.replaceAll('\\', '/').split('/');
    if (segments.some((segment) => ['.data', '.git', 'server'].includes(segment.toLowerCase()) || segment.toLowerCase().startsWith('.env'))) return sendJson(res, 404, { error: 'Страница не найдена.', code: 'not_found' });
    if (!pathname.startsWith('/api/') && !pathname.startsWith('/uploads/') && pathname !== '/data/menu.json') return next?.();
    try {
      if (pathname.startsWith('/uploads/')) {
        if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'Метод не поддерживается.', 'method');
        return await serveUpload(req, res, pathname);
      }
      await initialize();
      if (!['GET', 'HEAD'].includes(req.method)) checkOrigin(req);
      if (['/api/menu', '/data/menu.json'].includes(pathname) && req.method === 'GET') {
        const menu = await readSavedMenu();
        return sendJson(res, 200, { categories: menu.categories, items: menu.items.filter((item) => item.published && item.category !== null).sort((a, b) => a.order - b.order), revision: menu.revision });
      }
      if (pathname === '/api/admin/session' && req.method === 'GET') {
        return sendJson(res, 200, await auth.status(sessionToken(req), deviceToken(req)));
      }
      if (pathname === '/api/admin/activity' && req.method === 'POST') {
        await requireSession(req, true);
        return sendJson(res, 200, await auth.activity(sessionToken(req)));
      }
      if (pathname === '/api/admin/resume' && req.method === 'POST') return sendJson(res, 202, await auth.resume(deviceToken(req), peer(req)));
      if (pathname === '/api/admin/forget-device' && req.method === 'POST') {
        if (await auth.session(sessionToken(req))) await requireSession(req, true);
        await auth.logout(sessionToken(req), peer(req));
        await auth.forgetDevice(deviceToken(req));
        res.setHeader('Set-Cookie', [cookie(req, '', 0), cookie(req, '', 0, DEVICE_COOKIE)]);
        return sendJson(res, 200, { ...await auth.status(), forgotten: true });
      }
      if (pathname === '/api/admin/enroll/start' && req.method === 'POST') {
        const result = await auth.enrollmentStart(await readJson(req), peer(req));
        try { return sendJson(res, 200, { ...result, qrDataUrl: await enrollmentQr(result.otpauthUri) }); }
        catch (error) { await auth.enrollmentCancel({ enrollmentToken: result.enrollmentToken }, peer(req)); throw error; }
      }
      if (pathname === '/api/admin/enroll/cancel' && req.method === 'POST') return sendJson(res, 200, await auth.enrollmentCancel(await readJson(req), peer(req)));
      if (['/api/admin/login', '/api/admin/verify', '/api/admin/enroll/confirm'].includes(pathname) && req.method === 'POST') {
        const body = await readJson(req);
        const result = pathname.endsWith('/confirm') ? await auth.enrollmentConfirm(body, peer(req)) : pathname.endsWith('/verify') ? await auth.verify(body, peer(req), deviceToken(req)) : await auth.login(body, peer(req), sessionToken(req));
        if (result.mfaRequired || result.enrollmentRequired) return sendJson(res, 202, result);
        await auth.forgetDevice(deviceToken(req));
        res.setHeader('Set-Cookie', [cookie(req, result.token, Math.floor(auth.sessionMs / 1000)), cookie(req, result.deviceToken ?? '', result.deviceMaxAge ?? 0, DEVICE_COOKIE)]);
        return sendJson(res, 200, { authenticated: true, username: result.username, csrfToken: result.csrfToken, session: result.session, ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}) });
      }
      if (pathname === '/api/admin/logout' && req.method === 'POST') {
        // An already idle session may log out/forget; active sessions need CSRF.
        const body = req.headers['content-type'] || Number(req.headers['content-length'] || 0) > 0 ? await readJson(req) : {};
        if (Object.hasOwn(body, 'forgetDevice') && typeof body.forgetDevice !== 'boolean') fail(400, 'Некорректный запрос.', 'invalid_request');
        const active = await auth.session(sessionToken(req));
        if (active) await requireSession(req, true);
        await auth.logout(sessionToken(req), peer(req));
        if (body.forgetDevice === true) await auth.forgetDevice(deviceToken(req));
        res.setHeader('Set-Cookie', [cookie(req, '', 0), ...(body.forgetDevice === true ? [cookie(req, '', 0, DEVICE_COOKIE)] : [])]);
        return sendJson(res, 200, await auth.status(undefined, body.forgetDevice === true ? undefined : deviceToken(req)));
      }
      if (pathname === '/api/admin/menu' && req.method === 'GET') { await requireSession(req); return sendJson(res, 200, await readSavedMenu()); }
      if (pathname === '/api/admin/menu' && req.method === 'PUT') {
        await requireSession(req, true);
        const body = await readJson(req);
        if (!Number.isSafeInteger(body.revision) || body.revision < 1) fail(400, 'Некорректная версия меню.', 'invalid_revision');
        const write = writeQueue.then(async () => {
          // Reload inside the queue to see completed edits from another server or maintenance tool.
          const menu = await readSavedMenu({ locked:true });
          if (body.revision !== menu.revision) fail(409, 'Меню уже изменено в другой вкладке. Загрузите актуальную версию.', 'conflict');
          const data = validateCatalogEdit(body, menu);
          const updated = { ...data, revision: menu.revision + 1 };
          // The body/queue may outlive an idle timeout or an explicit logout.
          // Recheck immediately before committing, without extending the deadline.
          await requireSession(req, true);
          await atomicWrite(menuFile, updated);
          await auth.audit('menu.updated', peer(req), { revision: updated.revision, count: updated.items.length });
          return updated;
        });
        writeQueue = write.catch(() => {});
        return sendJson(res, 200, await write);
      }
      if (pathname === '/api/admin/upload' && req.method === 'POST') {
        await requireSession(req, true);
        const mime = req.headers['content-type']?.split(';')[0].trim();
        if (!MIME_EXT[mime]) fail(415, 'Поддерживаются JPG, PNG и WebP.', 'invalid_image_type');
        const buffer = await readBody(req, MAX_IMAGE_BYTES);
        if (detectedImage(buffer) !== mime) fail(400, 'Файл не соответствует выбранному формату фотографии.', 'invalid_image');
        await requireSession(req, true);
        await mkdir(uploadsDir, { recursive: true });
        const name = `${randomUUID()}.${MIME_EXT[mime]}`;
        await writeFile(path.join(uploadsDir, name), buffer, { flag: 'wx', mode: 0o600 });
        await auth.audit('image.uploaded', peer(req));
        return sendJson(res, 201, { url: `/uploads/${name}` });
      }
      fail(404, 'Адрес API не найден.', 'not_found');
    } catch (error) {
      if (error instanceof ApiError || error instanceof AuthError) {
        if (error.retryAfter) res.setHeader('Retry-After', error.retryAfter);
        return sendJson(res, error.status, { error: error.message, code: error.code });
      }
      console.error('[menu-api]', error.message);
      return sendJson(res, 500, { error: 'Не удалось выполнить действие. Попробуйте ещё раз.', code: 'server_error' });
    }
  };
}
