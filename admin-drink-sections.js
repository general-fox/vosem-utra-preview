import { orderedDrinkSections } from './menu-drinks-model.js';

export function drinkSectionOrderForItem(items, categoryId, section) {
  const drinks = items.filter(item => item.category === categoryId && item.drink);
  const ranks = drinks.filter(item => Number.isInteger(item.drink.sectionOrder));
  const matches = ranks.filter(item => item.drink.section === section);
  if (matches.length) return Math.min(...matches.map(item => item.drink.sectionOrder));
  return ranks.length ? Math.min(10000, Math.max(...ranks.map(item => item.drink.sectionOrder)) + 1) : undefined;
}

/** Rename all members atomically, including hidden drinks, without touching other groups. */
export function applyDrinkSectionEdits(items, categoryId, sections) {
  const current = new Set(items.filter(item => item.category === categoryId && item.drink).map(item => item.drink.section));
  const edits = new Map(), names = new Set();
  for (const [order, section] of sections.entries()) {
    const name = typeof section.name === 'string' ? section.name.trim() : '';
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) throw new Error('Введите название каждой подгруппы — до 80 символов.');
    const key = name.toLocaleLowerCase('ru');
    if (names.has(key)) throw new Error('Названия подгрупп не должны повторяться.');
    if (!current.has(section.originalName) || edits.has(section.originalName)) throw new Error('Список подгрупп изменился. Закройте редактор и откройте его снова.');
    names.add(key); edits.set(section.originalName, { section: name, sectionOrder: order });
  }
  if (edits.size !== current.size) throw new Error('Список подгрупп изменился. Закройте редактор и откройте его снова.');
  return items.map(item => item.category === categoryId && item.drink
    ? { ...item, drink: { ...item.drink, ...edits.get(item.drink.section) } } : item);
}

export function createDrinkSectionManager({ document, state, persist, notice, setBusy, confirm = text => window.confirm(text) }) {
  const $ = id => document.getElementById(id);
  const dialog = $('drink-sections-dialog'), list = $('drink-sections-list');
  const draft = { sections: [], items: [], categoryId: null, revision: null, dirty: false, resume: false };
  let rows = [], drag = null;
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  function error(text = '') { $('drink-sections-error').textContent = text; $('drink-sections-error').hidden = !text; }
  function busy(value) {
    $('drink-sections-fields').disabled = value;
    for (const id of ['close-drink-sections', 'cancel-drink-sections']) $(id).disabled = value;
    $('save-drink-sections').disabled = value || !state.loaded || state.conflict || draft.revision !== state.revision;
    $('save-drink-sections').textContent = value ? 'Сохраняем…' : 'Сохранить';
    $('drink-sections-form').setAttribute('aria-busy', String(value));
  }
  function labels() {
    rows.forEach(({ input, handle, up, down }, index) => {
      const name = draft.sections[index].name.trim() || 'Без названия';
      input.setAttribute('aria-label', `Название подгруппы ${index + 1}`);
      handle.setAttribute('aria-label', `Переместить «${name}»`);
      up.setAttribute('aria-label', `Переместить «${name}» выше`);
      down.setAttribute('aria-label', `Переместить «${name}» ниже`);
    });
  }
  function render() {
    rows = draft.sections.map((section, index) => {
      const row = node('li', 'category-sort-row drink-section-sort-row');
      const handle = node('button', 'category-drag-handle', '⠿');
      handle.type = 'button'; handle.dataset.sectionDrag = section.originalName;
      handle.setAttribute('aria-describedby', 'drink-sections-help');
      const field = node('div', 'drink-section-name-field');
      const input = node('input'); input.type = 'text'; input.maxLength = 80; input.required = true;
      input.value = section.name; input.dataset.sectionName = section.originalName;
      input.addEventListener('input', () => { section.name = input.value; draft.dirty = true; labels(); error(); });
      field.append(input, node('span', 'category-sort-count', `Напитков: ${section.count}`));
      const actions = node('div', 'category-sort-actions');
      const up = node('button', 'category-sort-arrow', '↑'), down = node('button', 'category-sort-arrow', '↓');
      for (const [button, direction] of [[up, -1], [down, 1]]) {
        button.type = 'button'; button.dataset.sectionMove = section.originalName; button.dataset.direction = String(direction);
      }
      up.disabled = index === 0; down.disabled = index === draft.sections.length - 1;
      actions.append(up, down); row.append(handle, field, actions);
      return { row, handle, input, up, down, originalName: section.originalName };
    });
    list.replaceChildren(...rows.map(row => row.row)); labels();
  }
  function reorder(originalName, destination, focus = 'handle') {
    if (state.busy) return;
    const index = draft.sections.findIndex(section => section.originalName === originalName);
    const target = Math.max(0, Math.min(draft.sections.length - 1, destination));
    if (index < 0 || index === target) return;
    const [moved] = draft.sections.splice(index, 1); draft.sections.splice(target, 0, moved);
    draft.dirty = true; render();
    const row = rows.find(entry => entry.originalName === originalName);
    (row[focus].disabled ? row.handle : row[focus]).focus();
    $('drink-sections-announcement').textContent = `«${moved.name}»: место ${target + 1} из ${rows.length}. Нажмите «Сохранить», чтобы применить порядок.`;
  }
  function clearDrag() {
    if (!drag) return;
    const { pointerId, row } = drag; drag = null;
    row.classList.remove('is-dragging'); row.style.removeProperty('transform');
    rows.forEach(entry => entry.row.classList.remove('drop-before', 'drop-after'));
    if (list.hasPointerCapture?.(pointerId)) list.releasePointerCapture(pointerId);
  }
  function close() {
    if (state.busy || (draft.dirty && !confirm('Закрыть подгруппы? Несохранённые изменения будут потеряны.'))) return;
    clearDrag(); draft.dirty = false; draft.resume = false; dialog.close();
  }
  function open() {
    if (state.busy || !state.loaded || state.conflict) return;
    const sections = orderedDrinkSections(state.items.filter(item => item.category === state.siteCategory).sort((a, b) => a.order - b.order));
    if (!sections.length) return;
    draft.categoryId = state.siteCategory; draft.items = [...state.items]; draft.revision = state.revision;
    draft.sections = sections.map(section => ({ originalName: section.name, name: section.name, count: section.items.length }));
    draft.dirty = false; draft.resume = false; clearDrag(); render(); error(); busy(false);
    $('drink-sections-context').textContent = `Группа «${state.categories.find(group => group.id === draft.categoryId)?.name || 'Напитки'}». Название изменится у всех напитков подгруппы, включая скрытые.`;
    $('drink-sections-announcement').textContent = ''; dialog.showModal(); $('drink-sections-title').focus();
  }
  $('manage-drink-sections').addEventListener('click', open);
  $('close-drink-sections').addEventListener('click', close);
  $('cancel-drink-sections').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  list.addEventListener('click', event => {
    const button = event.target.closest('button[data-section-move]');
    if (!button) return;
    const index = draft.sections.findIndex(section => section.originalName === button.dataset.sectionMove);
    const direction = Number(button.dataset.direction);
    reorder(button.dataset.sectionMove, index + direction, direction < 0 ? 'up' : 'down');
  });
  list.addEventListener('keydown', event => {
    const handle = event.target.closest('button[data-section-drag]');
    if (!handle || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = draft.sections.findIndex(section => section.originalName === handle.dataset.sectionDrag);
    reorder(handle.dataset.sectionDrag, event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : index + (event.key === 'ArrowUp' ? -1 : 1));
  });
  list.addEventListener('pointerdown', event => {
    const handle = event.target.closest('button[data-section-drag]');
    if (!handle || state.busy || (event.button !== undefined && event.button !== 0)) return;
    const entry = rows.find(row => row.originalName === handle.dataset.sectionDrag);
    if (!entry) return;
    clearDrag(); drag = { originalName: entry.originalName, pointerId: event.pointerId, row: entry.row, startY: event.clientY, target: rows.indexOf(entry), active: false };
    list.setPointerCapture?.(event.pointerId); handle.focus(); event.preventDefault();
  });
  list.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const distance = event.clientY - drag.startY;
    if (!drag.active && Math.abs(distance) < 5) return;
    drag.active = true; event.preventDefault(); drag.row.classList.add('is-dragging'); drag.row.style.transform = `translateY(${distance}px)`;
    const box = list.getBoundingClientRect();
    if (event.clientY < box.top + 30) list.scrollTop -= 12;
    else if (event.clientY > box.bottom - 30) list.scrollTop += 12;
    const others = rows.filter(row => row.originalName !== drag.originalName);
    let target = others.findIndex(row => { const rect = row.row.getBoundingClientRect(); return event.clientY < rect.top + rect.height / 2; });
    if (target < 0) target = others.length;
    drag.target = target; rows.forEach(row => row.row.classList.remove('drop-before', 'drop-after'));
    if (others[target]) others[target].row.classList.add('drop-before'); else others.at(-1)?.row.classList.add('drop-after');
  });
  function finish(event, cancelled = false) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { originalName, target, active } = drag; clearDrag();
    if (active && !cancelled) reorder(originalName, target);
  }
  list.addEventListener('pointerup', event => finish(event));
  list.addEventListener('pointercancel', event => finish(event, true));
  list.addEventListener('lostpointercapture', clearDrag);
  $('drink-sections-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (state.busy || !state.loaded) return;
    if (state.conflict || draft.revision !== state.revision) { error('Меню уже изменилось. Закройте подгруппы, обновите меню и откройте редактор снова.'); return; }
    if (!draft.dirty) { dialog.close(); return; }
    let items;
    try { items = applyDrinkSectionEdits(draft.items, draft.categoryId, draft.sections); }
    catch (cause) { error(cause.message); return; }
    setBusy(true); error();
    try {
      await persist(items); draft.dirty = false; draft.resume = false; dialog.close(); notice('Названия и порядок подгрупп сохранены.');
    } catch (cause) {
      error(state.conflict ? 'Меню изменилось или ответ о сохранении не получен. Закройте подгруппы и обновите меню перед повторным редактированием.' : cause.message);
    } finally { setBusy(false); }
  });
  return { open, close, busy,
    get pending() { return draft.resume; },
    get unsaved() { return draft.dirty && (dialog.open || draft.resume); },
    suspend() { clearDrag(); draft.resume = draft.resume || dialog.open; dialog.close(); },
    restore() {
      if (!draft.resume) return; draft.resume = false; dialog.showModal(); busy(state.busy);
      if (draft.revision !== state.revision) error('Меню изменилось. Закройте подгруппы и откройте редактор снова.');
    },
  };
}
