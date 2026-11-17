import { normalizeMenuCategories, normalizeMenuData, categoryDescendantIds, categoryPath, orderedCategories } from './menu-categories.js';
import { orderedDrinkSections } from './menu-drinks-model.js';
import { setupMobileCategoryRail } from './menu-mobile-navigation.js';
import { createDrinkAddonsDialog } from './drink-addons-dialog.js';
import { setupMenuHeader } from './menu-header.js';

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
const drinkCards = new Map();
let drinkSection = null;
let drinkCategory = null;
let drinkSignature = '';
let activeDrinkPicker = null;
let addonsDialog;

function closeDrinkPicker() {
  if (activeDrinkPicker) activeDrinkPicker.open = false;
}

function returnToMenuResults(target) {
  const toolbar = root.querySelector('[data-menu-filters]');
  if (root.dataset.menuDocked === 'true' || (target.getBoundingClientRect?.().top ?? 0) < (toolbar.getBoundingClientRect?.().bottom ?? 0)) {
    target.scrollIntoView({ block:'start', behavior:'instant' });
  }
}

function setupMobileMenu() {
  setupMobileCategoryRail(root);
  document.addEventListener('pointerdown', event => {
    if (activeDrinkPicker?.open && !activeDrinkPicker.contains(event.target)) closeDrinkPicker();
  });
  document.addEventListener('focusin', event => {
    if (activeDrinkPicker?.open && !activeDrinkPicker.contains(event.target)) closeDrinkPicker();
  });
  // The bottom controls belong to the menu section, not to the rest of the page.
  const mobile = window.matchMedia?.('(max-width: 650px) and (min-height: 541px)');
  if (!mobile || !window.IntersectionObserver) return;
  let inMenu = false;
  const sync = () => {
    root.dataset.menuDocked = String(mobile.matches && inMenu);
    if (!inMenu) closeDrinkPicker();
  };
  const observer = new window.IntersectionObserver(entries => {
    inMenu = entries[0].isIntersecting;
    sync();
  }, { rootMargin:'-96px 0px -100px 0px', threshold:0 });
  observer.observe(root);
  root.dataset.mobileMenuReady = 'true';
  mobile.addEventListener('change', () => { closeDrinkPicker(); sync(); });
  const testBanner = document.querySelector('.cafe-test-banner');
  if (window.ResizeObserver && testBanner) {
    const resize = new window.ResizeObserver(() => {
      root.style.setProperty('--menu-bottom-offset', `${Math.ceil(testBanner.getBoundingClientRect().height)}px`);
    });
    resize.observe(testBanner);
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function showDishPlaceholder(visual, kind = 'dish') {
  visual.className = `${kind}-visual ${kind}-placeholder`;
  visual.setAttribute('aria-hidden', 'true');
  const mark = element('span', 'dish-placeholder-mark');
  mark.setAttribute('aria-hidden', 'true');
  visual.replaceChildren(mark);
}

function dishCard(item) {
  const path = categoryPath(categories, item.category);
  const category = path.at(-1);
  const testOnly = item.source?.testOnly === true || path.some(category => category.source?.testOnly === true);
  const signature = JSON.stringify([item, category?.name, testOnly]);
  const cached = cards.get(item.id);
  if (cached?.signature === signature) return cached.card;
  const card = element('article', 'dish-card');
  card.dataset.reveal = 'visual';
  card.dataset.revealKey = `dish:${item.id}`;
  card.dataset.menuCategory = item.category;
  const visual = element('div', 'dish-visual');
  if (item.image) {
    const img = element('img', 'dish-photo');
    img.src = new URL(item.image, pageBase).href;
    img.alt = item.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.width = 600;
    img.height = 450;
    img.addEventListener('error', () => {
      showDishPlaceholder(visual);
    }, { once: true });
    visual.append(img);
  } else {
    showDishPlaceholder(visual);
  }
  card.append(visual);
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

function drinkCount(count) {
  const word = count % 10 === 1 && count % 100 !== 11 ? 'напиток' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'напитка' : 'напитков';
  return `${count} ${word}`;
}

function drinkCard(item) {
  // Group labels/order do not change the card. Keep the guest's selected volume
  // and additions when an administrator renames or moves its section.
  const { section, sectionOrder, ...drinkContents } = item.drink;
  const signature = JSON.stringify({ ...item, drink: drinkContents });
  const cached = drinkCards.get(item.id);
  if (cached?.signature === signature) return cached.card;
  const card = element('article', 'drink-card drink-card-with-photo');
  card.dataset.drinkId = item.id;
  const visual = element('div', 'drink-visual');
  if (item.image) {
    const photo = element('img', 'drink-photo');
    photo.src = new URL(item.image, pageBase).href;
    photo.alt = item.name;
    photo.width = 600;
    photo.height = 600;
    photo.loading = 'lazy';
    photo.decoding = 'async';
    photo.addEventListener('error', () => {
      showDishPlaceholder(visual, 'drink');
    }, { once:true });
    visual.append(photo);
  } else {
    showDishPlaceholder(visual, 'drink');
  }
  card.append(visual);
  const body = element('div', 'drink-body');
  const heading = element('div', 'drink-heading');
  const title = element('h5', 'drink-name', item.name);
  const price = element('span', 'drink-price');
  price.setAttribute('aria-live', 'polite');
  price.setAttribute('aria-atomic', 'true');
  heading.append(title, price);
  body.append(heading);
  if (item.description) body.append(element('p', 'drink-description', item.description));
  if (item.drink.childFriendly) body.append(element('span', 'drink-child-note', 'Можно детям'));
  const variants = item.drink.variants;
  const selection = cached?.selection || { volumeMl:variants[0].volumeMl, extras:new Set() };
  let variantIndex = Math.max(0, variants.findIndex(variant => variant.volumeMl === selection.volumeMl));
  selection.volumeMl = variants[variantIndex].volumeMl;
  const extras = selection.extras;
  for (const name of extras) if (!item.drink.addons?.some(addon => addon.name === name)) extras.delete(name);
  let addonsCount;
  let addonsButton;
  let addonConfig;
  const updatePrice = () => {
    const extraPrice = (item.drink.addons || []).reduce((sum, addon) => sum + (extras.has(addon.name) ? Math.round(addon.price * 100) : 0), 0);
    const value = money.format((Math.round(variants[variantIndex].price * 100) + extraPrice) / 100);
    price.textContent = value;
    price.setAttribute('aria-label', `${item.name}, ${variants[variantIndex].volumeMl} мл${extras.size ? ', с дополнениями' : ''}: ${value}`);
    price.dataset.includesAddons = String(extras.size > 0);
    if (addonsCount) {
      addonsCount.textContent = String(extras.size);
      addonsCount.hidden = extras.size === 0;
      addonsButton.setAttribute('aria-label', `Дополнения: ${item.name}${extras.size ? `, выбрано ${extras.size}` : ''}`);
    }
    addonsDialog?.refresh(item.id);
  };
  if (variants.length > 1) {
    const sizes = element('div', 'drink-volumes');
    sizes.setAttribute('role', 'group');
    sizes.setAttribute('aria-label', `Объём: ${item.name}`);
    const buttons = variants.map((variant, index) => {
      const button = element('button', 'drink-volume', `${variant.volumeMl} мл`);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(index === variantIndex));
      button.addEventListener('click', () => {
        variantIndex = index;
        selection.volumeMl = variants[index].volumeMl;
        buttons.forEach((other, i) => other.setAttribute('aria-pressed', String(i === index)));
        updatePrice();
      });
      return button;
    });
    sizes.append(...buttons);
    body.append(sizes);
  } else body.append(element('p', 'drink-volume-single', `${variants[0].volumeMl} мл`));
  if (item.drink.addons?.length) {
    const addons = element('div', 'drink-addons');
    addonsButton = element('button', 'drink-addons-title', 'Дополнения');
    addonsButton.type = 'button';
    addonsButton.setAttribute('aria-haspopup', 'dialog');
    addonsCount = element('span', 'drink-addons-count');
    addonsCount.setAttribute('aria-hidden', 'true');
    const symbol = element('span', 'drink-addons-symbol');
    symbol.setAttribute('aria-hidden', 'true');
    addonsButton.append(addonsCount, symbol);
    addonConfig = {
      id:item.id, name:item.name, addons:item.drink.addons, trigger:addonsButton,
      getState:() => ({ selected:extras, volumeMl:variants[variantIndex].volumeMl, total:price.textContent }),
      onChange:(name, checked) => {
        if (checked) extras.add(name); else extras.delete(name);
        updatePrice();
      },
    };
    addonsButton.addEventListener('click', () => {
      addonsDialog ||= createDrinkAddonsDialog(document, window);
      addonsDialog.open(addonConfig);
    });
    addons.append(addonsButton);
    body.append(addons);
  }
  card.append(body);
  updatePrice();
  drinkCards.set(item.id, { signature, card, selection });
  if (addonConfig) addonsDialog?.update(addonConfig);
  else addonsDialog?.close(item.id);
  return card;
}

function renderDrinks(drinks, otherCount) {
  addonsDialog?.retain(drinks.map(item => item.id));
  const container = root.querySelector('[data-drinks-menu]');
  const pickerSlot = root.querySelector('[data-menu-drink-nav]');
  container.hidden = drinks.length === 0;
  pickerSlot.hidden = drinks.length === 0;
  root.dataset.menuHasDrinks = String(drinks.length > 0);
  if (!drinks.length) { closeDrinkPicker(); return; }
  if (drinkCategory !== selected) { drinkCategory = selected; drinkSection = null; }
  const grouped = new Map(orderedDrinkSections(drinks).map(section => [section.name, section.items]));
  const sectionNames = [...grouped.keys()];
  if (!grouped.has(drinkSection)) drinkSection = sectionNames[0];
  const signature = JSON.stringify([selected, drinks, otherCount]);
  if (signature === drinkSignature) {
    if (!otherCount) root.querySelector('[data-menu-count]').textContent = drinkCount(grouped.get(drinkSection).length);
    return;
  }
  drinkSignature = signature;
  const intro = element('p', 'drinks-intro', 'От эспрессо до домашнего лимонада. Выберите объём — цена изменится рядом с названием.');
  const layout = element('div', 'drinks-layout');
  const sidebar = element('aside', 'drinks-sidebar');
  const filters = element('div', 'drinks-filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Виды напитков');
  sidebar.append(element('p', 'drinks-nav-label', 'ЧТО БУДЕТЕ ПИТЬ?'), filters);
  const picker = element('details', 'drinks-picker');
  const summary = element('summary', 'drinks-picker-summary');
  const pickerLabel = element('span', 'drinks-picker-label', 'Выбрать');
  const pickerValue = element('span', 'drinks-picker-value');
  const pickerIcon = element('span', 'drinks-picker-icon');
  pickerIcon.setAttribute('aria-hidden', 'true');
  summary.append(pickerValue, pickerLabel, pickerIcon);
  const pickerOptions = element('div', 'drinks-picker-options');
  pickerOptions.setAttribute('role', 'group');
  pickerOptions.setAttribute('aria-label', 'Выбор напитков');
  picker.append(summary, pickerOptions);
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape' && picker.open) {
      event.preventDefault(); picker.open = false; summary.focus({ preventScroll:true });
    }
  });
  const sections = element('div', 'drinks-sections');
  sections.id = 'drink-sections';
  const sectionNodes = new Map();
  for (const [name, group] of grouped) {
    const section = element('section', 'drink-section');
    const head = element('div', 'drink-section-heading');
    const title = element('h4', '', name);
    title.id = `drink-heading-${group[0].id}`;
    section.setAttribute('aria-labelledby', title.id);
    head.append(title);
    const photos = element('div', 'drink-photo-list');
    photos.append(...group.map(drinkCard));
    photos.hidden = photos.children.length === 0;
    section.append(head, photos);
    sectionNodes.set(name, section);
    sections.append(section);
  }
  const buttons = new Map();
  const updateFilter = () => {
    for (const [name, section] of sectionNodes) section.hidden = name !== drinkSection;
    for (const [name, group] of buttons) for (const button of group) button.setAttribute('aria-pressed', String(name === drinkSection));
    pickerValue.textContent = drinkSection;
    summary.setAttribute('aria-label', `Выбрать напитки: ${drinkSection}`);
    if (!otherCount) root.querySelector('[data-menu-count]').textContent = drinkCount(grouped.get(drinkSection).length);
  };
  for (const name of sectionNames) {
    const group = [];
    for (const target of [filters, pickerOptions]) {
      const button = element('button', 'drinks-filter');
      button.type = 'button';
      button.dataset.drinkSection = name;
      button.setAttribute('aria-controls', 'drink-sections');
      button.setAttribute('aria-label', name);
      button.append(element('span', 'drinks-filter-name', name));
      button.addEventListener('click', () => {
        drinkSection = name; updateFilter();
        if (target === pickerOptions) { picker.open = false; summary.focus({ preventScroll:true }); }
        // A long previous group must not leave the next group above the viewport.
        returnToMenuResults(sections);
      });
      group.push(button);
      target.append(button);
    }
    buttons.set(name, group);
  }
  const hint = element('p', 'drinks-browse-note', 'Выбор помогает посмотреть цену. Заказать напиток можно в кофейне.');
  layout.append(sidebar, sections);
  container.replaceChildren(intro, layout, hint);
  pickerSlot.replaceChildren(picker);
  activeDrinkPicker = picker;
  updateFilter();
  for (const id of drinkCards.keys()) if (!items.some(item => item.id === id)) drinkCards.delete(id);
}

function countCategory(categoryId) {
  const descendants = categoryDescendantIds(categories, categoryId);
  return items.filter(item => descendants.has(item.category)).length;
}

function selectCategory(categoryId, button) {
  const heading = root.querySelector('[data-menu-category-title]');
  closeDrinkPicker();
  selected = categoryId;
  render();
  returnToMenuResults(heading);
  if (button.isConnected === false) heading.focus({ preventScroll: true });
}

function categoryButton(category, context, label = category.name) {
  const signature = JSON.stringify([category.id, label, category.source?.testOnly]);
  const key = `${context}:${category.id}`;
  let cached = navigation.get(key);
  if (cached?.signature !== signature) {
    const button = element('button', context === 'root' ? 'menu-root-button' : 'menu-category-button');
    button.type = 'button';
    button.dataset.menuFilter = category.id;
    button.setAttribute('aria-controls', 'menu-dishes');
    button.setAttribute('aria-label', `${label}${category.source?.testOnly ? ', тестовое меню' : ''}`);
    button.append(element('span', 'menu-category-name', label));
    if (context === 'root' && category.source?.testOnly) button.append(element('span', 'menu-test-label', 'Тест'));
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
  const drinks = visible.filter(item => item.drink?.variants?.length);
  const dishes = visible.filter(item => !item.drink?.variants?.length);
  replaceCards(root.querySelector('[data-dish-grid]'), dishes.map(dishCard));
  replaceCards(root.querySelector('[data-dish-extras]'), []);
  root.querySelector('[data-extra-section]').hidden = true;
  const empty = root.querySelector('[data-menu-empty]');
  empty.hidden = visible.length !== 0;
  empty.textContent = selected === 'dinner' ? 'Ужины скоро появятся в меню. А пока можно выбрать что-нибудь из завтраков.' : 'В этом разделе пока нет блюд. Посмотрите другие разделы меню.';
  root.querySelector('[data-menu-count]').textContent = dishCount(visible.length);
  renderDrinks(drinks, dishes.length);
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
  // A background refresh must not add a status row and move the visible cards.
  status.textContent = items.length ? '' : 'Загружаем меню…';
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
  setupMenuHeader(root);
  setupMobileMenu();
  root.querySelector('[data-menu-retry]').addEventListener('click', loadMenu);
  // Reflect edits made in another tab when guests return to the menu.
  window.addEventListener('focus', loadMenu);
  loadMenu();
}
