const menu = document.querySelector('.mobile-nav');
if (menu) {
  menu.addEventListener('click', (event) => {
    if (event.target.closest('a')) menu.open = false;
  });
  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      menu.querySelector('summary').focus();
    }
  });
  matchMedia('(min-width: 901px)').addEventListener('change', (event) => {
    if (event.matches) menu.open = false;
  });
}
document.querySelectorAll('[data-year]').forEach((element) => {
  element.textContent = new Date().getFullYear();
});

/**
 * Decorative, bounded intro. Never locks scrolling, focus or pointer input.
 * The head watchdog independently removes it if this module cannot run.
 */
function initIntro() {
  const root = document.documentElement;
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const sheet = document.querySelector('.intro-sheet');
  if (root.dataset.intro !== 'waiting' || preference.matches || document.hidden || !sheet?.animate) {
    root.removeAttribute('data-intro');
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const started = performance.now();
    const timers = new Set();
    let lift;
    const immediateInputs = ['keydown', 'focusin'];
    const gentleInputs = ['touchstart', 'wheel'];
    let finished = false;
    const later = (callback, delay) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      // Hide first: cancelling a forwards-filled animation must not flash its first frame.
      root.removeAttribute('data-intro');
      lift?.cancel();
      immediateInputs.forEach((type) => document.removeEventListener(type, finish, true));
      gentleInputs.forEach((type) => document.removeEventListener(type, open, true));
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', finish);
      window.removeEventListener('hashchange', finish);
      preference.removeEventListener('change', onPreference);
      resolve();
    };
    const onVisibility = () => { if (document.hidden) finish(); };
    const onPreference = (event) => { if (event.matches) finish(); };
    const onPointer = (event) => {
      // Links and fields respond immediately; a swipe on the page never tears off the curtain.
      if (event.target?.closest?.('a,button,input,textarea,select,summary,[tabindex]')) finish();
      else open();
    };
    const open = () => {
      if (finished || root.dataset.intro !== 'waiting') return;
      if (preference.matches || document.hidden) {
        finish();
        return;
      }
      root.dataset.intro = 'leaving';
      const duration = 1100;
      try {
        // Native transform-only animation lets the compositor move an already-painted
        // sheet. No frame-by-frame SVG writes, blur, morphing, or layout measurements.
        lift = sheet.animate([
          { transform: 'translate3d(0,0,0)' },
          { transform: 'translate3d(0,-101%,0)' },
        ], { duration, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' });
        lift.finished.then(finish, finish);
      } catch {
        finish();
        return;
      }
      // Start the first-screen reveals as the curtain begins to lift.
      resolve();
      later(finish, duration + 150);
    };
    immediateInputs.forEach((type) => document.addEventListener(type, finish, { capture: true, passive: true }));
    gentleInputs.forEach((type) => document.addEventListener(type, open, { capture: true, passive: true }));
    document.addEventListener('pointerdown', onPointer, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', finish);
    window.addEventListener('hashchange', finish);
    preference.addEventListener('change', onPreference);
    later(finish, 2000);

    // Give the logo/font and hero a brief chance to decode, never wait for lazy images.
    const assets = [...document.querySelectorAll('.hero-photo, .intro-logo')].map((img) => {
      try { return img.decode ? img.decode().catch(() => {}) : Promise.resolve(); }
      catch { return Promise.resolve(); }
    });
    if (document.fonts?.ready) assets.push(document.fonts.ready);
    Promise.race([
      Promise.all(assets),
      new Promise((ready) => later(ready, 350)),
    ]).then(() => {
      if (!finished) later(open, Math.max(0, 200 - (performance.now() - started)));
    }, finish);
  });
}

/**
 * The photo travels behind a fixed frame. A short, finite ease-out adds depth;
 * frames stop as soon as the image settles, and offscreen photos do no work.
 */
function initPhotoDepth() {
  const photos = [...document.querySelectorAll('img[data-depth]')];
  if (!photos.length || !('IntersectionObserver' in window)) return;
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const active = new Set();
  const frames = new Map(photos.map((img) => [img.parentElement, img]));
  const profiles = {
    coffee: { strength: 1, smoothing: 125 },
    breakfast: { strength: 0.65, smoothing: 180 },
    pastry: { strength: 1.12, smoothing: 105 },
  };
  const states = new Map(photos.map((img) => [img, {
    current: null, target: 0, travel: 0, bleed: 0,
    ...(profiles[img.dataset.depth] || profiles.coffee),
  }]));
  let observer;
  let frame = 0;
  let enabled = false;
  let dirty = true;
  let previousTime = 0;

  const update = (time = performance.now()) => {
    frame = 0;
    if (!enabled || document.hidden) return;
    const step = previousTime ? Math.min(32, Math.max(1, time - previousTime)) : 16;
    const mobile = window.innerWidth <= 650;
    previousTime = time;
    if (dirty) {
      const viewportHeight = window.innerHeight;
      const maxTravel = mobile ? 22 : 64;
      // Read all visible geometry before writing any image styles.
      const positions = [...active].map((img) => {
        const box = img.parentElement.getBoundingClientRect();
        const progress = Math.max(-1, Math.min(1,
          (viewportHeight / 2 - box.top - box.height / 2) / ((viewportHeight + box.height) / 2)));
        const travel = Math.min(maxTravel, img.parentElement.clientHeight * 0.18) * states.get(img).strength;
        return { img, travel, target: progress * travel };
      });
      positions.forEach(({ img, travel, target }) => {
        const state = states.get(img);
        state.target = target;
        state.travel = travel;
        const bleed = Math.ceil(travel + 3);
        if (state.bleed !== bleed) {
          state.bleed = bleed;
          img.style.setProperty('--depth-bleed', `${bleed}px`);
        }
        img.dataset.depthReady = '';
      });
      dirty = false;
    }

    let moving = false;
    active.forEach((img) => {
      const state = states.get(img);
      const blend = 1 - Math.exp(-step / (state.smoothing * (mobile ? 1.7 : 1)));
      if (state.current === null) state.current = state.target;
      // A fast flick must not turn into a one-frame jump inside the photo.
      const maxStep = step * (mobile ? 0.085 : 0.3);
      const delta = (state.target - state.current) * blend;
      state.current += Math.max(-maxStep, Math.min(maxStep, delta));
      state.current = Math.max(-state.travel, Math.min(state.travel, state.current));
      if (Math.abs(state.target - state.current) <= 0.05) state.current = state.target;
      else moving = true;
      img.style.setProperty('--depth-y', `${state.current.toFixed(2)}px`);
    });
    if (moving) frame = requestAnimationFrame(update);
    else previousTime = 0;
  };
  const queue = () => {
    dirty = true;
    if (enabled && active.size && !frame && !document.hidden) frame = requestAnimationFrame(update);
  };
  const stop = () => {
    enabled = false;
    observer?.disconnect();
    cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
    active.clear();
    window.removeEventListener('scroll', queue);
    window.removeEventListener('resize', queue);
    photos.forEach((img) => {
      img.removeAttribute('data-depth-ready');
      img.removeAttribute('data-depth-active');
      img.style.removeProperty('--depth-y');
      img.style.removeProperty('--depth-bleed');
      Object.assign(states.get(img), { current: null, target: 0, travel: 0, bleed: 0 });
    });
  };
  const start = () => {
    if (enabled || preference.matches) return;
    try {
      observer = new IntersectionObserver((entries) => {
        entries.forEach(({ target, isIntersecting }) => {
          const img = frames.get(target);
          if (isIntersecting) {
            active.add(img);
            img.dataset.depthActive = '';
          } else {
            active.delete(img);
            states.get(img).current = null;
            img.removeAttribute('data-depth-active');
          }
        });
        if (active.size) queue();
        else { cancelAnimationFrame(frame); frame = 0; previousTime = 0; }
      }, { rootMargin: '100px 0px', threshold: 0 });
      enabled = true;
      photos.forEach((img) => observer.observe(img.parentElement));
      window.addEventListener('scroll', queue, { passive: true });
      window.addEventListener('resize', queue, { passive: true });
    } catch { stop(); }
  };
  preference.addEventListener('change', () => { if (preference.matches) stop(); else start(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; previousTime = 0; }
    else queue();
  });
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', (event) => { if (event.persisted) start(); });
  start();
}

/** Keep the decorative CSS rotation paused offscreen, in background tabs or with reduced motion. */
function initSunRotation() {
  const sun = document.querySelector('.hours-note .sun-icon');
  if (!sun || !('IntersectionObserver' in window)) return;
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  let visible = false;
  const sync = () => sun.toggleAttribute('data-sun-spinning', visible && !document.hidden && !preference.matches);
  try {
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      sync();
    });
    observer.observe(sun);
    document.addEventListener('visibilitychange', sync);
    preference.addEventListener('change', sync);
    window.addEventListener('pagehide', () => { observer.disconnect(); visible = false; sync(); });
    window.addEventListener('pageshow', (event) => { if (event.persisted) observer.observe(sun); });
  } catch { sun.removeAttribute('data-sun-spinning'); }
}

/**
 * The tiny head bootstrap arms the CSS before the first paint. Without it (or
 * after its watchdog has expired), we never hide already visible content.
 */
function initReveals() {
  const root = document.documentElement;
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  if (root.dataset.motion !== 'boot' || preference.matches ||
      !('IntersectionObserver' in window)) {
    root.removeAttribute('data-motion');
    return;
  }

  const targets = [...document.querySelectorAll('[data-reveal]')];
  const preparing = new Set();
  const timers = new Map();
  let observer;
  let stopped = false;

  const finish = (element) => {
    clearTimeout(timers.get(element));
    timers.delete(element);
    element.dataset.revealState = 'shown';
    element.style.removeProperty('--reveal-delay');
    observer?.unobserve(element);
  };
  const disable = () => {
    stopped = true;
    observer?.disconnect();
    targets.forEach(finish);
    root.removeAttribute('data-motion');
  };
  const onScreen = (element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.bottom > 0 &&
      box.top < window.innerHeight - 20;
  };
  const showWithin = (container) => {
    if (!container) return;
    targets.forEach((element) => {
      if (container.contains(element) || element.contains(container)) finish(element);
    });
  };
  const showHash = (hash) => {
    try {
      showWithin(document.getElementById(decodeURIComponent(hash.slice(1))));
    } catch { /* A malformed fragment must not affect the page. */ }
  };

  // Decode photos before fading their whole card in, but never block the page.
  const imagesReady = async (element) => {
    const images = [...element.querySelectorAll('img')];
    if (!images.length) return;
    let timeout;
    await Promise.race([
      Promise.all(images.map((img) => {
        try { return img.decode ? img.decode().catch(() => {}) : Promise.resolve(); }
        catch { return Promise.resolve(); }
      })),
      new Promise((resolve) => { timeout = setTimeout(resolve, 700); }),
    ]);
    clearTimeout(timeout);
  };
  const reveal = async (element, delay) => {
    if (preparing.has(element) || element.dataset.revealState) return;
    preparing.add(element);
    try {
      await imagesReady(element);
      if (stopped || element.dataset.revealState) return;
      if (preference.matches || document.hidden || element.contains(document.activeElement)) {
        finish(element);
        return;
      }
      // If the user has already scrolled past it, wait for a real next entry.
      if (!onScreen(element)) return;
      observer.unobserve(element);
      element.style.setProperty('--reveal-delay', `${delay}ms`);
      element.dataset.revealState = 'revealing';
      const duration = element.dataset.reveal === 'visual' ? 800 :
        element.dataset.reveal === 'fade' ? 400 : 640;
      timers.set(element, setTimeout(() => finish(element), duration + delay + 80));
    } catch {
      finish(element);
    } finally {
      preparing.delete(element);
    }
  };

  try {
    observer = new IntersectionObserver((entries) => {
      const groups = new Map();
      // Rhythm applies only to siblings entering together, not an entire page.
      entries.filter((entry) => entry.isIntersecting)
        .sort((a, b) => targets.indexOf(a.target) - targets.indexOf(b.target))
        .forEach(({ target }) => {
          const group = target.closest('[data-reveal-group]') || target;
          const rank = groups.get(group) || 0;
          groups.set(group, rank + 1);
          void reveal(target, Math.min(rank * 70, 180));
        });
    }, { threshold: 0.08, rootMargin: '0px 0px -20px 0px' });

    // Two frames preserve the hidden first paint even with a warm browser cache.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (root.dataset.motion !== 'boot' || stopped) {
        disable();
        return;
      }
      root.dataset.motion = 'ready';
      if (window.scrollY > 0) {
        targets.filter((element) => element.getBoundingClientRect().top < window.innerHeight)
          .forEach(finish);
      }
      if (location.hash) showHash(location.hash);
      targets.forEach((element) => {
        if (!element.dataset.revealState) observer.observe(element);
      });
    }));

    document.addEventListener('focusin', (event) => showWithin(event.target));
    document.addEventListener('pointerdown', (event) => showWithin(event.target), { passive: true });
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a[href]');
      if (!link) return;
      const url = new URL(link.href, location.href);
      if (url.origin === location.origin && url.pathname === location.pathname && url.hash) {
        showHash(url.hash);
      }
    });
    window.addEventListener('hashchange', () => showHash(location.hash));
    window.addEventListener('pageshow', (event) => { if (event.persisted) disable(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) targets.filter((element) => element.dataset.revealState === 'revealing')
        .forEach(finish);
    });
    preference.addEventListener('change', (event) => { if (event.matches) disable(); });
  } catch {
    disable();
  }
}

initIntro().then(initReveals);
initPhotoDepth();
initSunRotation();
