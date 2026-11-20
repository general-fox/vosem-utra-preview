const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path').resolve(__dirname, '..') + '/';
const script = fs.readFileSync(path + 'site.js', 'utf8');
const controller = script.slice(script.indexOf('function initReveals()'), script.lastIndexOf('\ninitIntro().then')) + '\ninitReveals();';
const bootstrap = fs.readFileSync(path + 'index.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

function harness(options = {}) {
  const listeners = {}, frames = [], timers = new Map(), observed = new Set();
  let timerId = 0, observerCallback, mutationCallback;
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
  const menuGrid = {};
  class Mutations {
    constructor(callback) { mutationCallback = callback; }
    observe(target, config) { assert.equal(target, menuGrid); assert.deepEqual(JSON.parse(JSON.stringify(config)), { childList: true }); }
    disconnect() { mutationCallback = undefined; }
  }
  const location = new URL('http://127.0.0.1:5173/index.html' + (options.hash || ''));
  const document = { documentElement: root, hidden: false, activeElement: null,
    querySelectorAll: selector => selector.includes('data-dish-grid') ? [menuGrid] : elements.filter(element => element.isConnected !== false), getElementById: () => group,
    addEventListener: (name, callback) => { listeners[name] = callback; } };
  const window = { innerHeight: 800, scrollY: options.scrollY || 0,
    addEventListener: (name, callback) => { listeners[name] = callback; } };
  if (!options.noObserver) window.IntersectionObserver = Observer;
  window.MutationObserver = Mutations;
  const context = vm.createContext({ document, window, location, URL, IntersectionObserver: Observer,
    MutationObserver: Mutations,
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
    replaceMenu: () => mutationCallback?.(),
    frames,
    flushFrames: () => { while (frames.length) frames.shift()(); },
    flushRefresh: () => { for (const [id, timer] of [...timers]) if (timer.delay === 100) { timers.delete(id); timer.callback(); } },
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
  h = harness();
  const dynamic = { ...h.elements[1], dataset: { reveal: 'visual', revealKey: 'dish:toast' }, top: 100, isConnected: true };
  h.elements.push(dynamic); h.listeners['cafe:menu-rendered']();
  assert(h.observed.has(dynamic), 'Async menu cards use the same observer');
  h.enter(dynamic); await flush();
  assert.equal(dynamic.dataset.revealState, 'revealing');
  dynamic.isConnected = false;
  const replacement = { ...dynamic, dataset: { reveal: 'visual', revealKey: 'dish:toast' }, isConnected: true };
  h.elements.splice(h.elements.indexOf(dynamic), 1, replacement);
  h.listeners['cafe:menu-rendered']();
  assert.equal(replacement.dataset.revealState, 'shown', 'Seen dishes do not blink on refresh or filtering');
  assert(!h.observed.has(dynamic), 'Detached cards are unobserved');
  assert(!h.observed.has(replacement), 'Seen replacement does not replay');
  h = harness();
  const missedEventCard = { ...h.elements[1], dataset: { reveal: 'visual', revealKey: 'dish:new' }, top: 100, isConnected: true };
  h.elements.push(missedEventCard); h.replaceMenu(); await flush();
  assert.equal(missedEventCard.dataset.revealState, 'revealing', 'Visible hydration cards appear even when the menu event was missed');
  const laterCard = { ...missedEventCard, dataset: { reveal: 'visual', revealKey: 'dish:later' }, top: 1800 };
  h.elements.push(laterCard); h.replaceMenu(); await flush();
  assert.equal(laterCard.dataset.revealState, undefined, 'Offscreen hydration cards retain scroll reveal');
  assert(h.observed.has(laterCard));
  h.listeners.focusin({ target: { parent: laterCard, contains: () => false } });
  assert.equal(laterCard.dataset.revealState, 'shown', 'Dynamically registered cards are immediately visible on keyboard focus');
  h = harness();
  const missedIntersection = { ...h.elements[1], dataset: { reveal: 'visual', revealKey: 'dish:missed' }, top: 1800, isConnected: true };
  h.elements.push(missedIntersection); h.replaceMenu(); await flush();
  missedIntersection.top = 100;
  h.listeners['cafe:menu-rendered'](); await flush();
  assert.equal(missedIntersection.dataset.revealState, 'revealing', 'A repeated menu render also recovers an already registered card without a fresh intersection');

  h = harness();
  const replacedGridCard = { ...h.elements[1], dataset: { reveal: 'visual', revealKey: 'dish:new-grid' }, top: 1500, isConnected: true };
  h.elements.push(replacedGridCard); // A replacement grid missed both the old grid observer and the menu event.
  replacedGridCard.top = 100;
  h.listeners.scroll(); h.listeners.scroll(); h.listeners.resize();
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 100).length, 1, 'Viewport recovery uses one trailing timer after scrolling settles');
  assert.equal(h.frames.length, 0, 'Normal scrolling does not add a layout-measuring frame loop');
  assert.equal(replacedGridCard.dataset.revealState, undefined, 'Recovery does not measure and reveal cards while scrolling is ongoing');
  h.flushRefresh(); await flush();
  assert.equal(replacedGridCard.dataset.revealState, 'revealing', 'Scrolling to a replacement grid cannot leave visible dishes transparent');
  assert.equal(h.frames.length, 0);

  h = harness();
  const hiddenCard = { ...h.elements[1], dataset: { reveal: 'visual', revealKey: 'dish:hidden-tab' }, top: 100, isConnected: true };
  h.elements.push(hiddenCard); h.document.hidden = true; h.listeners.scroll();
  assert.equal(h.frames.length, 0, 'Hidden tabs do no viewport work');
  h.document.hidden = false; h.listeners.visibilitychange(); h.flushRefresh(); await flush();
  assert.equal(hiddenCard.dataset.revealState, 'revealing', 'Returning to a tab reconciles visible cards even if an observer entry was missed');

  h = harness();
  const clickedCard = { ...h.elements[1], dataset: { reveal: 'visual', revealKey: 'dish:clicked' }, top: 100, isConnected: true };
  h.elements[1].isConnected = false;
  h.elements.push(clickedCard);
  h.listeners.click({ target: { parent: clickedCard, contains: () => false, closest: () => null } });
  assert.equal(clickedCard.dataset.revealState, 'shown', 'Gallery activation discovers and reveals an unregistered replacement card immediately');
  assert(!h.observed.has(h.elements[1]), 'Interaction reconciliation removes stale detached targets');
  console.log('PASS: pre-paint bootstrap, once-only entry, rhythm, focus, pointer, reduced motion, fail-open watchdog, deep links, history, restored scroll, broken/slow images, fast-scroll exit, dynamic menu cards.');
})().catch(error => { console.error(error); process.exitCode = 1; });
