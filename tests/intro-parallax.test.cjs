const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path').resolve(__dirname, '..');
const script = fs.readFileSync(path + '/site.js', 'utf8');
const html = fs.readFileSync(path + '/index.html', 'utf8');
const clubHtml = fs.readFileSync(path + '/registration.html', 'utf8');
const css = fs.readFileSync(path + '/style.css', 'utf8');
const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const clubBootstrap = clubHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
const controllers = script.slice(script.indexOf('function initIntro()'), script.indexOf('function initReveals()'));

function events(target = {}) {
  const listeners = new Map();
  return Object.assign(target, {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    emit(type, event = {}) { [...(listeners.get(type) || [])].forEach(callback => callback(event)); },
    count(type) { return listeners.get(type)?.size || 0; },
  });
}
function attributes(target = {}) {
  target.dataset = {};
  target.removeAttribute = name => {
    delete target.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
  };
  return target;
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function harness(options = {}) {
  let now = 0, nextId = 0;
  const timers = new Map(), frames = new Map(), observers = [];
  const root = attributes();
  if (options.club) root.dataset.introEntry = 'club';
  const sun = attributes({ toggleAttribute(name, present) {
    if (present) this.dataset.sunSpinning = '';
    else this.removeAttribute(name);
  } });
  const preference = events({ matches: !!options.reduce });
  const animations = [];
  const sheet = { animate: options.noAnimate ? undefined : (keyframes, timing) => {
    if (options.animateThrows) throw new Error('Animation unavailable');
    let complete, reject;
    const animation = { keyframes, timing,
      finished: new Promise((resolve, fail) => { complete = resolve; reject = fail; }),
      complete: () => complete(),
      fail: () => reject(new Error('Animation cancelled')),
      cancel() {
        this.cancelled = true;
        this.hiddenAtCancel = root.dataset.intro === undefined;
        reject(new Error('Animation cancelled'));
      },
    };
    animations.push(animation);
    return animation;
  } };
  const photos = [0, 1, 2].map(index => {
    const values = new Map();
    const parentElement = { top: 100 + index * 1000, height: 400,
      get clientHeight() { return this.height; },
      getBoundingClientRect() { return { top: this.top, height: this.height }; } };
    return attributes({ parentElement, style: {
      setProperty: (name, value) => values.set(name, value),
      removeProperty: name => values.delete(name),
      get: name => values.get(name),
    }, decode: () => options.slowAssets ? new Promise(() => {}) :
      options.brokenAssets ? Promise.reject(new Error('Missing photo')) : Promise.resolve() });
  });
  const document = events({ documentElement: root, hidden: !!options.hidden,
    referrer: options.referrer || '', fonts: { ready: Promise.resolve() },
    querySelector: selector => selector === '.intro-sheet' ? (options.noSheet ? null : sheet) : (options.noSun ? null : sun),
    querySelectorAll: selector => selector === 'img[data-depth]' ? photos : photos.slice(0, 1),
  });
  class Observer {
    constructor(callback) {
      if (options.observerThrows) throw new Error('Observer unavailable');
      this.callback = callback; this.observed = new Set(); observers.push(this);
    }
    observe(element) { this.observed.add(element); }
    disconnect() { this.observed.clear(); }
    enter(img, visible = true) { this.callback([{ target: img.parentElement, isIntersecting: visible }]); }
  }
  const window = events({ innerHeight: 800, innerWidth: options.mobile ? 390 : 1280, scrollY: options.scrollY || 0 });
  if (!options.noObserver) window.IntersectionObserver = Observer;
  const location = new URL('https://vosem-utra.ru/' + (options.club ? 'registration.html' : 'index.html') + (options.hash || ''));
  const context = vm.createContext({ document, window, location, URL, IntersectionObserver: Observer,
    matchMedia: () => preference,
    performance: { now: () => now, getEntriesByType: () => [{ type: options.navigation || 'navigate' }] },
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame(callback) { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  vm.runInContext(options.club ? clubBootstrap : bootstrap, context);
  vm.runInContext(controllers, context);
  return { root, sun, photos, document, window, preference, observers, frames, timers, animations,
    intro: () => vm.runInContext('initIntro()', context),
    depth: () => vm.runInContext('initPhotoDepth()', context),
    rotateSun: () => vm.runInContext('initSunRotation()', context),
    paint() { now += 16; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(cb => cb(now)); },
    settle() { let count = 0; while (frames.size && count++ < 240) this.paint(); assert.equal(frames.size, 0, 'Finite ease-out reaches rest'); },
    async tick(ms) {
      await flush();
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
      }
      now = end; await flush();
    },
  };
}

(async () => {
  let h = harness();
  assert.equal(h.root.dataset.intro, 'waiting', 'Direct homepage visit is armed before paint');
  let revealed = false;
  let ready;
  h.intro().then(() => { revealed = true; });
  await h.tick(199); assert.equal(revealed, false);
  await h.tick(1); assert.equal(h.root.dataset.intro, 'leaving'); assert.equal(revealed, true);
  assert.equal(h.animations.length, 1);
  const lift = h.animations[0];
  assert.deepEqual(JSON.parse(JSON.stringify(lift.keyframes)), [
    { transform: 'translate3d(0,0,0)' }, { transform: 'translate3d(0,-101%,0)' },
  ], 'Only the pre-painted sheet transform is animated; final frame fully clears it');
  assert.deepEqual(JSON.parse(JSON.stringify(lift.timing)), {
    duration: 1100, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards',
  });
  assert.equal(h.frames.size, 0, 'Native intro needs no JavaScript frame loop');
  await h.tick(500); assert.equal(h.root.dataset.intro, 'leaving');
  lift.complete(); await flush();
  assert.equal(h.root.dataset.intro, undefined, 'Native completion dismisses the sheet without a blur phase');
  assert.ok(lift.cancelled && lift.hiddenAtCancel, 'Hide before cancelling so the first frame cannot flash');
  assert.equal(h.document.count('wheel'), 0, 'Intro input listeners are removed');
  assert.equal(h.preference.count('change'), 0);

  for (const option of [{ noSheet: true }, { noAnimate: true }, { animateThrows: true }]) {
    h = harness(option); h.intro(); await h.tick(350);
    assert.equal(h.root.dataset.intro, undefined, 'Unavailable animation fails open');
    assert.equal(h.document.count('touchstart'), 0);
  }
  h = harness(); h.intro(); await h.tick(200); h.animations[0].fail(); await flush();
  assert.equal(h.root.dataset.intro, undefined, 'Interrupted native animation fails open');
  assert.equal(h.preference.count('change'), 0);

  for (const option of [{ slowAssets: true }, { brokenAssets: true }]) {
    h = harness(option); h.intro(); await h.tick(1800);
    assert.equal(h.root.dataset.intro, undefined, 'Broken/slow assets cannot leave a curtain');
  }
  h = harness(); await h.tick(2300);
  assert.equal(h.root.dataset.intro, undefined, 'Independent watchdog handles a missing module');
  assert.equal(h.root.dataset.motion, undefined);
  await h.intro(); assert.equal(h.root.dataset.intro, undefined, 'Late module cannot re-arm intro');

  for (const option of [{ hash: '#about' }, { navigation: 'back_forward' }, { reduce: true },
    { noObserver: true }, { hidden: true }, { scrollY: 300 },
    { referrer: 'https://vosem-utra.ru/privacy.html' }]) {
    h = harness(option); assert.equal(h.root.dataset.intro, undefined, JSON.stringify(option));
    await h.intro();
  }
  h = harness({ navigation: 'reload', referrer: 'https://vosem-utra.ru/index.html' });
  assert.equal(h.root.dataset.intro, 'waiting', 'Explicit reload can replay the intro');
  for (const option of [{}, { referrer: 'https://vosem-utra.ru/index.html' }, { mobile: true }]) {
    h = harness({ club: true, ...option });
    assert.equal(h.root.dataset.intro, 'waiting', 'Club entry also shows the curtain from internal navigation');
    h.intro(); await h.tick(1800); assert.equal(h.root.dataset.intro, undefined);
  }
  for (const option of [{ navigation: 'back_forward' }, { hash: '#registration-title' },
    { scrollY: 300 }, { reduce: true }, { hidden: true }]) {
    h = harness({ club: true, ...option });
    assert.equal(h.root.dataset.intro, undefined, 'Club form history, focus routes and accessibility skip the intro');
  }
  for (const type of ['keydown', 'focusin']) {
    h = harness(); const ready = h.intro(); h.document.emit(type); await ready;
    assert.equal(h.root.dataset.intro, undefined, type + ' immediately dismisses the curtain');
    await h.tick(2300); assert.equal(h.root.dataset.intro, undefined, 'No delayed replay');
  }
  h = harness(); ready = h.intro();
  h.document.emit('pointerdown', { target: { closest: () => ({}) } });
  await ready; assert.equal(h.root.dataset.intro, undefined, 'Actual links and fields stay immediately usable');
  for (const type of ['pointerdown', 'touchstart', 'wheel']) {
    h = harness({ mobile: true }); h.intro(); h.document.emit(type);
    assert.equal(h.root.dataset.intro, 'leaving', type + ' starts a gentle lift instead of abruptly removing it');
    h.window.scrollY = 80;
    await h.tick(300); h.document.emit(type);
    assert.equal(h.root.dataset.intro, 'leaving', 'Repeated touches and delayed asset callbacks cannot cut the animation short');
    assert.equal(h.animations.length, 1, 'Repeated input never restarts the native animation');
    await h.tick(949); assert.equal(h.root.dataset.intro, 'leaving');
    await h.tick(1); assert.equal(h.root.dataset.intro, undefined, 'Fallback handles a missing native completion event');
    assert.equal(h.document.count(type), 0, 'Gentle input listeners are cleaned up');
  }
  for (const type of ['pagehide', 'hashchange']) {
    h = harness(); const ready = h.intro(); h.window.emit(type); await ready;
    assert.equal(h.root.dataset.intro, undefined);
  }
  h = harness(); ready = h.intro(); h.document.hidden = true; h.document.emit('visibilitychange');
  await ready; assert.equal(h.root.dataset.intro, undefined);
  h = harness(); ready = h.intro(); h.preference.matches = true; h.preference.emit('change', { matches: true });
  await ready; assert.equal(h.root.dataset.intro, undefined);

  h = harness(); h.depth(); let observer = h.observers[0];
  assert.equal(observer.observed.size, 3);
  assert.equal(h.frames.size, 0, 'No perpetual animation loop');
  observer.enter(h.photos[0]); h.paint();
  const first = parseFloat(h.photos[0].style.get('--depth-y'));
  assert.equal(h.photos[1].style.get('--depth-y'), undefined, 'Offscreen images are not updated');
  h.photos[0].parentElement.top = -200;
  for (let i = 0; i < 10; i++) h.window.emit('scroll');
  assert.equal(h.frames.size, 1, 'Multiple scroll events share one frame');
  h.paint(); assert.ok(parseFloat(h.photos[0].style.get('--depth-y')) > first, 'Image lags behind page scroll');
  assert.equal(h.frames.size, 1, 'A short ease-out continues after the scroll');
  h.settle();
  assert.ok(parseFloat(h.photos[0].style.get('--depth-y')) - first >= 30, 'Depth is visibly stronger than the original 9px travel');
  for (const top of [-10000, 10000]) {
    h.photos[0].parentElement.top = top; h.window.emit('scroll'); h.settle();
    assert.ok(Math.abs(parseFloat(h.photos[0].style.get('--depth-y'))) <= 72, 'Offset cannot exceed overscan');
    assert.ok(parseFloat(h.photos[0].style.get('--depth-bleed')) > Math.abs(parseFloat(h.photos[0].style.get('--depth-y'))), 'Extra image height covers both extremes');
  }
  h.photos[0].parentElement.height = 120;
  h.window.emit('resize'); h.paint();
  assert.ok(Math.abs(parseFloat(h.photos[0].style.get('--depth-y'))) <= 21.6, 'A smaller frame immediately clamps inertial travel');
  h.settle();
  observer.enter(h.photos[0], false); h.window.emit('scroll');
  assert.equal(h.frames.size, 0, 'Scrolling with no visible images does no work');
  observer.enter(h.photos[0]); h.document.hidden = true; h.document.emit('visibilitychange');
  assert.equal(h.frames.size, 0, 'Background tab cancels pending work');
  h.document.hidden = false; h.document.emit('visibilitychange'); assert.equal(h.frames.size, 1); h.paint();
  h.preference.matches = true; h.preference.emit('change', { matches: true });
  assert.equal(h.window.count('scroll'), 0);
  assert.equal(h.photos[0].dataset.depthReady, undefined);
  assert.equal(h.photos[0].style.get('--depth-y'), undefined);
  h.preference.matches = false; h.preference.emit('change', { matches: false });
  assert.equal(h.window.count('scroll'), 1, 'Preference can be toggled without duplicate listeners');
  h.window.emit('pagehide'); assert.equal(h.window.count('scroll'), 0);
  h.window.emit('pageshow', { persisted: true }); assert.equal(h.window.count('scroll'), 1, 'BFCache restores parallax');
  for (const option of [{ reduce: true }, { noObserver: true }, { observerThrows: true }]) {
    h = harness(option); h.depth();
    assert.equal(h.photos[0].dataset.depthReady, undefined);
    assert.equal(h.window.count('scroll'), 0);
  }
  h = harness({ mobile: true }); h.depth(); h.photos[0].parentElement.top = -10000;
  h.observers[0].enter(h.photos[0]); h.paint();
  assert.equal(h.photos[0].style.get('--depth-y'), '22.00px', 'Mobile depth has a subtle 22px range');
  h.photos[0].parentElement.top = 10000; h.window.emit('scroll'); h.paint();
  assert.ok(22 - parseFloat(h.photos[0].style.get('--depth-y')) <= 1.37, 'A full-range mobile flick moves at most 1.36px per 16ms frame');
  h.settle();
  assert.equal(h.photos[0].style.get('--depth-y'), '-22.00px');

  h = harness();
  ['coffee', 'breakfast', 'pastry'].forEach((profile, index) => {
    h.photos[index].dataset.depth = profile;
    h.photos[index].parentElement.top = 100;
  });
  h.depth(); h.photos.forEach(img => h.observers[0].enter(img)); h.paint();
  const before = h.photos.map(img => parseFloat(img.style.get('--depth-y')));
  h.photos.forEach(img => { img.parentElement.top = -200; }); h.window.emit('scroll'); h.paint();
  const firstStep = h.photos.map((img, index) => parseFloat(img.style.get('--depth-y')) - before[index]);
  assert.ok(firstStep[1] < firstStep[0] && firstStep[0] < firstStep[2], 'Cards react with different speeds and easing');
  h.settle();
  const travel = h.photos.map((img, index) => parseFloat(img.style.get('--depth-y')) - before[index]);
  assert.ok(travel[1] < travel[0] * 0.7 && travel[2] > travel[0] * 1.1, 'Cards retain different movement ranges after settling');

  h = harness();
  ['breakfast', 'pastry'].forEach((profile, index) => {
    h.photos[index].dataset.depth = profile;
    h.photos[index].dataset.depthFraming = 'full';
    h.photos[index].parentElement.top = -10000;
  });
  h.depth(); h.photos.slice(0, 2).forEach(img => h.observers[0].enter(img)); h.paint();
  assert.equal(h.photos[0].style.get('--depth-y'), '7.80px', 'Full breakfast keeps a small scroll range');
  assert.equal(h.photos[1].style.get('--depth-y'), '13.44px', 'Full syrniki retain distinct but gentle motion');

  h = harness(); h.rotateSun();
  assert.equal(h.sun.dataset.sunSpinning, undefined, 'Decorative rotation is initially paused');
  h.observers[0].callback([{ target: h.sun, isIntersecting: true }]);
  assert.equal(h.sun.dataset.sunSpinning, '');
  h.document.hidden = true; h.document.emit('visibilitychange'); assert.equal(h.sun.dataset.sunSpinning, undefined);
  h.document.hidden = false; h.document.emit('visibilitychange'); assert.equal(h.sun.dataset.sunSpinning, '');
  h.preference.matches = true; h.preference.emit('change'); assert.equal(h.sun.dataset.sunSpinning, undefined);
  h.preference.matches = false; h.preference.emit('change'); assert.equal(h.sun.dataset.sunSpinning, '');
  h.observers[0].callback([{ target: h.sun, isIntersecting: false }]); assert.equal(h.sun.dataset.sunSpinning, undefined);
  h.window.emit('pagehide'); assert.equal(h.observers[0].observed.size, 0);
  h.window.emit('pageshow', { persisted: true }); assert.ok(h.observers[0].observed.has(h.sun));
  assert.equal(h.frames.size, 0, 'CSS rotation needs no JavaScript frame loop');
  for (const option of [{ noSun: true }, { noObserver: true }, { observerThrows: true }, { reduce: true }]) {
    h = harness(option); h.rotateSun(); assert.equal(h.sun.dataset.sunSpinning, undefined);
  }

  const depthImages = [...html.matchAll(/<img data-depth="([^"]+)"[^>]*>/g)];
  assert.equal(depthImages.length, 3, 'Only the three menu cards use depth');
  assert.deepEqual(depthImages.map(match => match[1]), ['coffee', 'breakfast', 'pastry']);
  assert.doesNotMatch(depthImages.map(match => match[0]).join(''), /hero-photo|cafe-friends|cafe-barista|cafe-sign/);
  assert.match(css, /hours-sun-turn 36s linear infinite/);
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.hours-note \.sun-icon\{animation:none!important/);
  assert.match(html, /class="intro-curtain" aria-hidden="true"/);
  assert.equal(clubBootstrap, bootstrap, 'Both pages share the same pre-paint and fail-open logic');
  assert.equal(clubHtml.match(/<style>[\s\S]*?<\/style>/)[0], html.match(/<style>[\s\S]*?<\/style>/)[0]);
  assert.equal(clubHtml.match(/<body>\n([\s\S]*?)(?=  <a class="skip-link")/)[1], html.match(/<body>\n([\s\S]*?)(?=  <a class="skip-link")/)[1], 'Curtain artwork stays consistent between home and club');
  assert.match(clubHtml, /data-intro-entry="club"/);
  assert.match(clubHtml, /data-preview="true"/);
  assert.match(clubHtml, /id="submit-button"[^>]*disabled/);
  assert.doesNotMatch(css + html + clubHtml, /intro-clip|intro-defs|intro-veil|data-intro=settling|>✳<|>☀</);
  assert.match(html, /class="intro-surface" viewBox="0 0 1 1"/);
  const criticalStyle = html.match(/<style>[\s\S]*?<\/style>/)[0];
  assert.doesNotMatch(criticalStyle, /blur|filter|clip-path/);
  assert.match(criticalStyle, /height:100vh;height:100lvh/, 'Stable height avoids Safari address-bar resizing during the lift');
  const curves = ['desktop', 'mobile'].map(device => {
    const d = html.match(new RegExp(`class="intro-edge-${device}" d="([^"]+)"`))[1];
    const values = d.match(/-?\d*\.?\d+/g).map(Number);
    const scale = Number(criticalStyle.match(new RegExp(device === 'desktop' ? 'height:(114)%' : 'height:(106)%'))[1]) / 100;
    const centre = values[3] * 0.25 + values[5] * 0.75;
    assert.ok(scale * centre > 1, device + ' curved hem fully covers the initial viewport');
    return 1 - centre;
  });
  assert.ok(curves[1] > 0 && curves[1] < curves[0] * 0.4, 'Mobile keeps a gentle, much shallower arc');
  const introSource = script.slice(script.indexOf('function initIntro()'), script.indexOf('function initPhotoDepth()'));
  assert.doesNotMatch(introSource, /requestAnimationFrame|setAttribute|curtainPath/, 'No per-frame SVG redraws');
  assert.match(introSource, /sheet\.animate\(/);
  assert.equal((html.match(/class="brand-mark"/g) || []).length, 7, 'All home-page sun/star symbols are SVG');
  assert.equal((clubHtml.match(/class="brand-mark"/g) || []).length, 1, 'Club symbol is also SVG');
  assert.match(css, /prefers-reduced-motion:reduce\)\{img\[data-depth-ready\]/);
  assert.doesNotMatch(script + bootstrap, /sessionStorage|localStorage|document\.cookie/);
  console.log('PASS: native transform-only curtain, static mobile curve, no blur, native completion/fallbacks, intro timing, asset failures, missing/late JS, direct links, history, keyboard/touch skip, reduced motion, depth bounds and finite inertia, mobile, idle/background work and listener cleanup.');
})().catch(error => { console.error(error); process.exitCode = 1; });
