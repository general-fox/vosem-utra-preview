import { cartStore, cartSummary, CART_KEY } from './cart-store.js';
import { fetchCatalog, money } from './order-client.js';
import { syncDishCartControls } from './dish-cart.js';

const node = (tag, className, text) => { const el = document.createElement(tag); el.className = className; if (text !== undefined) el.textContent = text; return el; };
let catalog = []; let baseline = []; let live = false; let busy = false; let verified = false;
const toast = node('p', 'cart-toast'); toast.setAttribute('role', 'status'); toast.setAttribute('aria-live', 'polite');
const floating = node('button', 'floating-cart'); floating.type = 'button'; floating.dataset.cartOpen = ''; floating.setAttribute('aria-haspopup', 'dialog');
const dialog = node('dialog', 'cart-dialog'); dialog.id = 'cart-dialog'; dialog.setAttribute('aria-labelledby', 'cart-title');
dialog.innerHTML = `<div class="cart-heading"><div><p class="eyebrow">ВОСЕМЬ УТРА</p><h2 id="cart-title">Ваша корзина</h2></div><button type="button" class="cart-close" aria-label="Закрыть корзину"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div><p class="cart-status" role="status"></p><div class="cart-lines"></div><div class="cart-empty" hidden><p>Пока здесь пусто</p><a href="#menu" class="text-link" data-cart-menu>Выбрать завтрак ↗</a></div><div class="cart-bottom"><div class="cart-total"><span>Блюда</span><strong></strong></div><p class="cart-fineprint">Условия получения и окончательную сумму проверим при оформлении.</p><p class="cart-storage" hidden>Браузер не сохраняет корзину. Она доступна, пока открыта эта страница.</p><button type="button" class="text-link cart-retry" hidden>Проверить меню ещё раз ↻</button><button type="button" class="button button-dark cart-checkout">Оформить заказ <span aria-hidden="true">↗</span></button></div>`;
document.body.append(dialog, floating, toast);
const $ = selector => dialog.querySelector(selector);
let toastTimer;
function announce(text) { toast.textContent = text; toast.classList.add('is-visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3500); }
function currentSummary() { return cartSummary(cartStore.lines, catalog, baseline); }
function updateEntry() {
  const { count, subtotalMinor, rows } = currentSummary();
  document.querySelectorAll('[data-cart-count]').forEach(el => { el.textContent = String(count); });
  document.querySelectorAll('.header-cart').forEach(el => { el.setAttribute('aria-label', `Открыть корзину, порций: ${count}`); });
  syncDishCartControls(document, cartStore.lines);
  floating.textContent = count ? `Корзина · ${count} · ${rows.every(row => row.unitMinor !== null) ? money(subtotalMinor) : 'проверить'}` : 'Корзина · 0';
  floating.setAttribute('aria-label', `Открыть корзину, порций: ${count}`);
}
function render() {
  updateEntry();
  const summary = currentSummary();
  $('.cart-lines').replaceChildren(...summary.rows.map(row => {
    const line = node('article', `cart-line${row.available ? '' : ' is-unavailable'}`);
    line.dataset.cartLine = row.id;
    const copy = node('div', 'cart-line-copy');
    copy.append(node('h3', '', row.item?.name || 'Блюдо больше не доступно'));
    copy.append(node('p', 'cart-unit', row.unitMinor === null ? 'Цена не подтверждена' : `${money(row.unitMinor)} за порцию`));
    if (row.previousMinor !== null) copy.append(node('p', 'cart-price-change', `Цена изменилась: ${money(row.previousMinor)} → ${money(row.unitMinor)}`));
    if (!row.available) copy.append(node('p', 'cart-unavailable', 'Временно недоступно. Удалите блюдо, чтобы продолжить.'));
    const actions = node('div', 'cart-line-actions'); const quantity = node('div', 'cart-quantity');
    for (const [label, delta, symbol] of [['Уменьшить количество', -1, '−'], ['Увеличить количество', 1, '+']]) {
      const button = node('button', '', symbol); button.type = 'button'; button.dataset.cartDelta = String(delta); button.setAttribute('aria-label', `${label}: ${row.item?.name || 'блюдо'}`);
      button.disabled = busy || delta > 0 && (!row.available || row.qty >= 99);
      button.addEventListener('click', () => { try { cartStore.setQuantity(row.id, row.qty + delta); (dialog.querySelector(`[data-cart-line="${row.id}"] [data-cart-delta="${delta}"]`) || $('.cart-close')).focus(); } catch (error) { announce(error.message); } });
      if (delta === 1) quantity.append(node('span', '', String(row.qty)));
      quantity.append(button);
    }
    const remove = node('button', 'cart-remove', 'Убрать'); remove.type = 'button'; remove.disabled = busy; remove.setAttribute('aria-label', `Убрать из корзины: ${row.item?.name || 'блюдо'}`);
    remove.addEventListener('click', () => cartStore.setQuantity(row.id, 0));
    actions.append(quantity, node('strong', 'cart-line-total', row.lineMinor === null ? '—' : money(row.lineMinor)), remove);
    line.append(copy, actions); return line;
  }));
  $('.cart-empty').hidden = summary.rows.length > 0;
  $('.cart-total strong').textContent = summary.rows.some(row => row.lineMinor === null) ? 'Уточняется' : money(summary.subtotalMinor);
  $('.cart-checkout').disabled = busy || !verified || !summary.rows.length || summary.unavailable;
  $('.cart-storage').hidden = cartStore.persisted;
}
function receiveMenu(data) {
  if (!Array.isArray(data?.items)) return;
  catalog = data.items; live = data.live === true;
  if (!baseline.length) baseline = catalog.map(item => ({ ...item }));
  updateEntry();
}
async function refresh() {
  if (busy) return;
  busy = true; verified = false; dialog.setAttribute('aria-busy', 'true'); $('.cart-status').textContent = 'Проверяем цены и наличие…'; $('.cart-retry').hidden = true; render();
  try {
    const data = await fetchCatalog({ allowStatic: true }); receiveMenu(data); verified = true;
    $('.cart-status').textContent = live ? (Number.isInteger(data.revision) ? `Цены и наличие проверены · меню №${data.revision}` : 'Цены и наличие проверены') : 'Демонстрация корзины. Отправка заказов в этой версии недоступна; цены не подтверждены сервером.';
  } catch { $('.cart-status').textContent = 'Не удалось проверить цены и наличие. Корзина сохранена. Повторите проверку перед оформлением.'; $('.cart-retry').hidden = false; }
  finally { busy = false; dialog.setAttribute('aria-busy', 'false'); render(); }
}
function close() { dialog.close(); baseline = catalog.map(item => ({ ...item })); }
$('.cart-close').addEventListener('click', close);
dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
$('[data-cart-menu]').addEventListener('click', close);
$('.cart-retry').addEventListener('click', refresh);
$('.cart-checkout').addEventListener('click', () => { if (!$('.cart-checkout').disabled) location.href = new URL('checkout.html', location.href).href; });
document.addEventListener('click', async event => {
  const open = event.target.closest('[data-cart-open]');
  if (open) { if (!dialog.open) dialog.showModal(); await refresh(); return; }
  const quantityButton = event.target.closest('[data-dish-delta]');
  if (quantityButton && !quantityButton.disabled) {
    const actions = quantityButton.closest('[data-cart-item]');
    const id = actions.dataset.cartItem;
    const delta = Number(quantityButton.dataset.dishDelta);
    const qty = cartStore.lines.find(line => line.id === id)?.qty || 0;
    const name = actions.closest('.dish-card').querySelector('h3').textContent;
    try {
      if (delta > 0 && (!catalog.some(item => item.id === id && item.published && item.availableForOrder !== false))) throw new Error('Блюдо временно недоступно. Обновите меню.');
      const focused = document.activeElement === quantityButton;
      cartStore.setQuantity(id, Math.max(0, qty + delta));
      if (focused && qty + delta <= 0) actions.querySelector('[data-cart-add]').focus({ preventScroll: true });
      else if (focused && quantityButton.disabled) actions.querySelector('[data-dish-delta="-1"]').focus({ preventScroll: true });
      announce(qty + delta > 0 ? `${name} — в корзине: ${qty + delta}` : `${name} — убрали из корзины`);
    } catch (error) { announce(error.message); }
    return;
  }
  const button = event.target.closest('[data-cart-add]');
  if (!button || button.disabled) return;
  try {
    if (!catalog.length) receiveMenu(await fetchCatalog({ allowStatic: true }));
    const item = catalog.find(entry => entry.id === button.dataset.cartAdd);
    if (!item || !item.published || item.availableForOrder === false) throw new Error('Блюдо временно недоступно. Обновите меню.');
    const focused = document.activeElement === button;
    cartStore.add(item.id);
    if (focused) button.closest('[data-cart-item]')?.querySelector('[data-dish-delta="1"]')?.focus({ preventScroll: true });
    announce(`${item.name} — в корзине`);
  } catch (error) { announce(error.message); }
});
window.addEventListener('cafe:menu', event => receiveMenu(event.detail));
window.addEventListener('cafe:menu-rendered', () => syncDishCartControls(document, cartStore.lines));
window.addEventListener('storage', event => { if (event.key === CART_KEY || event.key === null) { cartStore.reload(); if (dialog.open) refresh(); } });
cartStore.subscribe(render);
receiveMenu(window.cafeMenuSnapshot); render();
