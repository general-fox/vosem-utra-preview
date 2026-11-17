import test from 'node:test';
import assert from 'node:assert/strict';
import { setupMobileCategoryRail } from '../menu-mobile-navigation.js';

class Events {
  listeners = new Map();
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || new Set();
    callbacks.add(callback);
    this.listeners.set(type, callbacks);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type, event = {}) { for (const callback of this.listeners.get(type) || []) callback(event); }
}

function browser({ width = 351, reduced = false } = {}) {
  const view = new Events();
  const motion = Object.assign(new Events(), { matches: reduced });
  view.matchMedia = query => {
    assert.match(query, /prefers-reduced-motion/);
    return motion;
  };
  const frames = new Map();
  let sequence = 0;
  view.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence; };
  view.cancelAnimationFrame = id => frames.delete(id);
  const flush = () => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback();
    }
  };
  const observers = [];
  view.ResizeObserver = class {
    targets = new Set();
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
    emit() { this.callback(); }
  };
  view.getComputedStyle = () => ({ columnGap: '8px' });
  const calls = [];
  const rail = Object.assign(new Events(), {
    clientWidth: width,
    clientLeft: 0,
    scrollLeft: 0,
    getBoundingClientRect() { return { left: 20, width: this.clientWidth }; },
    scrollTo(options) { calls.push(options); this.scrollLeft = options.left; },
    querySelectorAll: () => buttons,
    contains: button => buttons.includes(button),
  });
  const buttons = [104, 138, 130, 168, 152, 186].map((width, index) => ({
    dataset: { menuFilter: 'group-' + index },
    width,
    selected: index === 0,
    getAttribute: name => name === 'aria-pressed' ? String(buttons[index].selected) : null,
    closest() { return this; },
    getBoundingClientRect() {
      const before = buttons.slice(0, buttons.indexOf(this));
      const offset = before.reduce((sum, button) => sum + button.width + 8, 0);
      return { left: 20 + offset - rail.scrollLeft, width: this.width };
    },
  }));
  Object.defineProperty(rail, 'scrollWidth', {
    get: () => Math.max(rail.clientWidth, buttons.reduce((sum, button) => sum + button.width, 0) + (buttons.length - 1) * 8),
  });
  const root = { querySelector: () => rail };
  const cleanup = setupMobileCategoryRail(root, view);
  const select = index => {
    buttons.forEach((button, i) => { button.selected = i === index; });
    view.emit('cafe:menu-rendered');
    flush();
  };
  const assertCentered = index => {
    const rect = buttons[index].getBoundingClientRect();
    assert.ok(Math.abs(rect.left + rect.width / 2 - (20 + rail.clientWidth / 2)) < .01,
      'A middle label reaches the middle of the visible rail');
  };
  const assertAtStart = () => {
    assert.equal(rail.scrollLeft, 0, 'The first group stays at the left without empty space');
    assert.equal(buttons[0].getBoundingClientRect().left, 20);
  };
  const assertAtEnd = () => {
    assert.equal(rail.scrollLeft, rail.scrollWidth - rail.clientWidth, 'The last group stops at the right scroll limit');
    const rect = buttons.at(-1).getBoundingClientRect();
    assert.equal(rect.left + rect.width, 20 + rail.clientWidth);
  };
  return { view, motion, rail, buttons, calls, observers, flush, select, assertCentered, assertAtStart, assertAtEnd, cleanup };
}

test('six natural-width groups centre in the middle and clamp at either edge without empty space', () => {
  const app = browser();
  app.flush();
  app.assertAtStart();
  assert.equal(app.calls.at(-1).behavior, 'auto', 'Initial layout does not animate');
  assert.ok(app.rail.scrollWidth > app.rail.clientWidth);
  app.select(3);
  app.assertCentered(3);
  assert.equal(app.calls.at(-1).behavior, 'smooth');
  app.select(5);
  app.assertAtEnd();
  assert.ok(app.rail.scrollLeft > 0);
  app.select(0);
  app.assertAtStart();
  assert.equal(app.rail.scrollLeft, 0);
});

test('manual swiping survives unchanged renders, resize notifications and ordinary scrolling', () => {
  const app = browser();
  app.flush();
  app.select(2);
  const count = app.calls.length;
  app.rail.scrollLeft = 75;
  app.view.emit('scroll');
  app.rail.emit('scroll');
  app.view.emit('cafe:menu-rendered');
  app.view.emit('resize');
  app.observers[0].emit();
  app.flush();
  assert.equal(app.calls.length, count);
  assert.equal(app.rail.scrollLeft, 75, 'Background menu refresh must not pull the rail back');
  app.select(4);
  app.assertCentered(4);
  assert.equal(app.calls.length, count + 1, 'A real new selection centres again');
});

test('viewport and font-size changes keep the active group within the real scroll limits', () => {
  const app = browser();
  app.flush();
  app.select(5);
  app.rail.clientWidth = 278;
  app.view.emit('resize');
  app.flush();
  app.assertAtEnd();
  assert.equal(app.calls.at(-1).behavior, 'auto');
  app.buttons[0].width = 156;
  app.buttons[5].width = 222;
  app.observers[0].emit();
  app.flush();
  app.assertAtEnd();
  assert.equal(app.observers[0].targets.size, 7, 'All labels are observed for font/layout changes');
});

test('tapping the already selected group recentres it after a manual swipe', () => {
  const app = browser();
  app.flush();
  app.select(2);
  app.rail.scrollLeft = 10;
  const count = app.calls.length;
  app.rail.emit('click', { target: app.buttons[2] });
  app.flush();
  app.assertCentered(2);
  assert.equal(app.calls.length, count + 1);
  assert.equal(app.calls.at(-1).behavior, 'smooth');
  assert.equal(app.buttons[2].selected, true);
});

test('keyboard focus stays on the same button and reduced motion disables smooth centring', () => {
  const app = browser({ reduced: true });
  app.flush();
  app.select(3);
  app.assertCentered(3);
  assert.equal(app.calls.at(-1).behavior, 'auto');
  const focused = app.buttons[5];
  app.rail.emit('focusin', { target: focused });
  app.flush();
  app.assertAtEnd();
  assert.equal(app.calls.at(-1).behavior, 'auto');
  assert.equal(app.buttons[3].selected, true, 'Focusing a button alone does not change the menu filter');
  assert.equal(app.buttons[5].selected, false);
  assert.equal(app.buttons[5], focused, 'No DOM replacement or forced focus is used');
});

test('an overflowing wide rail centres selected groups and preserves a manual swipe', () => {
  const app = browser({ width: 700 });
  app.flush();
  app.assertAtStart();
  app.select(3);
  app.assertCentered(3);
  assert.equal(app.calls.at(-1).behavior, 'smooth');
  app.select(5);
  app.assertAtEnd();
  const count = app.calls.length;
  app.rail.scrollLeft = 50;
  app.view.emit('cafe:menu-rendered');
  app.flush();
  assert.equal(app.calls.length, count);
  assert.equal(app.rail.scrollLeft, 50);
});

test('a fitting wide rail does not scroll, but responds when available width becomes too small', () => {
  const app = browser({ width: 1200 });
  app.flush();
  assert.equal(app.calls.length, 0);
  app.select(3);
  app.rail.emit('focusin', { target: app.buttons[5] });
  app.flush();
  assert.equal(app.calls.length, 0, 'Fitting labels need no selection or focus scrolling');
  app.rail.clientWidth = 660;
  app.view.emit('resize');
  app.flush();
  app.assertCentered(3);
  assert.equal(app.calls.at(-1).behavior, 'auto');
  const count = app.calls.length;
  app.rail.clientWidth = 1200;
  app.view.emit('resize');
  app.flush();
  assert.equal(app.calls.length, count, 'The browser handles the fitting rail without programmatic scrolling');
});

test('a hidden initial rail is measured after opening; cleanup detaches work', () => {
  const app = browser({ width: 0 });
  app.flush();
  assert.equal(app.calls.length, 0);
  app.rail.clientWidth = 351;
  app.observers[0].emit();
  app.flush();
  app.assertAtStart();
  const count = app.calls.length;
  app.view.emit('cafe:menu-rendered');
  app.cleanup();
  app.flush();
  app.view.emit('resize');
  app.flush();
  assert.equal(app.calls.length, count);
  assert.equal(app.observers[0].targets.size, 0);
});

