const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the browser entry point with a minimal DOM and no network/provider calls.
function frontend({ width, usableHeight = 700, reducedMotion = false } = {}) {
  class Element {
    constructor() { this.childNodes = []; this.attributes = {}; this.classList = { toggle() {} }; this.value = ''; this.scrollHeight = 400; this.scrollTop = 0; this.clientHeight = 400; }
    append(...children) { this.childNodes.push(...children); }
    replaceChildren(...children) { this.childNodes = [...children]; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    focus(options) { this.focused = true; this.focusOptions = options; }
    scrollIntoView(options) { this.scrollOptions = options; }
  }
  const elements = new Map();
  const document = {
    hidden: false,
    documentElement: { style: { setProperty(key, value) { this[key] = value; } } },
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement() { return new Element(); }, createTextNode(text) { return { textContent: text }; },
    querySelectorAll() { return []; }, addEventListener() {},
  };
  const viewportEvents = {};
  const window = width === undefined ? undefined : {
    matchMedia(query) { return { matches: query.includes('reduced-motion') ? reducedMotion : width <= 767 }; },
    visualViewport: { height: usableHeight, addEventListener(name, listener) { viewportEvents[name] = listener; } },
  };
  const context = vm.createContext({ document, window, fetch: () => new Promise(() => {}), setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), context);
  return { elements, document, window, viewportEvents, run: source => vm.runInContext(source, context) };
}

test('opening an empty conversation replaces the loading placeholder and preserves identical rendered history', () => {
  const { document, run } = frontend();
  const area = document.getElementById('messages');
  area.append({ textContent: 'Loading conversation…' });
  run('renderMessages([])');
  assert.match(area.childNodes[0].textContent, /Your test thread is ready/);
  const first = area.childNodes[0];
  run('renderMessages([])');
  assert.equal(area.childNodes[0], first, 'unchanged polls do not replace rendered history');
});

test('frontend navigation switches to sender details and guide, then restores conversations', () => {
  const { document, run } = frontend();
  run("showView('senders')");
  assert.equal(document.getElementById('conversations-view').hidden, true);
  assert.equal(document.getElementById('senders-view').hidden, false);
  assert.equal(document.getElementById('breadcrumb-view').textContent, 'Sender & connection');
  run("showView('guide')");
  assert.equal(document.getElementById('guide-view').hidden, false);
  assert.equal(document.getElementById('senders-view').hidden, true);
  run("showView('conversations')");
  assert.equal(document.getElementById('conversations-view').hidden, false);
  assert.equal(document.getElementById('guide-view').hidden, true);
});

test('back to conversations preserves the active thread and unsent message', () => {
  const { document, run } = frontend();
  run("active = 'test-thread'; $('message').value = 'Unsent test reply'; showConversationPanel('thread')");
  assert.equal(document.getElementById('inbox-shell').attributes['data-panel'], 'thread');
  document.getElementById('back-to-conversations').onclick();
  assert.equal(document.getElementById('inbox-shell').attributes['data-panel'], 'list');
  assert.equal(document.getElementById('message').value, 'Unsent test reply');
  assert.equal(run('active'), 'test-thread');
  run("showConversationPanel('thread')");
  assert.equal(document.getElementById('message').value, 'Unsent test reply');
});

test('phone back navigation focuses the conversation heading without opening the search keyboard', () => {
  const { document, run } = frontend({ width: 320, reducedMotion: true });
  run("showConversationPanel('thread')");
  document.getElementById('back-to-conversations').onclick();
  assert.equal(document.getElementById('conversations-heading').focused, true);
  assert.equal(document.getElementById('search').focused, undefined);
  assert.equal(document.getElementById('inbox-shell').scrollOptions.behavior, 'auto');
});

test('usable screen height updates when the software keyboard resizes the phone viewport', () => {
  const { document, window, viewportEvents } = frontend({ width: 390, usableHeight: 780 });
  assert.equal(document.documentElement.style['--usable-height'], '780px');
  window.visualViewport.height = 420;
  viewportEvents.resize();
  assert.equal(document.documentElement.style['--usable-height'], '420px');
});
