// Follow the rendered header instead of assuming its height or stylesheet
// version. The menu-only variables cannot change the header being observed.
export function setupMenuHeader(root, view = window) {
  const document = root?.ownerDocument || view.document;
  const header = document?.querySelector('.site-header');
  if (!header?.getBoundingClientRect || !root?.style?.setProperty || !view.getComputedStyle) return () => {};
  const names = ['--menu-header-height', '--menu-header-width', '--menu-header-surface', '--menu-header-backdrop'];
  const previous = names.map(name => [name, root.style.getPropertyValue(name), root.style.getPropertyPriority(name)]);
  let frame = 0;
  const set = (name, value) => {
    if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
  };
  const sync = () => {
    frame = 0;
    const { height, width } = header.getBoundingClientRect();
    const style = view.getComputedStyle(header);
    if (Number.isFinite(height) && height > 0) set('--menu-header-height', height + 'px');
    if (Number.isFinite(width) && width > 0) set('--menu-header-width', width + 'px');
    if (style.backgroundColor) set('--menu-header-surface', style.backgroundColor);
    const backdrop = style.backdropFilter && style.backdropFilter !== 'none'
      ? style.backdropFilter : style.webkitBackdropFilter || 'none';
    set('--menu-header-backdrop', backdrop);
  };
  const schedule = () => {
    if (!view.requestAnimationFrame) { sync(); return; }
    if (!frame) frame = view.requestAnimationFrame(sync);
  };
  const resize = view.ResizeObserver ? new view.ResizeObserver(schedule) : null;
  resize?.observe(header, { box: 'border-box' });
  view.addEventListener('resize', schedule);
  sync();
  return () => {
    if (frame) view.cancelAnimationFrame(frame);
    resize?.disconnect();
    view.removeEventListener('resize', schedule);
    for (const [name, value, priority] of previous) {
      if (value) root.style.setProperty(name, value, priority);
      else root.style.removeProperty(name);
    }
  };
}
