const $ = (id) => document.getElementById(id);
const categories = {
  signature: 'Фирменные завтраки',
  eggs: 'Яйца и тосты',
  porridge: 'Каши и гранола',
  sweet: 'Сладкое утро',
};
const currency = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 });
const state = { items: [], revision: null, csrfToken: '', busy: false, loaded: false, conflict: false };
const draft = { id: null, isNew: true, image: '', file: null, previewUrl: '', dirty: false, resume: false };
let deleteId = null;

class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = raw ? body.type : 'application/json';
  if (method !== 'GET' && state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
  try {
    const response = await fetch(`/api/admin/${path}`, {
      method, headers, credentials: 'same-origin', cache: 'no-store',
      signal: controller.signal, body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const isJson = response.headers.get('content-type')?.includes('application/json');
    if (!isJson) throw new ApiError('Сервер управления меню недоступен. Статическая версия сайта не сохраняет изменения. Откройте панель на сервере с настроенным ADMIN_PASSWORD.', response.status);
    const data = await response.json();
    if (!response.ok) {
      const detail = typeof data.error === 'string' ? data.error : data.error?.message || data.message;
      throw new ApiError(detail || `Не удалось выполнить запрос (${response.status}). Попробуйте ещё раз.`, response.status);
    }
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error.name === 'AbortError'
      ? 'Сервер не ответил вовремя. Проверьте подключение и попробуйте ещё раз.'
      : 'Не удалось связаться с сервером меню. Проверьте подключение и повторите попытку.');
  } finally {
    clearTimeout(timeout);
  }
}

function message(element, text) {
  element.textContent = text;
  element.hidden = !text;
}

function notice(text, { error = false, refresh = false } = {}) {
  $('dashboard-notice').hidden = !text;
  $('dashboard-notice').classList.toggle('is-error', error);
  $('dashboard-message').textContent = text;
  $('retry-load').hidden = !refresh;
}

function setBusy(busy) {
  state.busy = busy;
  $('dashboard').setAttribute('aria-busy', String(busy));
  $('item-form').setAttribute('aria-busy', String(busy));
  $('editor-fields').disabled = busy;
  for (const id of ['logout', 'add-item', 'refresh', 'retry-load', 'close-editor', 'cancel-editor', 'refresh-draft', 'cancel-delete', 'confirm-delete']) $(id).disabled = busy;
  $('save-item').disabled = busy || state.conflict || !state.loaded;
  $('save-item').textContent = busy ? 'Сохраняем…' : 'Сохранить блюдо';
  document.querySelectorAll('[data-item-action]').forEach((button) => { button.disabled = busy || state.conflict || !state.loaded; });
}

function showLogin(error = '') {
  state.csrfToken = '';
  state.loaded = false;
  $('dashboard').hidden = true;
  $('logout').hidden = true;
  $('connection-status').hidden = true;
  $('login-panel').hidden = false;
  message($('login-error'), error);
}

function sessionExpired(error) {
  if (error.status !== 401) return false;
  if (!state.csrfToken) return true;
  draft.resume = $('editor-dialog').open;
  $('editor-dialog').close();
  $('delete-dialog').close();
  showLogin('Сессия завершилась. Войдите снова, чтобы продолжить. Черновик блюда сохранён в открытой вкладке.');
  $('password').focus();
  return true;
}

function validateMenu(data) {
  if (!Array.isArray(data.items) || data.revision === undefined || data.revision === null) {
    throw new ApiError('Сервер вернул неполные данные меню. Обновите страницу или проверьте настройку сервера.');
  }
  state.items = data.items;
  state.revision = data.revision;
  state.loaded = true;
}

function imageUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value, location.href);
    return url.origin === location.origin && /\/(menu-images|uploads|assets)\//.test(url.pathname) ? url.href : '';
  } catch {
    return '';
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function itemCard(item) {
  const card = element('article', 'admin-item');
  const photo = element('div', 'admin-item-photo');
  const placeholder = element('div', 'admin-item-placeholder');
  const sun = element('span');
  sun.innerHTML = '<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M4.93 19.07 19.07 4.93"/></svg>';
  sun.setAttribute('aria-hidden', 'true');
  placeholder.append(sun, element('p', '', 'Без фотографии'));
  photo.append(placeholder);
  const src = imageUrl(item.image);
  if (src) {
    placeholder.hidden = true;
    const img = element('img');
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => { img.hidden = true; placeholder.hidden = false; });
    img.src = src;
    photo.append(img);
  }
  photo.append(element('span', `item-status${item.published ? '' : ' is-hidden'}`, item.published ? 'На сайте' : 'Скрыто'));
  const body = element('div', 'admin-item-body');
  body.append(element('p', 'item-category', categories[item.category] || 'Завтраки'));
  const title = element('div', 'item-title-row');
  title.append(element('h2', '', item.name), element('p', 'item-price', currency.format(item.price)));
  body.append(title, element('p', 'item-description', item.description || 'Описание пока не добавлено'), element('p', 'item-order', `Порядок в меню: ${item.order}`));
  const actions = element('div', 'item-actions');
  const actionList = [
    ['edit', 'edit-button', 'Редактировать', `Редактировать блюдо «${item.name}»`],
    ['toggle', '', item.published ? 'Скрыть' : 'Показать', `${item.published ? 'Скрыть с сайта' : 'Показать на сайте'} блюдо «${item.name}»`],
    ['delete', 'delete-button', '×', `Удалить блюдо «${item.name}»`],
  ];
  for (const [action, className, label, accessibleLabel] of actionList) {
    const button = element('button', className, label);
    button.type = 'button';
    button.dataset.itemAction = action;
    button.dataset.itemId = item.id;
    button.setAttribute('aria-label', accessibleLabel);
    button.disabled = state.busy || state.conflict || !state.loaded;
    actions.append(button);
  }
  body.append(actions);
  card.append(photo, body);
  return card;
}

function render() {
  const query = $('search').value.trim().toLocaleLowerCase('ru');
  const category = $('category-filter').value;
  const filtered = state.items.filter((item) =>
    (category === 'all' || item.category === category)
    && `${item.name} ${item.description}`.toLocaleLowerCase('ru').includes(query),
  ).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ru'));
  $('total-count').textContent = state.items.length;
  const published = state.items.filter((item) => item.published).length;
  $('published-count').textContent = published;
  $('hidden-count').textContent = state.items.length - published;
  $('results-count').textContent = state.loaded ? `Показано: ${filtered.length} из ${state.items.length}` : 'Загружаем меню…';
  $('items').replaceChildren(...filtered.map(itemCard));
  $('empty-state').hidden = filtered.length !== 0 || !state.loaded;
  $('empty-title').textContent = state.items.length ? 'Ничего не нашлось' : 'Начнём с первого блюда';
  $('empty-description').textContent = state.items.length ? 'Попробуйте другое название или выберите все разделы.' : 'Добавьте название, описание, цену и фотографию.';
}

async function loadMenu({ preserveDraft = false } = {}) {
  if (state.busy) return;
  setBusy(true);
  try {
    validateMenu(await api('menu'));
    if (preserveDraft && draft.isNew && state.items.some((item) => item.id === draft.id)) draft.isNew = false;
    state.conflict = false;
    $('editor-conflict').hidden = true;
    render();
    notice(preserveDraft ? 'Список обновлён. Проверьте открытый черновик перед сохранением.' : 'Меню обновлено.');
    if (preserveDraft) {
      message($('editor-error'), 'Актуальное меню загружено. Ваш черновик сохранён — проверьте его перед повторным сохранением.');
    }
  } catch (error) {
    if (!sessionExpired(error)) {
      notice(error.message, { error: true, refresh: true });
      if (preserveDraft) {
        message($('editor-error'), error.message);
        $('editor-conflict').hidden = false;
      }
    }
  } finally {
    setBusy(false);
    $('add-item').disabled = !state.loaded || state.conflict;
  }
}

async function enterDashboard() {
  $('password').value = '';
  $('login-panel').hidden = true;
  $('connection-status').hidden = true;
  $('dashboard').hidden = false;
  $('logout').hidden = false;
  await loadMenu({ preserveDraft: draft.resume });
  if (draft.resume && state.csrfToken) {
    draft.resume = false;
    $('editor-dialog').showModal();
  }
}

function markConflict(text) {
  state.conflict = true;
  notice(text, { error: true, refresh: true });
  $('editor-conflict').hidden = false;
  $('add-item').disabled = true;
}

async function persist(items) {
  try {
    validateMenu(await api('menu', { method: 'PUT', body: { items, revision: state.revision } }));
    render();
  } catch (error) {
    if (error.status === 409) markConflict('Меню изменилось в другой вкладке. Обновите данные перед следующими изменениями.');
    if (error.status === 0) markConflict('Ответ о сохранении не получен. Обновите меню, чтобы проверить, сохранились ли изменения.');
    sessionExpired(error);
    throw error;
  }
}

function clearPreviewUrl() {
  if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
  draft.previewUrl = '';
}

function updatePreview() {
  const src = draft.previewUrl || imageUrl(draft.image);
  $('preview-image').hidden = !src;
  $('photo-placeholder').hidden = !!src;
  if (src) $('preview-image').src = src;
  else $('preview-image').removeAttribute('src');
  $('remove-photo').hidden = !src;
}

function openEditor(item = null) {
  if (state.busy || !state.loaded || state.conflict) return;
  clearPreviewUrl();
  draft.id = item?.id || crypto.randomUUID();
  draft.isNew = !item;
  draft.image = item?.image || '';
  draft.file = null;
  draft.dirty = false;
  draft.resume = false;
  $('item-form').reset();
  $('item-name').value = item?.name || '';
  $('description').value = item?.description || '';
  $('price').value = item ? item.price : '';
  $('category').value = item?.category || 'signature';
  $('order').value = item ? item.order : Math.min(100000, Math.max(0, ...state.items.map((entry) => entry.order)) + 10);
  $('published').checked = item ? item.published : true;
  $('editor-title').textContent = item ? 'Редактировать блюдо' : 'Добавить блюдо';
  $('editor-eyebrow').textContent = item ? 'ЗАБОТА О ДЕТАЛЯХ' : 'НОВОЕ В МЕНЮ';
  $('editor-conflict').hidden = true;
  message($('editor-error'), '');
  updatePreview();
  $('editor-dialog').showModal();
  $('item-name').focus();
}

function closeEditor() {
  if (state.busy) return;
  if (draft.dirty && !window.confirm('Закрыть редактор? Несохранённые изменения будут потеряны.')) return;
  draft.dirty = false;
  draft.resume = false;
  clearPreviewUrl();
  $('editor-dialog').close();
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('login-submit');
  if (button.disabled) return;
  button.disabled = true;
  $('password').disabled = true;
  button.textContent = 'Входим…';
  message($('login-error'), '');
  try {
    const data = await api('login', { method: 'POST', body: { password: $('password').value } });
    if (!data.authenticated || !data.csrfToken) throw new ApiError('Сервер не подтвердил вход. Проверьте настройку доступа.');
    state.csrfToken = data.csrfToken;
    await enterDashboard();
  } catch (error) {
    message($('login-error'), error.message);
  } finally {
    button.disabled = false;
    $('password').disabled = false;
    button.textContent = 'Войти ↗';
  }
});

$('logout').addEventListener('click', async () => {
  if (state.busy) return;
  setBusy(true);
  try {
    await api('logout', { method: 'POST' });
    state.items = [];
    state.revision = null;
    state.loaded = false;
    state.conflict = false;
    draft.dirty = false;
    draft.resume = false;
    clearPreviewUrl();
    showLogin();
    $('password').focus();
  } catch (error) {
    if (!sessionExpired(error)) notice(error.message, { error: true });
  } finally {
    setBusy(false);
  }
});

$('add-item').addEventListener('click', () => openEditor());
$('search').addEventListener('input', render);
$('category-filter').addEventListener('change', render);
$('refresh').addEventListener('click', () => loadMenu());
$('retry-load').addEventListener('click', () => loadMenu());
$('refresh-draft').addEventListener('click', () => loadMenu({ preserveDraft: true }));
$('close-editor').addEventListener('click', closeEditor);
$('cancel-editor').addEventListener('click', closeEditor);
$('editor-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeEditor(); });
$('item-form').addEventListener('input', () => { draft.dirty = true; });

$('photo').addEventListener('change', () => {
  const file = $('photo').files[0];
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024 || file.size === 0) {
    message($('editor-error'), 'Выберите изображение JPG, PNG или WebP размером до 5 МБ.');
    $('photo').value = '';
    return;
  }
  clearPreviewUrl();
  draft.file = file;
  draft.previewUrl = URL.createObjectURL(file);
  draft.dirty = true;
  message($('editor-error'), '');
  updatePreview();
});
$('preview-image').addEventListener('error', () => {
  $('preview-image').hidden = true;
  $('photo-placeholder').hidden = false;
});
$('remove-photo').addEventListener('click', () => {
  clearPreviewUrl();
  draft.file = null;
  draft.image = '';
  draft.dirty = true;
  $('photo').value = '';
  updatePreview();
});

$('item-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.busy || state.conflict || !state.loaded) return;
  const name = $('item-name').value.trim();
  if (!name) {
    message($('editor-error'), 'Укажите название блюда.');
    $('item-name').focus();
    return;
  }
  if (!draft.isNew && !state.items.some((item) => item.id === draft.id)) {
    message($('editor-error'), 'Это блюдо уже удалено из меню. Скопируйте нужные данные и добавьте его как новое блюдо.');
    return;
  }
  setBusy(true);
  message($('editor-error'), '');
  try {
    if (draft.file) {
      const upload = await api('upload', { method: 'POST', body: draft.file, raw: true });
      if (!upload.url || !imageUrl(upload.url)) throw new ApiError('Сервер не вернул адрес фотографии. Попробуйте загрузить её ещё раз.');
      draft.image = upload.url;
      draft.file = null;
    }
    const item = {
      id: draft.id, name, description: $('description').value.trim(), price: Number($('price').value),
      category: $('category').value, image: draft.image, published: $('published').checked, order: Number($('order').value),
    };
    const items = draft.isNew ? [...state.items, item] : state.items.map((entry) => entry.id === item.id ? item : entry);
    await persist(items);
    draft.dirty = false;
    clearPreviewUrl();
    $('editor-dialog').close();
    notice(item.published ? `«${name}» сохранено и доступно на сайте.` : `«${name}» сохранено. Блюдо скрыто от гостей.`);
  } catch (error) {
    sessionExpired(error);
    message($('editor-error'), error.status === 409 ? 'Не удалось сохранить: меню уже изменилось. Ваш черновик остался в форме.' : error.message);
  } finally {
    setBusy(false);
    $('add-item').disabled = state.conflict || !state.loaded;
  }
});

$('items').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-item-action]');
  if (!button || state.busy || state.conflict) return;
  const item = state.items.find((entry) => entry.id === button.dataset.itemId);
  if (!item) return;
  if (button.dataset.itemAction === 'edit') return openEditor(item);
  if (button.dataset.itemAction === 'delete') {
    deleteId = item.id;
    $('delete-description').textContent = `«${item.name}» будет удалено из меню. Если блюдо ещё пригодится, его можно просто скрыть с сайта.`;
    message($('delete-error'), '');
    $('delete-dialog').showModal();
    return;
  }
  setBusy(true);
  try {
    await persist(state.items.map((entry) => entry.id === item.id ? { ...entry, published: !entry.published } : entry));
    notice(`«${item.name}» ${item.published ? 'скрыто с сайта' : 'снова видно на сайте'}.`);
  } catch (error) {
    if (!state.conflict) notice(error.message, { error: true });
  } finally {
    setBusy(false);
    $('add-item').disabled = state.conflict || !state.loaded;
    [...document.querySelectorAll('[data-item-action="toggle"]')].find((entry) => entry.dataset.itemId === item.id)?.focus();
  }
});

$('cancel-delete').addEventListener('click', () => { if (!state.busy) $('delete-dialog').close(); });
$('delete-dialog').addEventListener('cancel', (event) => { if (state.busy) event.preventDefault(); });
$('confirm-delete').addEventListener('click', async () => {
  if (state.busy || state.conflict || !deleteId) return;
  const item = state.items.find((entry) => entry.id === deleteId);
  if (!item) return $('delete-dialog').close();
  setBusy(true);
  try {
    await persist(state.items.filter((entry) => entry.id !== deleteId));
    $('delete-dialog').close();
    notice(`«${item.name}» удалено из меню.`);
    $('add-item').focus();
  } catch (error) {
    if (state.conflict) $('delete-dialog').close();
    else message($('delete-error'), error.message);
  } finally {
    setBusy(false);
    $('add-item').disabled = state.conflict || !state.loaded;
  }
});

window.addEventListener('beforeunload', (event) => {
  if (draft.dirty && ($('editor-dialog').open || draft.resume)) {
    event.preventDefault();
    event.returnValue = '';
  }
});

try {
  const session = await api('session');
  if (session.authenticated && session.csrfToken) {
    state.csrfToken = session.csrfToken;
    await enterDashboard();
  } else {
    showLogin();
  }
} catch (error) {
  showLogin(error.message);
}
