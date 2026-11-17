export const deliveryPages = ['checkout', 'order-terms', 'staff', 'staff-demo'];

// Raw HTML is a catalog too: GitHub Pages publishes it without running Vite.
const deliveryAssets = `<link rel="stylesheet" href="cart.css">
  <script type="module" src="cart.js"></script>`;
const deliveryCart = `<button type="button" class="header-cart" data-cart-open aria-label="Открыть корзину, порций: 0" aria-haspopup="dialog"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true" focusable="false"><path d="m8 9 4-6 4 6M3 9h18l-1.8 10a2 2 0 0 1-2 1.6H6.8a2 2 0 0 1-2-1.6L3 9Zm5 4 .5 4M12 13v4m4-4-.5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span data-cart-count aria-hidden="true">0</span></button>`;

// Applied before Vite resolves entries, so delivery assets never enter the catalog build.
export function profileHtml(html, delivery) {
  const profile = delivery ? 'delivery' : 'catalog';
  html = html.replace(/<meta\b[^>]*name="cafe-profile"[^>]*>/g, '');
  html = html.replace('</head>', `<meta id="site-profile" name="cafe-profile" content="${profile}"></head>`);
  html = html
    .replace('<!-- delivery:assets -->', delivery ? deliveryAssets : '')
    .replace('<!-- delivery:cart -->', delivery ? deliveryCart : '');
  if (delivery) return html;
  return html
    .replaceAll('2026-09-29-reg5', '2026-10-01-reg6')
    .replace(/<h3>Корзина, оформление заказа и панель сотрудников<\/h3>\s*<p>[\s\S]*?<\/p>\s*<p>[\s\S]*?<\/p>/, '<h3>Вход в панель управления</h3>')
    .replace(/<p\b[^>]*>[\s\S]*?<\/p>/g, paragraph => /vosem_cart_v1|vosem_order_guest/.test(paragraph) ? '' : paragraph)
    .replace('онлайн-регистрация и отправка заказов отключены', 'онлайн-регистрация отключена')
    .replace('данные анкет гостей, заказов и учётные данные сотрудников', 'данные анкет гостей и учётные данные сотрудников')
    .replace(/\s*<link\b[^>]*href="cart\.css"[^>]*>/g, '')
    .replace(/\s*<script\b[^>]*src="cart\.js"[^>]*><\/script>/g, '')
    .replace(/<button\b[^>]*data-cart-open[^>]*>[\s\S]*?<\/button>/g, '')
    .replace(/<([a-z][\w-]*)\b([^>]*\bdata-keeper\b[^>]*)>/gi, (tag) => /\bhidden\b/.test(tag) ? tag : tag.slice(0, -1) + ' hidden>')
    .replace('Размещайте блюда из кассы и редактируйте их для сайта.', 'Добавляйте блюда и редактируйте меню сайта.')
    .replace('Войдите, чтобы размещать блюда из кассы, обновлять фотографии и цены.', 'Войдите, чтобы добавлять блюда, обновлять фотографии и цены.')
    .replace('Для публикации выберите группу сайта. Блюдо останется в своей группе на кассе.', 'Выберите группу, в которой гости увидят блюдо.')
    .replace('Группы сайта не меняют структуру меню кассы.', 'Изменения появятся на сайте после сохранения.');
}
