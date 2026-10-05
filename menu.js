import { normalizeMenuCategories, normalizeMenuData, categoryDescendantIds, categoryPath, orderedCategories } from './menu-categories.js';

const root = document.querySelector('[data-breakfast-menu]');
const deliveryEnabled = document.querySelector('meta[name="cafe-profile"]')?.content !== 'catalog';
let categories = normalizeMenuCategories();
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const pageBase = new URL('./', location.href);
const configuredApi = document.querySelector('meta[name="API_BASE_URL"]')?.content?.trim();
const apiBase = new URL(configuredApi ? configuredApi.replace(/\/?$/, '/') : './', location.href);
let items = [];
let selected = null;
let loading = false;
const cards = new Map();
const navigation = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function dishCard(item) {
  const path = categoryPath(categories, item.category);
  const category = path.at(-1);
  const testOnly = item.source?.testOnly === true || path.some(category => category.source?.testOnly === true);
  const signature = JSON.stringify([item, category?.name, testOnly]);
  const cached = cards.get(item.id);
  if (cached?.signature === signature) return cached.card;
  const card = element('article', `dish-card${item.image ? '' : ' dish-card-text'}`);
  card.dataset.reveal = 'visual';
  card.dataset.revealKey = `dish:${item.id}`;
  card.dataset.menuCategory = item.category;
  if (item.image) {
    const visual = element('div', 'dish-visual');
    const img = element('img', 'dish-photo');
    img.src = new URL(item.image, pageBase).href;
    img.alt = item.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.width = 600;
    img.height = 450;
    img.addEventListener('error', () => {
      visual.replaceChildren(element('span', 'dish-image-fallback', 'Фото скоро появится'));
    }, { once: true });
    visual.append(img);
    card.append(visual);
  }
  const body = element('div', 'dish-body');
  body.append(element('p', 'dish-category', `${testOnly ? 'Тестовое блюдо · ' : ''}${category?.name || 'Меню'}`));
  const heading = element('div', 'dish-heading');
  const priceUnset = testOnly && item.price === 0;
  heading.append(element('h3', '', item.name), element('span', `dish-price${priceUnset ? ' is-unset' : ''}`, priceUnset ? 'Цена уточняется' : money.format(item.price)));
  body.append(heading, element('p', 'dish-description', item.description));
  if (deliveryEnabled) {
  const available = item.availableForOrder !== false && !testOnly;
  const add = element('button', `dish-order-button${available ? '' : ' is-unavailable'}`, available ? 'В корзину' : 'Временно недоступно');
  add.type = 'button';
  add.dataset.cartAdd = item.id;
  add.disabled = !available;
  add.setAttribute('aria-label', `${available ? 'В корзину' : 'Временно недоступно'}: ${item.name}`);
  const actions = element('div', 'dish-cart-actions');
  actions.dataset.cartItem = item.id;
  actions.append(add);
  body.append(actions);
  }
  card.append(body);
  cards.set(item.id, { signature, card });
  return card;
}

function replaceCards(container, next) {
  // Keep the live nodes when a background refresh returns the same dishes.
  // This preserves keyboard focus, quantity controls and completed reveals.
  const current = [...container.children];
  if (current.length !== next.length || current.some((card, index) => card !== next[index])) container.replaceChildren(...next);
}

function dishCount(count) {
  const word = count % 10 === 1 && count % 100 !== 11 ? 'блюдо' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'блюда' : 'блюд';
  return `${count} ${word}`;
}

function countCategory(categoryId) {
  const descendants = categoryDescendantIds(categories, categoryId);
  return items.filter(item => descendants.has(item.category)).length;
}

function selectCategory(categoryId, button) {
  const heading = root.querySelector('[data-menu-category-title]');
  const returnToResults = heading.getBoundingClientRect?.().top < (root.querySelector('[data-menu-filters]').getBoundingClientRect?.().bottom ?? 0);
  selected = categoryId;
  render();
  if (returnToResults) heading.scrollIntoView({ block: 'start', behavior: 'instant' });
  if (button.isConnected === false) heading.focus({ preventScroll: true });
}

function categoryButton(category, context, label = category.name) {
  const count = countCategory(category.id);
  const signature = JSON.stringify([category.id, label, count, category.source?.testOnly]);
  const key = `${context}:${category.id}`;
  let cached = navigation.get(key);
  if (cached?.signature !== signature) {
    const button = element('button', context === 'root' ? 'menu-root-button' : 'menu-category-button');
    button.type = 'button';
    button.dataset.menuFilter = category.id;
    button.setAttribute('aria-controls', 'menu-dishes');
    button.setAttribute('aria-label', `${label}${category.source?.testOnly ? ', тестовое меню' : ''}, ${dishCount(count)}`);
    button.append(element('span', 'menu-category-name', label));
    if (context === 'root' && category.source?.testOnly) button.append(element('span', 'menu-test-label', 'Тест'));
    const counter = element('span', 'menu-category-count', String(count));
    counter.setAttribute('aria-hidden', 'true');
    button.append(counter);
    button.addEventListener('click', () => selectCategory(category.id, button));
    cached = { signature, button };
    navigation.set(key, cached);
  }
  const path = categoryPath(categories, selected);
  cached.button.setAttribute('aria-pressed', String(context === 'root' ? path[0]?.id === category.id : selected === category.id));
  return cached.button;
}

function renderNavigation(visible) {
  const path = categoryPath(categories, selected);
  const current = path.at(-1);
  const visibleCategory = category => !category.source || countCategory(category.id) > 0;
  const roots = categories.filter(category => !category.parentId && visibleCategory(category));
  replaceCards(root.querySelector('[data-menu-roots]'), roots.map(category => categoryButton(category, 'root')));

  // A leaf keeps its siblings in reach. Deeper groups reveal their own children.
  const children = categories.filter(category => category.parentId === selected && visibleCategory(category));
  const branch = children.length ? current : path.at(-2);
  const branchChildren = branch ? categories.filter(category => category.parentId === branch.id && visibleCategory(category)) : [];
  const subcategories = root.querySelector('[data-menu-subcategories]');
  replaceCards(subcategories, branchChildren.length ? [categoryButton(branch, 'child', 'Все блюда'), ...branchChildren.map(category => categoryButton(category, 'child'))] : []);
  subcategories.hidden = branchChildren.length === 0;

  const breadcrumbs = root.querySelector('[data-menu-breadcrumbs]');
  const crumbSignature = JSON.stringify(path.map(category => [category.id, category.name]));
  if (breadcrumbs.dataset.path !== crumbSignature) {
    const crumbs = path.map((category, index) => {
      const crumb = element(index === path.length - 1 ? 'span' : 'button', 'menu-breadcrumb', category.name);
      if (index === path.length - 1) crumb.setAttribute('aria-current', 'location');
      else {
        crumb.type = 'button';
        crumb.setAttribute('aria-controls', 'menu-dishes');
        crumb.addEventListener('click', () => selectCategory(category.id, crumb));
      }
      return crumb;
    });
    replaceCards(breadcrumbs, crumbs);
    breadcrumbs.dataset.path = crumbSignature;
  }
  breadcrumbs.hidden = path.length < 2;
  root.querySelector('[data-menu-category-title]').textContent = current?.name || 'Меню';
  root.querySelector('[data-menu-test-notice]').hidden = !path.some(category => category.source?.testOnly) && !visible.some(item => item.source?.testOnly);
}

function render() {
  if (!categories.some(category => category.id === selected)) selected = categories[0]?.id || 'breakfast';
  const selectedRoot = categoryPath(categories, selected)[0];
  if (selectedRoot?.source && countCategory(selectedRoot.id) === 0) selected = categories.find(category => !category.parentId && (!category.source || countCategory(category.id)))?.id || selected;
  const descendants = categoryDescendantIds(categories, selected);
  const visible = items.filter(item => descendants.has(item.category));
  renderNavigation(visible);
  replaceCards(root.querySelector('[data-dish-grid]'), visible.filter(item => item.image).map(dishCard));
  const withoutPhotos = visible.filter(item => !item.image);
  replaceCards(root.querySelector('[data-dish-extras]'), withoutPhotos.map(dishCard));
  root.querySelector('[data-extra-section]').hidden = withoutPhotos.length === 0;
  const empty = root.querySelector('[data-menu-empty]');
  empty.hidden = visible.length !== 0;
  empty.textContent = selected === 'dinner' ? 'Ужины скоро появятся в меню. А пока можно выбрать что-нибудь из завтраков.' : 'В этом разделе пока нет блюд. Посмотрите другие разделы меню.';
  root.querySelector('[data-menu-count]').textContent = dishCount(visible.length);
  for (const id of cards.keys()) if (!items.some(item => item.id === id)) cards.delete(id);
  if (typeof CustomEvent === 'function' && window.dispatchEvent) window.dispatchEvent(new CustomEvent('cafe:menu-rendered'));
}

async function fetchMenu() {
  const response = await fetch(new URL('api/menu', apiBase), { signal: AbortSignal.timeout(8000), cache: 'no-store' });
  // A static host has no API. Only that case uses the checked-in menu.
  if (response.status === 404 || response.status === 405 || (response.ok && response.headers.get('content-type')?.includes('text/html'))) {
    let fallback = await fetch(new URL('data/menu.json', pageBase), { signal: AbortSignal.timeout(8000), cache: 'no-cache' });
    let sourcePreview = false;
    // Support the original source-folder preview as well as a Vite dist build.
    if (fallback.status === 404) {
      fallback = await fetch(new URL('public/data/menu.json', pageBase), { signal: AbortSignal.timeout(8000), cache: 'no-cache' });
      sourcePreview = true;
    }
    if (!fallback.ok) throw new Error('Menu unavailable');
    const data = await fallback.json();
    if (Array.isArray(data.items)) data.items = data.items.map(item => ({ ...item, image: item.image ? `${sourcePreview ? 'public/' : ''}${item.image.replace(/^\//, '')}` : '' }));
    return { ...data, live: false };
  }
  if (!response.ok) throw new Error('Menu unavailable');
  const data = await response.json();
  if (Array.isArray(data.items)) data.items = data.items.map(item => ({ ...item, image: item.image ? new URL(item.image.replace(/^\//, ''), apiBase).href : '' }));
  return { ...data, live: true };
}

async function loadMenu() {
  if (loading) return;
  loading = true;
  const status = root.querySelector('[data-menu-status]');
  const retry = root.querySelector('[data-menu-retry]');
  status.textContent = items.length ? 'Обновляем меню…' : 'Загружаем меню…';
  retry.hidden = true;
  root.setAttribute('aria-busy', 'true');
  try {
    const data = await fetchMenu();
    if (!Array.isArray(data.items)) throw new Error('Invalid menu');
    const normalized = normalizeMenuData(data, { allowOmittedSourceTree: true });
    const nextCategories = orderedCategories(normalized.categories);
    const nextItems = normalized.items.filter(item => item.category !== null && item.published && Number.isFinite(item.price))
      .sort((a, b) => a.order - b.order);
    categories = nextCategories;
    items = nextItems;
    window.cafeMenuSnapshot = { ...data, categories, items };
    if (typeof CustomEvent === 'function' && window.dispatchEvent) window.dispatchEvent(new CustomEvent('cafe:menu', { detail: window.cafeMenuSnapshot }));
    render();
    status.textContent = '';
    root.querySelector('[data-menu-filters]').hidden = false;
  } catch {
    status.textContent = 'Не удалось загрузить меню. Пожалуйста, попробуйте ещё раз.';
    retry.hidden = false;
  } finally {
    root.setAttribute('aria-busy', 'false');
    loading = false;
  }
}

if (root) {
  root.querySelector('[data-menu-retry]').addEventListener('click', loadMenu);
  // Reflect edits made in another tab when guests return to the menu.
  window.addEventListener('focus', loadMenu);
  loadMenu();
}
