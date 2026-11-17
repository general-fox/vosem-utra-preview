import { normalizeMenuData, categoryPath } from '../menu-categories.js';
export const SITE_URL = 'https://vosem-utra.ru/';
export const SEO_TITLE = 'Восемь утра — кофе и завтраки весь день на Шелепихинской набережной';
export const SEO_DESCRIPTION = 'Кофейня «Восемь утра» в ЖК «Сердце Столицы», Москва, Шелепихинская набережная, 34, корп. 6. Завтраки весь день, кофе и десерты. Ежедневно с 8:00 до 20:00.';
export const SOCIAL_IMAGE = `${SITE_URL}social-cover.webp`;
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 0, maximumFractionDigits: 2 });

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function safeImage(value) {
  if (typeof value !== 'string') return '';
  const relative = value.replace(/^\//, '');
  return /^(menu-images|uploads)\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:jpe?g|png|webp)$/i.test(relative) && !relative.includes('..') ? relative : '';
}

function publishedItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && item.published === true && typeof item.name === 'string'
      && item.name.trim() && typeof item.price === 'number' && Number.isFinite(item.price) && item.price >= 0)
    .map((item) => ({ ...item, image: safeImage(item.image) }))
    .sort((left, right) => (Number(left.order) || 0) - (Number(right.order) || 0));
}

function dishMarkup(item, categories, delivery = true) {
  const path = categoryPath(categories, item.category);
  const testOnly = item.source?.testOnly === true || path.some(category => category.source?.testOnly === true);
  const categoryLabel = `${testOnly ? 'Тестовое блюдо · ' : ''}${path.at(-1)?.name || 'Меню'}`;
  const priceUnset = testOnly && item.price === 0;
  const visual = item.image
    ? `<div class="dish-visual"><img class="dish-photo" src="${escapeHtml(item.image)}" width="600" height="450" alt="${escapeHtml(item.name)}" loading="lazy" decoding="async"></div>`
    : '<div class="dish-visual dish-placeholder" aria-hidden="true"><span class="dish-placeholder-mark" aria-hidden="true"></span></div>';
  const available = item.availableForOrder !== false && !testOnly;
  const label = available ? 'В корзину' : 'Временно недоступно';
  const action = `<button class="dish-order-button${available ? '' : ' is-unavailable'}" type="button" data-cart-add="${escapeHtml(item.id)}" aria-label="${label}: ${escapeHtml(item.name)}"${available ? '' : ' disabled'}>${label}</button>`;
  return `<article class="dish-card" data-reveal="visual" data-reveal-key="dish:${escapeHtml(item.id)}" data-menu-category="${escapeHtml(item.category)}">${visual}<div class="dish-body"><p class="dish-category">${escapeHtml(categoryLabel)}</p><div class="dish-heading"><h3>${escapeHtml(item.name)}</h3><span class="dish-price${priceUnset ? ' is-unset' : ''}">${escapeHtml(priceUnset ? 'Цена уточняется' : money.format(item.price))}</span></div><p class="dish-description">${escapeHtml(item.description)}</p>${delivery ? `<div class="dish-cart-actions" data-cart-item="${escapeHtml(item.id)}">${action}</div>` : ''}</div></article>`;
}

/** Initial HTML uses the same card structure as menu.js; no JavaScript is needed to read dishes. */
export function renderMenu(items, inputCategories, options = {}) {
  const menu = normalizeMenuData({ ...options, categories:inputCategories, items });
  const { categories } = menu;
  const published = publishedItems(menu.items).filter(item => item.category !== null);
  return {
    grid: published.map(item => dishMarkup(item, categories, options.delivery)).join('\n'),
    extras: '',
    count: published.length,
  };
}

function structuredData(items, inputCategories, options = {}) {
  const menu = normalizeMenuData({ ...options, categories:inputCategories, items });
  const { categories } = menu;
  const published = publishedItems(menu.items).filter(item => item.category !== null)
    .filter(item => item.source?.testOnly !== true && !categoryPath(categories, item.category).some(category => category.source?.testOnly === true));
  const section = category => {
    const children = categories.filter(child => child.parentId === category.id).sort((a,b) => a.order-b.order).map(section).filter(Boolean);
    const dishes = published.filter(item => item.category === category.id).map((item) => ({
      '@type': 'MenuItem', name: item.name, description: String(item.description ?? ''),
      ...(item.image ? { image: new URL(item.image, SITE_URL).href } : {}),
      offers: { '@type': 'Offer', price: item.price, priceCurrency: 'RUB' },
    }));
    return dishes.length || children.length ? { '@type':'MenuSection', name:category.name, hasMenuItem:dishes, ...(children.length ? {hasMenuSection:children} : {}) } : null;
  };
  const sections = categories.filter(category => category.parentId === null).sort((a,b) => a.order-b.order).map(section).filter(Boolean);
  return {
    '@context': 'https://schema.org', '@type': 'CafeOrCoffeeShop',
    '@id': `${SITE_URL}#cafe`, name: 'Восемь утра', url: SITE_URL,
    description: SEO_DESCRIPTION, image: SOCIAL_IMAGE, telephone: '+79851308106',
    address: {
      '@type': 'PostalAddress', streetAddress: 'Шелепихинская набережная, 34, корпус 6',
      addressLocality: 'Москва', addressCountry: 'RU',
    },
    openingHoursSpecification: [{
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
      opens: '08:00', closes: '20:00',
    }],
    menu: `${SITE_URL}#menu`,
    hasMenu: { '@type': 'Menu', '@id': `${SITE_URL}#cafe-menu`, name: 'Меню', url: `${SITE_URL}#menu`, hasMenuSection: sections },
    sameAs: ['https://yandex.ru/maps/org/vosem_utra/133294557510/', 'https://t.me/vosemutracafe'],
  };
}

function jsonForHtml(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => ({
    '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029',
  })[character]);
}

function normalizePage(page) {
  const filename = String(page || 'index').replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || 'index';
  return filename.replace(/\.html$/i, '').toLowerCase();
}

function robotsDirective(page, production) {
  if (production && page === 'index') return 'index, follow, max-image-preview:large';
  return production && ['privacy', 'consent'].includes(page) ? 'noindex, follow' : 'noindex, nofollow';
}

function replaceMenuSlot(html, name, content) {
  const label = name.toUpperCase();
  const start = `<!-- SEO:${label}:START -->`;
  const end = `<!-- SEO:${label}:END -->`;
  const replacement = `${start}\n${content}\n${end}`;
  const managed = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (managed.test(html)) return html.replace(managed, () => replacement);
  // Fail loudly if the template has changed, rather than silently serving an empty menu.
  const emptySlot = new RegExp(`(<div\\b[^>]*\\bdata-${name}(?:="[^"]*")?[^>]*>)\\s*(</div>)`, 'i');
  if (!emptySlot.test(html)) throw new Error(`SEO menu slot data-${name} is missing or has unmanaged content.`);
  return html.replace(emptySlot, (_, open, close) => `${open}${replacement}${close}`);
}

function toggleHidden(html, attribute, hidden) {
  const openingTag = new RegExp(`<[^>]+\\b${attribute}(?:="[^"]*")?[^>]*>`, 'i');
  return html.replace(openingTag, (tag) => {
    const clean = tag.replace(/\s+hidden(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
    return hidden ? clean.replace(/>$/, ' hidden>') : clean;
  });
}

function replaceHead(html, content) {
  let clean = html.replace(/\s*<!-- SEO:HEAD:START -->[\s\S]*?<!-- SEO:HEAD:END -->\s*/g, '\n');
  clean = clean.replace(/<meta\b[^>]*>/gi, (tag) => {
    const name = tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1].toLowerCase();
    return name && (['robots', 'googlebot', 'yandex', 'description', 'google-site-verification', 'yandex-verification'].includes(name)
      || name.startsWith('og:') || name.startsWith('twitter:')) ? '' : tag;
  });
  clean = clean.replace(/<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*>/gi, '');
  clean = clean.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, '');
  return clean.replace(/<\/head>/i, () => `  <!-- SEO:HEAD:START -->\n${content}\n  <!-- SEO:HEAD:END -->\n</head>`);
}

/** Pure and idempotent: safe for build output followed by live server rendering. */
export function transformPage(html, { page = 'index', production = false, delivery = true, items = [], categories, sourceCategories, categoryMappings, googleVerification = '', yandexVerification = '' } = {}) {
  if (!delivery) items = items.filter(item => item.source?.testOnly !== true && !item.id.startsWith('kds-test-'));
  const normalizedPage = normalizePage(page);
  const home = normalizedPage === 'index';
  // Preserve factual existing titles/descriptions on the non-public utility pages.
  const title = home ? SEO_TITLE : html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Восемь утра';
  const oldDescription = html.match(/<meta\b[^>]*\bname=["']description["'][^>]*\bcontent=["']([^"']*)["'][^>]*>/i)?.[1];
  const tags = [
    `  <title>${home ? escapeHtml(title) : title}</title>`,
    `  <meta name="robots" content="${robotsDirective(normalizedPage, production === true)}">`,
  ];
  if (home || oldDescription) tags.push(`  <meta name="description" content="${home ? escapeHtml(SEO_DESCRIPTION) : oldDescription}">`);
  if (home && production === true) {
    tags.push(
      `  <link rel="canonical" href="${SITE_URL}">`,
      '  <meta property="og:type" content="website">',
      '  <meta property="og:locale" content="ru_RU">',
      '  <meta property="og:site_name" content="Восемь утра">',
      `  <meta property="og:title" content="${escapeHtml(SEO_TITLE)}">`,
      `  <meta property="og:description" content="${escapeHtml(SEO_DESCRIPTION)}">`,
      `  <meta property="og:url" content="${SITE_URL}">`,
      `  <meta property="og:image" content="${SOCIAL_IMAGE}">`,
      '  <meta property="og:image:width" content="1254">',
      '  <meta property="og:image:height" content="1254">',
      '  <meta property="og:image:alt" content="Две чашки кофе в кофейне «Восемь утра»">',
      '  <meta name="twitter:card" content="summary_large_image">',
      `  <meta name="twitter:title" content="${escapeHtml(SEO_TITLE)}">`,
      `  <meta name="twitter:description" content="${escapeHtml(SEO_DESCRIPTION)}">`,
      `  <meta name="twitter:image" content="${SOCIAL_IMAGE}">`,
      '  <meta name="twitter:image:alt" content="Две чашки кофе в кофейне «Восемь утра»">',
    );
    if (typeof googleVerification === 'string' && googleVerification.trim()) tags.push(`  <meta name="google-site-verification" content="${escapeHtml(googleVerification.trim())}">`);
    if (typeof yandexVerification === 'string' && yandexVerification.trim()) tags.push(`  <meta name="yandex-verification" content="${escapeHtml(yandexVerification.trim())}">`);
    tags.push(`  <script type="application/ld+json" id="cafe-structured-data">${jsonForHtml(structuredData(items, categories, { sourceCategories, categoryMappings }))}</script>`);
  }
  let result = replaceHead(html, tags.join('\n'));
  if (home) {
    const menu = renderMenu(items, categories, { sourceCategories, categoryMappings, delivery });
    result = replaceMenuSlot(result, 'dish-grid', menu.grid);
    if (/\bdata-dish-extras\b/.test(result)) result = replaceMenuSlot(result, 'dish-extras', menu.extras);
    result = toggleHidden(result, 'data-extra-section', !menu.extras);
    result = toggleHidden(result, 'data-menu-empty', menu.count !== 0);
    result = result.replace(/<span\b([^>]*\bdata-menu-count[^>]*)>[\s\S]*?<\/span>/i,
      (_, attributes) => `<span${attributes}>${menu.count} ${menu.count % 10 === 1 && menu.count % 100 !== 11 ? 'блюдо' : menu.count % 10 >= 2 && menu.count % 10 <= 4 && (menu.count % 100 < 12 || menu.count % 100 > 14) ? 'блюда' : 'блюд'}</span>`);
    result = result.replace(/<noscript>\s*<p>Чтобы увидеть карточки блюд,[\s\S]*?<\/p>\s*<\/noscript>/i,
      '<noscript><p>Меню доступно выше. Для выбора категории включите JavaScript.</p></noscript>');
  }
  return result;
}

export function renderHomeSeo(html, items, options = {}) {
  return transformPage(html, { ...options, page: 'index', items });
}

export function renderRobots({ production = false } = {}) {
  // Crawlers must be allowed to see the HTML noindex directives on preview/admin/legal pages.
  return `# ${production === true ? 'Production' : 'Preview: indexing is disabled by page-level noindex'}\nUser-agent: *\nDisallow: /api/\n${production === true ? `\nSitemap: ${SITE_URL}sitemap.xml\n` : ''}`;
}

export function renderSitemap({ production = false } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${production === true ? `\n  <url><loc>${SITE_URL}</loc></url>\n` : ''}</urlset>\n`;
}
