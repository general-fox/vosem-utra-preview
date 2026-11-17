const workshop = document.querySelector('.workshop-section');

// Decorative movement runs only while the invitation is visible and motion is allowed.
if (workshop && 'IntersectionObserver' in window) {
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  let visible = false;
  const sync = () => {
    if (visible && !document.hidden) workshop.setAttribute('data-workshop-entered', '');
    workshop.toggleAttribute('data-workshop-active', visible && !document.hidden && !preference.matches);
  };
  try {
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      sync();
    }, { threshold: 0.05 });
    const artwork = workshop.querySelector('.workshop-art') || workshop;
    observer.observe(artwork);
    workshop.setAttribute('data-workshop-ready', '');
    preference.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('pagehide', () => { observer.disconnect(); visible = false; sync(); });
    window.addEventListener('pageshow', (event) => { if (event.persisted) observer.observe(artwork); });
    sync();
  } catch {
    workshop.removeAttribute('data-workshop-active');
    workshop.removeAttribute('data-workshop-ready');
  }
}
