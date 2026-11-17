let dialogSequence = 0;
const money = new Intl.NumberFormat('ru-RU', { style:'currency', currency:'RUB', minimumFractionDigits:0, maximumFractionDigits:2 });

/** One modal for the menu; selections remain owned by their drink cards. */
export function createDrinkAddonsDialog(doc = document, view = window) {
  let dialog;
  let active;
  let context;
  let options;
  let total;
  let closeButton;
  let renderedSignature = '';
  let releaseScroll;
  let backdropPointer = false;
  const checks = new Map();
  const node = (tag, className, text) => {
    const result = doc.createElement(tag);
    result.className = className;
    if (text) result.textContent = text;
    return result;
  };

  function lockScroll() {
    const body = doc.body;
    const root = doc.documentElement;
    const x = view.scrollX || 0;
    const y = view.scrollY || 0;
    const keys = ['position', 'top', 'left', 'width', 'overflow', 'paddingRight'];
    const previous = Object.fromEntries(keys.map(key => [key, body.style[key]]));
    const rootOverflow = root.style.overflow;
    const scrollbar = Math.max(0, (view.innerWidth || 0) - (root.clientWidth || view.innerWidth || 0));
    if (scrollbar) body.style.paddingRight = `${(parseFloat(view.getComputedStyle(body).paddingRight) || 0) + scrollbar}px`;
    root.style.overflow = 'hidden';
    body.style.position = 'fixed';
    body.style.top = `${-y}px`;
    body.style.left = `${-x}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    return () => {
      for (const key of keys) body.style[key] = previous[key];
      root.style.overflow = rootOverflow;
      view.scrollTo({ left:x, top:y, behavior:'instant' });
    };
  }

  function finishClose() {
    // A queued close event from the previous opening must not close a new one.
    if (dialog?.open) return;
    const trigger = active?.trigger;
    active = null;
    releaseScroll?.();
    releaseScroll = null;
    if (trigger?.isConnected !== false) trigger?.focus({ preventScroll:true });
  }

  function close(id) {
    if (!dialog?.open || (id !== undefined && active?.id !== id)) return;
    dialog.close();
    finishClose();
  }

  function outside(event) {
    if (event.target !== dialog) return false;
    const bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  }

  function ensureDialog() {
    if (dialog) return;
    const id = `drink-addons-dialog-${++dialogSequence}`;
    dialog = node('dialog', 'drink-addons-dialog');
    dialog.id = id;
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    dialog.setAttribute('aria-describedby', `${id}-context`);
    const heading = node('div', 'drink-addons-dialog-heading');
    const copy = node('div', 'drink-addons-dialog-copy');
    const title = node('h2', 'drink-addons-dialog-title', 'Дополнения');
    title.id = `${id}-title`;
    context = node('p', 'drink-addons-dialog-context');
    context.id = `${id}-context`;
    copy.append(title, context);
    closeButton = node('button', 'drink-addons-close');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Закрыть дополнения');
    closeButton.addEventListener('click', () => close());
    heading.append(copy, closeButton);
    options = node('div', 'drink-addon-options');
    options.setAttribute('role', 'group');
    options.setAttribute('aria-label', 'Дополнения к напитку');
    const footer = node('div', 'drink-addons-dialog-footer');
    const amount = node('div', 'drink-addons-total');
    total = node('strong', 'drink-addons-total-value');
    total.setAttribute('aria-live', 'polite');
    total.setAttribute('aria-atomic', 'true');
    amount.append(node('span', 'drink-addons-total-label', 'Итого за напиток'), total);
    const done = node('button', 'drink-addons-done', 'Готово');
    done.type = 'button';
    done.addEventListener('click', () => close());
    footer.append(amount, done);
    dialog.append(heading, options, footer);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', finishClose);
    dialog.addEventListener('pointerdown', event => { backdropPointer = outside(event); });
    dialog.addEventListener('click', event => {
      if (backdropPointer && outside(event)) close();
      backdropPointer = false;
    });
    doc.body.append(dialog);
  }

  function refresh(id) {
    if (!active || active.id !== id) return;
    const state = active.getState();
    context.textContent = `${active.name} · ${state.volumeMl} мл`;
    total.textContent = state.total;
    for (const [name, checkbox] of checks) checkbox.checked = state.selected.has(name);
  }

  function configure(config) {
    const signature = JSON.stringify([config.id, config.name, config.addons]);
    const focusedName = doc.activeElement?.dataset?.addonName;
    active = config;
    active.trigger.setAttribute('aria-controls', dialog.id);
    if (signature !== renderedSignature) {
      checks.clear();
      const rows = config.addons.map(addon => {
        const label = node('label', 'drink-addon');
        const checkbox = node('input', 'drink-addon-check');
        checkbox.type = 'checkbox';
        checkbox.dataset.addonName = addon.name;
        checkbox.addEventListener('change', () => {
          active.onChange(addon.name, checkbox.checked);
          refresh(active.id);
        });
        checks.set(addon.name, checkbox);
        label.append(checkbox, node('span', 'drink-addon-name', addon.name), node('span', 'drink-addon-price', addon.price ? `+${money.format(addon.price)}` : 'Бесплатно'));
        return label;
      });
      options.replaceChildren(...rows);
      options.scrollTop = 0;
      renderedSignature = signature;
      if (dialog.open && focusedName) (checks.get(focusedName) || closeButton).focus({ preventScroll:true });
    }
    refresh(config.id);
  }

  return {
    open(config) {
      ensureDialog();
      configure(config);
      if (!dialog.open) {
        releaseScroll = lockScroll();
        try {
          // Native autofocus may scroll before showModal() returns, especially
          // on touch browsers. Capture the page position before opening it.
          dialog.showModal();
        } catch (error) {
          releaseScroll();
          releaseScroll = null;
          active = null;
          throw error;
        }
        options.scrollTop = 0;
        closeButton.focus({ preventScroll:true });
      }
    },
    update(config) {
      if (dialog?.open && active?.id === config.id) configure(config);
    },
    refresh,
    close,
    retain(ids) {
      if (active && !ids.includes(active.id)) close();
    },
  };
}
