// Native HTML drag handles mouse users; Pointer Events provide touch/pen sorting.
export function setupTouchPhotoSort(list, { onMove, isDisabled = () => false, document: doc = document, window: win = window }) {
  const noop = () => {};
  if (!win.PointerEvent) return { cancel: noop, destroy: noop };
  const dialog = list.closest('dialog');
  let gesture = null;
  function cancel() {
    if (!gesture) return;
    const current = gesture;
    gesture = null;
    current.ghost?.remove();
    current.row.classList.remove('is-dragging');
    for (const row of list.children) row.classList.remove('is-drop-target');
    try { current.handle.releasePointerCapture(current.pointerId); } catch { /* Capture may already be released. */ }
  }
  function targetAt(event) {
    const target = doc.elementFromPoint(event.clientX, event.clientY)?.closest('.photo-list-item');
    return target?.parentElement === list ? target : null;
  }
  function start(event) {
    if (!['touch', 'pen'].includes(event.pointerType) || event.isPrimary === false || isDisabled()) return;
    const handle = event.target.closest('.photo-select');
    const row = handle?.closest('.photo-list-item');
    if (!row || row.parentElement !== list) return;
    cancel();
    const rect = row.getBoundingClientRect();
    gesture = { pointerId: event.pointerId, row, handle, from: [...list.children].indexOf(row), x: event.clientX, y: event.clientY,
      offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, width: rect.width, height: rect.height, ghost: null };
    try { handle.setPointerCapture(event.pointerId); } catch { /* Document listeners still receive a local gesture. */ }
  }
  function move(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (isDisabled() || !list.isConnected) { cancel(); return; }
    if (!gesture.ghost && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 6) return;
    event.preventDefault();
    if (!gesture.ghost) {
      gesture.ghost = gesture.row.cloneNode(true);
      gesture.ghost.className = 'photo-list-item photo-drag-ghost';
      gesture.ghost.setAttribute('aria-hidden', 'true');
      gesture.ghost.inert = true;
      Object.assign(gesture.ghost.style, { width: gesture.width + 'px', height: gesture.height + 'px' });
      (dialog || doc.body).append(gesture.ghost);
      gesture.row.classList.add('is-dragging');
    }
    Object.assign(gesture.ghost.style, { left: (event.clientX - gesture.offsetX) + 'px', top: (event.clientY - gesture.offsetY) + 'px' });
    if (dialog) {
      const bounds = dialog.getBoundingClientRect();
      if (event.clientY < bounds.top + 40) dialog.scrollTop -= 12;
      else if (event.clientY > bounds.bottom - 40) dialog.scrollTop += 12;
    }
    const target = targetAt(event);
    for (const row of list.children) row.classList.toggle('is-drop-target', row === target && row !== gesture.row);
  }
  function end(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const current = gesture;
    const target = current.ghost && !isDisabled() ? targetAt(event) : null;
    const to = target ? [...list.children].indexOf(target) : -1;
    cancel();
    if (to >= 0 && to !== current.from) { event.preventDefault(); onMove(current.from, to); }
  }
  function cancelled(event) { if (event.pointerId === gesture?.pointerId) cancel(); }
  function keyboard(event) { if (event.key === 'Escape') cancel(); }
  list.addEventListener('pointerdown', start);
  doc.addEventListener('pointermove', move, { passive: false });
  doc.addEventListener('pointerup', end);
  doc.addEventListener('pointercancel', cancelled);
  doc.addEventListener('keydown', keyboard);
  win.addEventListener('blur', cancel);
  dialog?.addEventListener('close', cancel);
  return { cancel, destroy() {
    cancel();
    list.removeEventListener('pointerdown', start);
    doc.removeEventListener('pointermove', move);
    doc.removeEventListener('pointerup', end);
    doc.removeEventListener('pointercancel', cancelled);
    doc.removeEventListener('keydown', keyboard);
    win.removeEventListener('blur', cancel);
    dialog?.removeEventListener('close', cancel);
  } };
}
