// Native horizontal scrolling keeps swipe gestures and vertical page scrolling independent.
export function createMenuGallery({ visual, images, name, kind = 'dish', hoverPreview = true, eager = false, pageBase, document: doc = document, window: win = window, placeholder }) {
  const node = (tag, className) => {
    const el = doc.createElement(tag);
    el.className = className;
    return el;
  };
  const photo = (src, index, failed) => {
    const img = node('img', `${kind}-photo`);
    img.alt = images.length > 1 ? `${name} — фото ${index + 1} из ${images.length}` : name;
    img.loading = eager ? 'eager' : 'lazy';
    img.decoding = 'async';
    img.width = 600;
    img.height = 450;
    img.draggable = false;
    img.addEventListener('error', failed, { once: true });
    const url = new URL(src, pageBase);
    if (/^[a-zA-Z0-9][a-zA-Z0-9._-]*-wide-filled\.webp$/i.test(url.pathname.split('/').pop())) img.classList.add('menu-photo-filled');
    img.src = url.href;
    return img;
  };
  if (!images.length) {
    placeholder(visual, kind);
    return { destroy() {} };
  }
  if (images.length === 1) {
    visual.append(photo(images[0], 0, () => placeholder(visual, kind)));
    return { destroy() {} };
  }
  visual.classList.add('menu-gallery');
  if (hoverPreview) visual.classList.add('menu-gallery-card');
  visual.setAttribute('role', 'group');
  visual.setAttribute('aria-label', `Фотографии: ${name}`);
  const track = node('div', 'menu-gallery-track');
  track.tabIndex = 0;
  track.setAttribute('aria-label', `Фотографии: ${name}. Для переключения используйте стрелки влево и вправо.`);
  for (const [index, src] of images.entries()) {
    const slide = node('div', 'menu-gallery-slide');
    slide.append(photo(src, index, () => {
      slide.replaceChildren(node('span', 'dish-placeholder-mark'));
      slide.setAttribute('role', 'img');
      slide.setAttribute('aria-label', `${name} — фото ${index + 1} недоступно`);
    }));
    track.append(slide);
  }
  const dots = node('div', 'menu-gallery-dots');
  dots.setAttribute('role', 'group');
  dots.setAttribute('aria-label', 'Выбрать фотографию');
  const status = node('span', 'visually-hidden');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  let current = -1;
  let destination = null;
  let hovering = false;
  let hoverSuspended = false;
  const arrows = (hoverPreview ? [] : [-1, 1]).map(direction => {
    const button = node('button', `menu-gallery-arrow menu-gallery-${direction < 0 ? 'previous' : 'next'}`);
    button.type = 'button';
    button.setAttribute('aria-label', `${direction < 0 ? 'Предыдущее' : 'Следующее'} фото: ${name}`);
    const mark = node('span', 'menu-gallery-chevron');
    mark.setAttribute('aria-hidden', 'true');
    button.append(mark);
    button.addEventListener('click', () => go((destination ?? current) + direction));
    return button;
  });
  const buttons = images.map((_, index) => {
    const button = node('button', 'menu-gallery-dot');
    button.type = 'button';
    button.setAttribute('aria-label', `Фото ${index + 1} из ${images.length}: ${name}`);
    button.addEventListener('click', () => go(index));
    return button;
  });
  function sync(index, announce = true) {
    const next = Math.max(0, Math.min(images.length - 1, index));
    if (next === current) return;
    current = next;
    buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === current)));
    if (arrows.length) {
      arrows[0].disabled = current === 0;
      arrows[1].disabled = current === images.length - 1;
    }
    visual.dataset.galleryIndex = String(current);
    status.setAttribute('aria-live', announce ? 'polite' : 'off');
    status.textContent = `Фото ${current + 1} из ${images.length}`;
  }
  // Actual slide positions include any gap and avoid cumulative rounding at fractional widths.
  const slidePosition = index => track.children[index]?.offsetLeft ?? index * track.clientWidth;
  function stopHover() { hovering = false; hoverSuspended = true; }
  function go(index, { instant = false, hover = false } = {}) {
    if (!hover) stopHover();
    destination = Math.max(0, Math.min(images.length - 1, index));
    sync(destination, !hover);
    const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    track.scrollTo({ left: slidePosition(current), behavior: instant || reduced ? 'instant' : 'smooth' });
  }
  function onHover(event) {
    if (!hoverPreview || hoverSuspended || event.pointerType !== 'mouse' || event.buttons
      || !win.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;
    // Dots keep their own target; moving over them must not select another zone.
    for (let target = event.target; target && target !== visual; target = target.parentElement) {
      if (['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
    }
    const bounds = visual.getBoundingClientRect();
    if (!(bounds.width > 0) || !Number.isFinite(event.clientX)) return;
    const index = Math.max(0, Math.min(images.length - 1, Math.floor((event.clientX - bounds.left) / bounds.width * images.length)));
    hovering = true;
    if (index !== current) go(index, { instant:true, hover:true });
  }
  function onLeave() {
    const reset = hovering;
    hovering = false;
    hoverSuspended = false;
    if (reset && current !== 0) go(0, { instant:true, hover:true });
  }
  const onScroll = () => {
    if (track.clientWidth > 0) {
      let nearest = 0;
      for (let index = 1; index < images.length; index++) {
        if (Math.abs(track.scrollLeft - slidePosition(index)) < Math.abs(track.scrollLeft - slidePosition(nearest))) nearest = index;
      }
      sync(nearest);
      if (destination !== null && Math.abs(track.scrollLeft - slidePosition(destination)) < 1) destination = null;
    }
  };
  const onManualScroll = () => { destination = null; };
  const onManualStart = () => { stopHover(); onManualScroll(); };
  const onKey = event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const index = { ArrowLeft: (destination ?? current) - 1, ArrowRight: (destination ?? current) + 1, Home: 0, End: images.length - 1 }[event.key];
    if (index === undefined) return;
    event.preventDefault();
    go(index);
  };
  track.addEventListener('scroll', onScroll, { passive: true });
  track.addEventListener('keydown', onKey);
  track.addEventListener('pointerdown', onManualStart, { passive: true });
  track.addEventListener('wheel', onManualStart, { passive: true });
  track.addEventListener('scrollend', onManualScroll);
  if (hoverPreview) {
    visual.addEventListener('pointerenter', onHover, { passive:true });
    visual.addEventListener('pointermove', onHover, { passive:true });
    visual.addEventListener('pointerleave', onLeave, { passive:true });
  }
  dots.append(...buttons);
  visual.append(track, ...arrows, dots, status);
  sync(0);
  // A cached card may return from another category at a new width. Keep its selected photo.
  let width = 0;
  const resize = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => {
    if (!track.clientWidth || track.clientWidth === width) return;
    width = track.clientWidth;
    destination = null;
    track.scrollTo({ left: slidePosition(current), behavior: 'instant' });
  }) : null;
  resize?.observe(track);
  return {
    destroy() {
      resize?.disconnect();
      visual.removeEventListener('pointerenter', onHover);
      visual.removeEventListener('pointermove', onHover);
      visual.removeEventListener('pointerleave', onLeave);
      track.removeEventListener('scroll', onScroll);
      track.removeEventListener('keydown', onKey);
      track.removeEventListener('pointerdown', onManualStart);
      track.removeEventListener('wheel', onManualStart);
      track.removeEventListener('scrollend', onManualScroll);
    },
  };
}
