import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const COOKIE = 'vosem_admin';
const CATEGORIES = new Set(['signature', 'eggs', 'porridge', 'sweet']);
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

export function validateItems(items) {
  if (!Array.isArray(items) || items.length > 300) fail(400, 'Меню должно содержать не более 300 позиций.', 'invalid_items');
  const ids = new Set();
  return items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(400, `Некорректная позиция ${index + 1}.`, 'invalid_item');
    const id = textField(item.id, 'идентификатор', 100, 1);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) || ids.has(id)) fail(400, 'Идентификаторы позиций должны быть уникальными.', 'invalid_id');
    ids.add(id);
    if (!CATEGORIES.has(item.category)) fail(400, 'Выберите категорию завтрака.', 'invalid_category');
    if (typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price < 0 || item.price > 1000000 || Math.abs(item.price * 100 - Math.round(item.price * 100)) > 0.00001) fail(400, 'Укажите корректную цену в рублях.', 'invalid_price');
    if (typeof item.published !== 'boolean') fail(400, 'Укажите видимость позиции.', 'invalid_published');
    if (!Number.isInteger(item.order) || item.order < 0 || item.order > 100000) fail(400, 'Укажите корректный порядок позиции.', 'invalid_order');
    let image = textField(item.image, 'фотография', 250);
    if (image) {
      if (!image.startsWith('/')) image = `/${image}`;
      if (!/^\/(menu-images|uploads)\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:jpe?g|png|webp)$/i.test(image) || image.includes('..')) fail(400, 'Загрузите фотографию JPG, PNG или WebP.', 'invalid_image');
    }
    return { id, name: textField(item.name, 'название', 160, 1), description: textField(item.description, 'описание', 2000), price: item.price, category: item.category, image, published: item.published, order: item.order };
  });
}

function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function makePasswordRecord(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('Пароль администратора должен содержать от 12 до 1024 символов.');
  const salt = randomBytes(32).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return { salt, hash };
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
  const configuredPassword = options.password ?? process.env.ADMIN_PASSWORD;
  const publicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN;
  if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin) throw new Error('PUBLIC_ORIGIN должен содержать только origin, например https://example.ru');
  const sessionMs = options.sessionMs ?? SESSION_MS;
  const sessions = new Map();
  const attempts = new Map();
  let credentials;
  let initialization;
  let writeQueue = Promise.resolve();

  async function readSavedMenu() {
    const saved = JSON.parse(await readFile(menuFile, 'utf8'));
    if (!Number.isSafeInteger(saved.revision) || saved.revision < 1) throw new Error('Некорректная версия сохранённого меню.');
    return { items: validateItems(saved.items), revision: saved.revision };
  }

  function initialize() {
    if (!initialization) initialization = (async () => {
      await mkdir(dataDir, { recursive: true });
      try {
        await readSavedMenu();
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const seed = JSON.parse(await readFile(seedPath, 'utf8'));
        await atomicWrite(menuFile, { items: validateItems(seed.items), revision: 1 });
      }
      if (configuredPassword) credentials = await makePasswordRecord(configuredPassword);
      else {
        try {
          credentials = JSON.parse(await readFile(path.join(dataDir, 'admin-password.json'), 'utf8'));
          if (!/^[a-f0-9]{64}$/.test(credentials.salt) || !/^[a-f0-9]{128}$/.test(credentials.hash)) throw new Error('Некорректный файл пароля администратора.');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    })();
    return initialization;
  }

  function sessionFor(req) {
    const token = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const session = token ? sessions.get(token) : null;
    if (!session || session.expiresAt <= Date.now()) { if (token) sessions.delete(token); return null; }
    return { ...session, token };
  }

  function requireSession(req, csrf = false) {
    const session = sessionFor(req);
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

  function cookie(req, token, maxAge) {
    const secure = req.socket.encrypted || publicOrigin?.startsWith('https://');
    return `${COOKIE}=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
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
        return sendJson(res, 200, { items: menu.items.filter((item) => item.published).sort((a, b) => a.order - b.order) });
      }
      if (pathname === '/api/admin/session' && req.method === 'GET') {
        const session = sessionFor(req);
        return sendJson(res, 200, session ? { authenticated: true, csrfToken: session.csrfToken } : { authenticated: false, configured: Boolean(credentials) });
      }
      if (pathname === '/api/admin/login' && req.method === 'POST') {
        if (!credentials) fail(503, 'Пароль администратора не настроен. Выполните npm run admin:password на сервере.', 'not_configured');
        const body = await readJson(req);
        if (typeof body.password !== 'string' || body.password.length > 1024) fail(400, 'Введите пароль.', 'invalid_password');
        const ip = req.socket.remoteAddress ?? 'unknown';
        const now = Date.now();
        const prior = attempts.get(ip);
        const bucket = prior?.until > now ? prior : { count: 0, until: now + 15 * 60 * 1000 };
        if (bucket.count >= 8) { res.setHeader('Retry-After', Math.ceil((bucket.until - now) / 1000)); fail(429, 'Слишком много попыток. Повторите через 15 минут.', 'rate_limit'); }
        if (attempts.size > 10000) for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
        // Reserve this attempt before yielding. Count includes failures and checks still in flight.
        bucket.count += 1;
        attempts.set(ip, bucket);
        const candidate = (await scrypt(body.password, credentials.salt, 64)).toString('hex');
        if (!equalSecret(candidate, credentials.hash)) fail(401, 'Неверный пароль.', 'invalid_credentials');
        // A successful login refunds only itself; it must not clear concurrent or prior failures.
        bucket.count -= 1;
        if (attempts.get(ip) === bucket && bucket.count === 0) attempts.delete(ip);
        for (const [key, value] of sessions) if (value.expiresAt <= now) sessions.delete(key);
        const previous = sessionFor(req);
        if (previous) sessions.delete(previous.token);
        const token = randomBytes(32).toString('hex');
        const csrfToken = randomBytes(32).toString('hex');
        sessions.set(token, { csrfToken, expiresAt: now + sessionMs });
        res.setHeader('Set-Cookie', cookie(req, token, Math.floor(sessionMs / 1000)));
        return sendJson(res, 200, { authenticated: true, csrfToken });
      }
      if (pathname === '/api/admin/logout' && req.method === 'POST') {
        const session = requireSession(req, true);
        sessions.delete(session.token);
        res.setHeader('Set-Cookie', cookie(req, '', 0));
        return sendJson(res, 200, { authenticated: false });
      }
      if (pathname === '/api/admin/menu' && req.method === 'GET') { requireSession(req); return sendJson(res, 200, await readSavedMenu()); }
      if (pathname === '/api/admin/menu' && req.method === 'PUT') {
        requireSession(req, true);
        const body = await readJson(req);
        const items = validateItems(body.items);
        if (!Number.isSafeInteger(body.revision) || body.revision < 1) fail(400, 'Некорректная версия меню.', 'invalid_revision');
        const write = writeQueue.then(async () => {
          // Reload inside the queue to see completed edits from another server or maintenance tool.
          const menu = await readSavedMenu();
          if (body.revision !== menu.revision) fail(409, 'Меню уже изменено в другой вкладке. Загрузите актуальную версию.', 'conflict');
          const updated = { items, revision: menu.revision + 1 };
          await atomicWrite(menuFile, updated);
          return updated;
        });
        writeQueue = write.catch(() => {});
        return sendJson(res, 200, await write);
      }
      if (pathname === '/api/admin/upload' && req.method === 'POST') {
        requireSession(req, true);
        const mime = req.headers['content-type']?.split(';')[0].trim();
        if (!MIME_EXT[mime]) fail(415, 'Поддерживаются JPG, PNG и WebP.', 'invalid_image_type');
        const buffer = await readBody(req, MAX_IMAGE_BYTES);
        if (detectedImage(buffer) !== mime) fail(400, 'Файл не соответствует выбранному формату фотографии.', 'invalid_image');
        await mkdir(uploadsDir, { recursive: true });
        const name = `${randomUUID()}.${MIME_EXT[mime]}`;
        await writeFile(path.join(uploadsDir, name), buffer, { flag: 'wx', mode: 0o600 });
        return sendJson(res, 201, { url: `/uploads/${name}` });
      }
      fail(404, 'Адрес API не найден.', 'not_found');
    } catch (error) {
      if (error instanceof ApiError) return sendJson(res, error.status, { error: error.message, code: error.code });
      console.error('[menu-api]', error.message);
      return sendJson(res, 500, { error: 'Не удалось выполнить действие. Попробуйте ещё раз.', code: 'server_error' });
    }
  };
}
