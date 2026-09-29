import { CART_LIMITS } from './cart-store.js';

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

// Patch the controls in place: a quantity update must not recreate a card,
// interrupt its reveal, move keyboard focus or restart photo loading.
export function syncDishCartControls(root, lines) {
  const quantities = new Map(lines.map(line => [line.id, line.qty]));
  root.querySelectorAll('[data-cart-item]').forEach(actions => {
    const add = actions.querySelector('[data-cart-add]');
    if (!add) return;
    const card = actions.closest('.dish-card');
    const name = card?.querySelector('h3')?.textContent || 'блюдо';
    let selected = actions.querySelector('.dish-cart-selected');
    if (!selected) {
      selected = node('div', 'dish-cart-selected');
      const status = node('span', 'dish-in-cart');
      status.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="m3 8 3.2 3.2L13 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      status.append(node('span', '', 'В корзине'));
      const controls = node('div', 'dish-quantity');
      controls.setAttribute('role', 'group');
      controls.setAttribute('aria-label', `Количество в корзине: ${name}`);
      for (const [delta, text, label] of [[-1, '−', 'Уменьшить количество'], [1, '+', 'Увеличить количество']]) {
        const button = node('button', 'dish-quantity-button', text);
        button.type = 'button';
        button.dataset.dishDelta = String(delta);
        button.setAttribute('aria-label', `${label}: ${name}`);
        if (delta === 1) controls.append(node('span', 'dish-quantity-value'));
        controls.append(button);
      }
      selected.append(status, controls);
      actions.append(selected);
    }
    const qty = quantities.get(actions.dataset.cartItem) || 0;
    add.hidden = qty > 0;
    selected.hidden = qty === 0;
    selected.querySelector('.dish-quantity-value').textContent = String(qty);
    selected.querySelector('[data-dish-delta="1"]').disabled = add.disabled || qty >= CART_LIMITS.quantity;
    // Removing the last portion remains available even if a dish is sold out.
    selected.querySelector('[data-dish-delta="-1"]').disabled = qty === 0;
    selected.querySelector('.dish-in-cart span').textContent = add.disabled ? 'В корзине · нет в наличии' : 'В корзине';
    card?.classList.toggle('is-in-cart', qty > 0);
  });
}
