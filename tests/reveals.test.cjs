const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path').resolve(__dirname, '..') + '/';
const script = fs.readFileSync(path + 'site.js', 'utf8');
const controller = script.slice(script.indexOf('function initReveals()'), script.lastIndexOf('\ninitIntro().then')) + '\ninitReveals();';
const bootstrap = fs.readFileSync(path + 'index.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

function harness(options = {}) {
  const listeners = {}, frames = [], timers = new Map(), observed = new Set();
  let timerId = 0, observerCallback;
  const preference = { matches: !!options.reduce, addEventListener: (name, callback) => { listeners.motion = callback; } };
  const root = { dataset: {}, removeAttribute: name => { delete root.dataset[name.replace('data-', '')]; } };
  const group = { contains: element => elements.includes(element) };
  const elements = ['text', 'visual', 'text'].map((kind, index) => ({
    dataset: { reveal: kind },
    top: index === 2 ? 1200 : 100,
    style: { values: new Map(), setProperty(name, value) { this.values.set(name, value); }, removeProperty(name) { this.values.delete(name); } },
    closest: () => group,
    contains(element) { return element === this || element?.parent === this; },
    querySelectorAll: () => index === 1 && options.image ? [options.image] : [],
    getBoundingClientRect() { return { top: this.top, bottom: this.top + 200, width: 300, height: 200 }; },
  }));
  class Observer {
    constructor(callback) { if (options.observerThrows) throw new Error('observer failed'); observerCallback = callback; }
    observe(element) { observed.add(element); }
    unobserve(element) { observed.delete(element); }
    disconnect() { observed.clear(); }
  }
  const location = new URL('http://127.0.0.1:5173/index.html' + (options.hash || ''));
  const document = { documentElement: root, hidden: false, activeElement: null,
    querySelectorAll: () => elements, getElementById: () => group,
    addEventListener: (name, callback) => { listeners[name] = callback; } };
  const window = { innerHeight: 800, scrollY: options.scrollY || 0,
    addEventListener: (name, callback) => { listeners[name] = callback; } };
  if (!options.noObserver) window.IntersectionObserver = Observer;
  const context = vm.createContext({ document, window, location, URL, IntersectionObserver: Observer,
    matchMedia: () => preference,
    performance: { getEntriesByType: () => [{ type: options.backForward ? 'back_forward' : 'navigate' }] },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id), requestAnimationFrame: callback => frames.push(callback),
  });
  vm.runInContext(bootstrap, context);
  const boot = root.dataset.motion;
  if (options.expireBoot) [...timers.values()].forEach(timer => timer.callback());
  vm.runInContext(controller, context);
  while (frames.length) frames.shift()();
  return { root, elements, observed, listeners, timers, preference, document, boot,
    enter: (...targets) => observerCallback(targets.map(target => ({ target, isIntersecting: true }))),
  };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

(async () => {
  let h = harness();
  assert.equal(h.boot, 'boot', 'Hidden initial state armed before the module');
  assert.equal(h.root.dataset.motion, 'ready');
  assert.equal(h.observed.size, 3);
  h.enter(h.elements[0], h.elements[1]); await flush();
  assert.equal(h.elements[0].dataset.revealState, 'revealing');
  assert.equal(h.elements[1].style.values.get('--reveal-delay'), '70ms');
  assert.equal(h.elements[2].dataset.revealState, undefined, 'Offscreen content waits');
  assert.equal(h.observed.size, 1, 'Revealed elements are unobserved once');
  for (const [id, timer] of [...h.timers]) { h.timers.delete(id); timer.callback(); }
  assert.equal(h.elements[0].dataset.revealState, 'shown');
  h.enter(h.elements[0]); await flush();
  assert.equal(h.elements[0].dataset.revealState, 'shown', 'No replay');
  h.elements[2].top = 100; h.enter(h.elements[2]); await flush();
  assert.equal(h.elements[2].style.values.get('--reveal-delay'), '0ms', 'Single mobile entry has no stale stagger');

  h = harness(); h.listeners.focusin({ target: { parent: h.elements[2], contains: () => false } });
  assert.equal(h.elements[2].dataset.revealState, 'shown', 'Keyboard focus is immediate');
  h = harness(); h.listeners.pointerdown({ target: { parent: h.elements[0], contains: () => false } });
  assert.equal(h.elements[0].dataset.revealState, 'shown');

  h = harness(); h.preference.matches = true; h.listeners.motion({ matches: true });
  assert.equal(h.root.dataset.motion, undefined); assert.equal(h.observed.size, 0);
  for (const option of [{ reduce: true }, { noObserver: true }, { expireBoot: true }, { observerThrows: true }, { backForward: true }]) {
    h = harness(option); assert.equal(h.root.dataset.motion, undefined, JSON.stringify(option));
  }
  h = harness({ hash: '#club' }); assert.equal(h.observed.size, 0, 'Deep link reveals target immediately');
  h = harness({ scrollY: 500 }); assert.equal(h.elements[0].dataset.revealState, 'shown');
  h = harness(); h.listeners.pageshow({ persisted: true }); assert.equal(h.root.dataset.motion, undefined);

  h = harness({ image: { decode: () => Promise.reject(new Error('broken photo')) } });
  h.enter(h.elements[1]); await flush(); assert.equal(h.elements[1].dataset.revealState, 'revealing');
  h = harness({ image: { decode: () => new Promise(() => {}) } });
  h.enter(h.elements[1]); await flush(); assert.equal(h.elements[1].dataset.revealState, undefined);
  [...h.timers.values()].filter(timer => timer.delay === 700).forEach(timer => timer.callback());
  await flush(); assert.equal(h.elements[1].dataset.revealState, 'revealing', 'Slow photos cannot block forever');

  h = harness({ image: { decode: () => new Promise(() => {}) } });
  h.enter(h.elements[1]); h.elements[1].top = 1500;
  [...h.timers.values()].filter(timer => timer.delay === 700).forEach(timer => timer.callback());
  await flush(); assert.equal(h.elements[1].dataset.revealState, undefined, 'Do not animate after scrolling away');
  assert.equal(h.observed.has(h.elements[1]), true);
  console.log('PASS: pre-paint bootstrap, once-only entry, rhythm, focus, pointer, reduced motion, fail-open watchdog, deep links, history, restored scroll, broken/slow images, fast-scroll exit.');
})().catch(error => { console.error(error); process.exitCode = 1; });
