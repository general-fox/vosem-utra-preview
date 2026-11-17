// Keep only the category rail moving: scrollIntoView would also move the page
// and can disturb the separate drink picker above the mobile controls.
export function setupMobileCategoryRail(root, view = window) {
  const rail = root.querySelector('[data-menu-roots]');
  if (!rail?.getBoundingClientRect || !rail.scrollTo || !view.requestAnimationFrame || !view.matchMedia) return () => {};
  const reducedMotion = view.matchMedia('(prefers-reduced-motion: reduce)');
  const observed = new Set();
  let frame = 0;
  let lastLayout = '';
  let lastSelection = null;
  let pendingTarget = null;
  let pendingAnimation = false;

  const sync = () => {
    frame = 0;
    const target = pendingTarget;
    const animate = pendingAnimation;
    pendingTarget = null;
    pendingAnimation = false;
    const buttons = [...rail.querySelectorAll('button[data-menu-filter]')];
    const width = rail.clientWidth;
    if (!width || !buttons.length) return;
    const scrollWidth = rail.scrollWidth;
    const widths = buttons.map(button => button.getBoundingClientRect().width);
    const gap = Number.parseFloat(view.getComputedStyle(rail).columnGap) || 0;
    if (resize) {
      for (const button of observed) if (!buttons.includes(button)) {
        resize.unobserve(button);
        observed.delete(button);
      }
      for (const button of buttons) if (!observed.has(button)) {
        resize.observe(button);
        observed.add(button);
      }
    }
    const selected = buttons.find(button => button.getAttribute('aria-pressed') === 'true');
    const selection = selected?.dataset.menuFilter ?? null;
    const layout = JSON.stringify([width, scrollWidth, gap, buttons.map((button, index) => [button.dataset.menuFilter, widths[index]])]);
    const focusTarget = buttons.includes(target) ? target : null;
    const shouldCenter = focusTarget || selection !== lastSelection || layout !== lastLayout;
    const smooth = animate && !!lastLayout && !reducedMotion.matches;
    lastLayout = layout;
    lastSelection = selection;
    const button = focusTarget || selected;
    if (!shouldCenter || !button || scrollWidth <= width) return;
    const bounds = rail.getBoundingClientRect();
    const item = button.getBoundingClientRect();
    const left = Math.max(0, Math.min(scrollWidth - width,
      rail.scrollLeft + item.left + item.width / 2 - bounds.left - rail.clientLeft - width / 2));
    rail.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
  };
  const schedule = (target = null, animate = false) => {
    pendingTarget = target || pendingTarget;
    pendingAnimation ||= animate;
    if (!frame) frame = view.requestAnimationFrame(sync);
  };
  const rendered = () => schedule(null, true);
  const resized = () => schedule();
  const focused = event => {
    const button = event.target.closest?.('button[data-menu-filter]');
    if (button && rail.contains(button)) schedule(button, true);
  };
  const resize = view.ResizeObserver ? new view.ResizeObserver(resized) : null;
  resize?.observe(rail);
  rail.addEventListener('focusin', focused);
  rail.addEventListener('click', focused);
  view.addEventListener('cafe:menu-rendered', rendered);
  view.addEventListener('resize', resized);
  schedule();
  return () => {
    if (frame) view.cancelAnimationFrame(frame);
    resize?.disconnect();
    rail.removeEventListener('focusin', focused);
    rail.removeEventListener('click', focused);
    view.removeEventListener('cafe:menu-rendered', rendered);
    view.removeEventListener('resize', resized);
  };
}
