const root = document.querySelector('[data-breakfast-menu]');
const categories = {
  signature: 'Фирменные завтраки',
  eggs: 'Яйца и тосты',
  porridge: 'Каши и гранола',
  sweet: 'Сладкое утро',
};
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const pageBase = new URL('./', location.href);
let items = [];
let selected = 'all';
let loading = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function dishCard(item) {
  const card = element('article', `dish-card${item.image ? '' : ' dish-card-text'}`);
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
    if (item.category === 'signature') visual.append(element('span', 'dish-badge', 'Фирменный завтрак'));
    card.append(visual);
  }
  const body = element('div', 'dish-body');
  body.append(element('p', 'dish-category', categories[item.category] || 'Завтраки'));
  const heading = element('div', 'dish-heading');
  heading.append(element('h3', '', item.name), element('span', 'dish-price', money.format(item.price)));
  body.append(heading, element('p', 'dish-description', item.description));
  card.append(body);
  return card;
}

function render() {
  const visible = items.filter(item => selected === 'all' || item.category === selected);
  const photos = visible.filter(item => item.image);
  const textOnly = visible.filter(item => !item.image);
  root.querySelector('[data-dish-grid]').replaceChildren(...photos.map(dishCard));
  root.querySelector('[data-dish-extras]').replaceChildren(...textOnly.map(dishCard));
  root.querySelector('[data-extra-section]').hidden = textOnly.length === 0;
  root.querySelector('[data-menu-empty]').hidden = visible.length !== 0;
  const count = visible.length;
  const word = count % 10 === 1 && count % 100 !== 11 ? 'блюдо' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'блюда' : 'блюд';
  root.querySelector('[data-menu-count]').textContent = `${count} ${word}`;
  for (const button of root.querySelectorAll('[data-menu-filter]')) {
    button.setAttribute('aria-pressed', String(button.dataset.menuFilter === selected));
  }
}

async function fetchMenu() {
  const response = await fetch(new URL('api/menu', pageBase), { signal: AbortSignal.timeout(8000), cache: 'no-store' });
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
    return data;
  }
  if (!response.ok) throw new Error('Menu unavailable');
  return response.json();
}

async function loadMenu() {
  if (loading) return;
  loading = true;
  const status = root.querySelector('[data-menu-status]');
  const retry = root.querySelector('[data-menu-retry]');
  status.textContent = items.length ? 'Обновляем меню…' : 'Накрываем к завтраку…';
  retry.hidden = true;
  root.setAttribute('aria-busy', 'true');
  try {
    const data = await fetchMenu();
    if (!Array.isArray(data.items)) throw new Error('Invalid menu');
    items = data.items.filter(item => item.published && Number.isFinite(item.price))
      .sort((a, b) => a.order - b.order);
    render();
    status.textContent = '';
    root.querySelector('[data-menu-filters]').hidden = false;
  } catch {
    status.textContent = 'Не удалось загрузить меню. Попробуйте ещё раз или посмотрите его в Яндекс Картах.';
    retry.hidden = false;
  } finally {
    root.setAttribute('aria-busy', 'false');
    loading = false;
  }
}

if (root) {
  root.querySelectorAll('[data-menu-filter]').forEach(button => button.addEventListener('click', () => {
    selected = button.dataset.menuFilter;
    render();
  }));
  root.querySelector('[data-menu-retry]').addEventListener('click', loadMenu);
  // Reflect edits made in another tab when guests return to the menu.
  window.addEventListener('focus', loadMenu);
  loadMenu();
}
