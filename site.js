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

initReveals();
