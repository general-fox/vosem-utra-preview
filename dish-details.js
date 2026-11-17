import { createMenuGallery } from './menu-gallery.js';
import { menuImages } from './menu-images.js';

let sequence = 0;

// Older exports kept nutrition at the end of the composition. Read them without
// repeating it on the card while the administrator moves to separate fields.
export function dishInformation(item) {
  const description = String(item.description || '').trim();
  const legacy = /\s*к\s*б\s*ж\s*у\s*[:：]?\s*([0-9][\s\S]*)$/iu.exec(description);
  return {
    composition: (legacy ? description.slice(0, legacy.index) : description).trim(),
    nutrition: String((Object.hasOwn(item, 'nutrition') ? item.nutrition : legacy?.[1]) || '').replace(/^\s*к\s*б\s*ж\s*у\s*[:：]?\s*/iu, '').trim(),
    allergens: String(item.allergens || '').trim(),
  };
}

export function createDishDetails({ document: doc = document, window: win = window, pageBase }) {
  let dialog, title, content, photos, closeButton, active, gallery, releaseScroll;
  let backdropPointer = false;
  const node = (tag, className, text) => {
    const result = doc.createElement(tag);
    result.className = className;
    if (text) result.textContent = text;
    return result;
  };
  function lockScroll() {
    const body = doc.body;
    const root = doc.documentElement;
    const x = win.scrollX || 0;
    const y = win.scrollY || 0;
    const keys = ['position', 'top', 'left', 'width', 'overflow', 'paddingRight'];
    const previous = Object.fromEntries(keys.map(key => [key, body.style[key]]));
    const overflow = root.style.overflow;
    const scrollbar = Math.max(0, (win.innerWidth || 0) - (root.clientWidth || win.innerWidth || 0));
    if (scrollbar) body.style.paddingRight = `${(parseFloat(win.getComputedStyle(body).paddingRight) || 0) + scrollbar}px`;
    root.style.overflow = 'hidden';
    Object.assign(body.style, { position:'fixed', top:`${-y}px`, left:`${-x}px`, width:'100%', overflow:'hidden' });
    return () => {
      for (const key of keys) body.style[key] = previous[key];
      root.style.overflow = overflow;
      win.scrollTo({ left:x, top:y, behavior:'instant' });
    };
  }
  function finished() {
    if (dialog?.open) return;
    const trigger = active?.trigger;
    active = null;
    gallery?.destroy();
    gallery = null;
    releaseScroll?.();
    releaseScroll = null;
    if (trigger?.isConnected !== false) trigger?.focus({ preventScroll:true });
  }
  function close() {
    if (!dialog?.open) return;
    dialog.close();
    finished();
  }
  function outside(event) {
    if (event.target !== dialog) return false;
    const bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  }
  function ensure() {
    if (dialog) return;
    dialog = node('dialog', 'dish-details-dialog');
    dialog.id = `dish-details-${++sequence}`;
    dialog.setAttribute('aria-labelledby', `${dialog.id}-title`);
    const heading = node('div', 'dish-details-heading');
    title = node('h2', 'dish-details-title');
    title.id = `${dialog.id}-title`;
    closeButton = node('button', 'dish-details-close');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Закрыть информацию о блюде');
    closeButton.addEventListener('click', close);
    heading.append(title, closeButton);
    const layout = node('div', 'dish-details-layout');
    photos = node('div', 'dish-visual dish-details-photos');
    content = node('div', 'dish-details-content');
    layout.append(photos, content);
    dialog.append(heading, layout);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', finished);
    dialog.addEventListener('pointerdown', event => { backdropPointer = outside(event); });
    dialog.addEventListener('click', event => {
      if (backdropPointer && outside(event)) close();
      backdropPointer = false;
    });
    doc.body.append(dialog);
  }
  function configure(item, trigger, price) {
    active = { item, trigger, price };
    trigger?.setAttribute('aria-controls', dialog.id);
    title.textContent = item.name;
    gallery?.destroy();
    photos.replaceChildren();
    photos.className = 'dish-visual dish-details-photos';
    photos.removeAttribute('aria-hidden');
    const images = menuImages(item);
    photos.hidden = !images.length;
    gallery = createMenuGallery({ visual:photos, images, name:item.name, eager:true, pageBase, document:doc, window:win,
      placeholder(visual) {
        visual.replaceChildren(node('span', 'dish-placeholder-mark'));
        visual.setAttribute('aria-label', 'Фотография недоступна');
      },
    });
    content.replaceChildren(node('p', 'dish-details-price', price));
    const info = dishInformation(item);
    for (const [key, label] of [['composition','Состав'], ['nutrition','КБЖУ'], ['allergens','Аллергены']]) {
      if (!info[key]) continue;
      const section = node('section', `dish-details-section dish-details-${key}`);
      section.append(node('h3', 'dish-details-label', label), node('p', 'dish-details-text', info[key]));
      content.append(section);
    }
  }
  return {
    open(item, trigger, price) {
      ensure();
      configure(item, trigger, price);
      if (!dialog.open) {
        releaseScroll = lockScroll();
        try { dialog.showModal(); }
        catch (error) { finished(); throw error; }
        dialog.scrollTop = 0;
        closeButton.focus({ preventScroll:true });
      }
    },
    update(item, trigger, price) {
      if (dialog?.open && active?.item.id === item.id) configure(item, trigger, price);
    },
    retain(ids) { if (active && !ids.includes(active.item.id)) close(); },
    close,
  };
}

export function bindDishCardDetails(card, trigger, open) {
  let start = null;
  let moved = false;
  let suppressUntil = 0;
  trigger.addEventListener('click', open);
  card.addEventListener('pointerdown', event => {
    start = { x:event.clientX, y:event.clientY };
    moved = false;
  }, { passive:true });
  card.addEventListener('pointermove', event => {
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) moved = true;
  }, { passive:true });
  const stop = event => {
    if (moved || event.type === 'pointercancel') suppressUntil = Date.now() + 600;
    start = null;
  };
  card.addEventListener('pointerup', stop, { passive:true });
  card.addEventListener('pointercancel', stop, { passive:true });
  card.addEventListener('click', event => {
    // Gallery navigation, quantity controls and the explicit details button each
    // own their clicks. Native horizontal swipes must never open a dialog.
    for (let target = event.target; target && target !== card; target = target.parentElement) {
      if (['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
    }
    if (Date.now() < suppressUntil || winSelection(card)) return;
    open();
  });
}
function winSelection(card) {
  const selection = card.ownerDocument?.defaultView?.getSelection?.();
  return selection && !selection.isCollapsed && card.contains(selection.anchorNode);
}
