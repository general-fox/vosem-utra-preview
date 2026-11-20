const activeDocuments = new WeakMap();

function addSnowflakes(documentRoot, layer) {
  if (layer.querySelector('.winter-flake')) return [];
  layer.setAttribute('aria-hidden', 'true');
  const flakes = [];
  const crystalLanes = [3, 49, 93, 56, 85, 97, 45];
  for (let index = 0; index < 28; index += 1) {
    const crystal = index % 4 === 1;
    const flake = documentRoot.createElement('span');
    flake.className = `winter-flake${crystal ? ' winter-flake--crystal' : ''}`;
    const lane = crystal ? crystalLanes[Math.floor(index / 4)] : 3 + ((index * 37) % 94);
    flake.style.setProperty('--snow-x', `${lane}%`);
    // On a narrow screen, the larger crystals fall along the outer margins.
    if (crystal) flake.style.setProperty('--snow-mobile-x', `${index % 8 === 1 ? 2 : 93}%`);
    flake.style.setProperty('--snow-delay', `${-((index * 7) % 19)}s`);
    flake.style.setProperty('--snow-duration', `${14 + ((index * 3) % 11)}s`);
    flake.style.setProperty('--snow-size', `${crystal ? 16 + (index % 3) * 3 : 3 + index % 4}px`);
    flake.style.setProperty('--snow-drift', `${-28 + ((index * 13) % 61)}px`);
    layer.appendChild(flake);
    flakes.push(flake);
  }
  return flakes;
}

/** Keep decorative CSS motion idle outside the viewport and when the page is hidden. */
export function initWinterScenes(documentRoot = globalThis.document, view = documentRoot?.defaultView) {
  if (!documentRoot || !view) return () => {};
  if (activeDocuments.has(documentRoot)) return activeDocuments.get(documentRoot);
  const scenes = [...documentRoot.querySelectorAll('[data-winter-scene]')];
  if (!scenes.length) return () => {};

  const flakes = scenes.flatMap((scene) => {
    const layer = scene.querySelector('[data-winter-snow]');
    return layer ? addSnowflakes(documentRoot, layer) : [];
  });
  const visible = new Set();
  const preference = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  let observer;
  let suspended = false;
  let disposed = false;

  const sync = () => {
    const allowed = !disposed && !suspended && !documentRoot.hidden && !preference?.matches;
    for (const scene of scenes) {
      scene.toggleAttribute('data-winter-active', allowed && visible.has(scene));
    }
  };
  const observe = () => {
    for (const scene of scenes) observer.observe(scene);
  };
  const pause = () => {
    suspended = true;
    visible.clear();
    observer?.disconnect();
    sync();
  };
  const resume = (event) => {
    if (!event.persisted || disposed || !observer) return;
    suspended = false;
    // Wait for fresh intersections; restored scroll positions may be different.
    observe();
  };
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    pause();
    preference?.removeEventListener?.('change', sync);
    documentRoot.removeEventListener('visibilitychange', sync);
    view.removeEventListener('pagehide', pause);
    view.removeEventListener('pageshow', resume);
    for (const flake of flakes) flake.remove();
    activeDocuments.delete(documentRoot);
  };
  activeDocuments.set(documentRoot, cleanup);

  try {
    if (!view.IntersectionObserver) return cleanup;
    observer = new view.IntersectionObserver((entries) => {
      if (suspended || disposed) return;
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      sync();
    }, { threshold: 0 });
    preference?.addEventListener?.('change', sync);
    documentRoot.addEventListener('visibilitychange', sync);
    view.addEventListener('pagehide', pause);
    view.addEventListener('pageshow', resume);
    observe();
    sync();
  } catch {
    cleanup();
  }
  return cleanup;
}

if (typeof document !== 'undefined') initWinterScenes(document);
