import test from 'node:test';
import assert from 'node:assert/strict';
import { initWinterScenes } from '../winter.js';

class Events {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener(event); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

function element() {
  return {
    attributes: new Map(),
    children: [],
    style: { values: new Map(), setProperty(name, value) { this.values.set(name, value); } },
    setAttribute(name, value) { this.attributes.set(name, value); },
    toggleAttribute(name, enabled) { if (enabled) this.attributes.set(name, ''); else this.attributes.delete(name); },
    querySelector(selector) {
      if (selector === '.winter-flake') return this.children.find(child => child.className?.includes('winter-flake'));
      return null;
    },
    appendChild(child) { this.children.push(child); child.parent = this; },
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); },
  };
}

function harness({ reduced = false, noObserver = false, brokenObserver = false } = {}) {
  const view = new Events();
  const preference = Object.assign(new Events(), { matches: reduced });
  view.matchMedia = () => preference;
  const snow = element();
  const hero = element();
  hero.querySelector = selector => selector === '[data-winter-snow]' ? snow : null;
  const secondary = element();
  const scenes = [hero, secondary];
  const documentRoot = Object.assign(new Events(), {
    hidden: false, defaultView: view,
    querySelectorAll: () => scenes,
    createElement: () => element(),
  });
  const observers = [];
  if (!noObserver) view.IntersectionObserver = class {
    targets = new Set();
    constructor(callback) {
      if (brokenObserver) throw new Error('Observer unavailable');
      this.callback = callback;
      observers.push(this);
    }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
    enter(target, isIntersecting = true) { this.callback([{ target, isIntersecting }]); }
  };
  const cleanup = initWinterScenes(documentRoot, view);
  const active = target => target.attributes.has('data-winter-active');
  return { view, preference, documentRoot, hero, secondary, snow, observers, cleanup, active };
}

test('winter decorations run only for visible scenes with motion allowed', () => {
  const h = harness();
  const observer = h.observers[0];
  assert.equal(h.active(h.hero), false);
  observer.enter(h.hero);
  assert.equal(h.active(h.hero), true);
  assert.equal(h.active(h.secondary), false);
  observer.enter(h.secondary);
  observer.enter(h.hero, false);
  assert.equal(h.active(h.hero), false);
  assert.equal(h.active(h.secondary), true);

  h.documentRoot.hidden = true;
  h.documentRoot.emit('visibilitychange');
  assert.equal(h.active(h.secondary), false);
  h.documentRoot.hidden = false;
  h.documentRoot.emit('visibilitychange');
  assert.equal(h.active(h.secondary), true);
  h.preference.matches = true;
  h.preference.emit('change');
  assert.equal(h.active(h.secondary), false);
  h.preference.matches = false;
  h.preference.emit('change');
  assert.equal(h.active(h.secondary), true);
  h.cleanup();
});

test('snow stays bounded and reinitialization cannot duplicate particles or listeners', () => {
  const h = harness({ reduced: true });
  assert.equal(h.snow.children.length, 28);
  assert.equal(h.snow.attributes.get('aria-hidden'), 'true');
  assert.equal(h.snow.children.filter(flake => flake.className.includes('--crystal')).length, 7);
  h.observers[0].enter(h.hero);
  assert.equal(h.active(h.hero), false);
  assert.equal(initWinterScenes(h.documentRoot, h.view), h.cleanup);
  assert.equal(h.snow.children.length, 28);
  assert.equal(h.observers.length, 1);

  h.cleanup();
  h.cleanup();
  assert.equal(h.snow.children.length, 0);
  assert.equal(h.view.listenerCount(), 0);
  assert.equal(h.documentRoot.listenerCount(), 0);
  assert.equal(h.preference.listenerCount(), 0);
  assert.equal(h.observers[0].targets.size, 0);
  const cleanupAgain = initWinterScenes(h.documentRoot, h.view);
  assert.equal(h.snow.children.length, 28);
  cleanupAgain();
});

test('history restoration waits for fresh visibility and ignores queued background callbacks', () => {
  const h = harness();
  const observer = h.observers[0];
  observer.enter(h.hero);
  h.view.emit('pagehide', { persisted: true });
  assert.equal(h.active(h.hero), false);
  assert.equal(observer.targets.size, 0);
  observer.enter(h.hero);
  assert.equal(h.active(h.hero), false);
  h.view.emit('pageshow', { persisted: true });
  assert.equal(observer.targets.size, 2);
  assert.equal(h.active(h.hero), false);
  observer.enter(h.secondary);
  assert.equal(h.active(h.secondary), true);
  h.cleanup();
  observer.enter(h.hero);
  h.view.emit('pageshow', { persisted: true });
  assert.equal(h.active(h.hero), false);
  assert.equal(observer.targets.size, 0);
});

test('missing observer leaves a static scene, and failed setup leaves no listeners behind', () => {
  for (const options of [{ noObserver: true }, { brokenObserver: true }]) {
    const h = harness(options);
    assert.equal(h.active(h.hero), false);
    assert.equal(h.active(h.secondary), false);
    assert.equal(h.view.listenerCount(), 0);
    assert.equal(h.documentRoot.listenerCount(), 0);
    h.cleanup();
  }
  assert.doesNotThrow(() => initWinterScenes(undefined, undefined)());
});
