const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the browser entry point with a minimal DOM and no network/provider calls.
function frontend() {
  class Element {
    constructor() { this.childNodes = []; this.attributes = {}; this.classList = { toggle() {} }; this.value = ''; this.scrollHeight = 400; this.scrollTop = 0; this.clientHeight = 400; }
    append(...children) { this.childNodes.push(...children); }
    replaceChildren(...children) { this.childNodes = [...children]; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    focus() {}
  }
  const elements = new Map();
  const document = {
    hidden: false,
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement() { return new Element(); }, createTextNode(text) { return { textContent: text }; },
    querySelectorAll() { return []; }, addEventListener() {},
  };
  const context = vm.createContext({ document, fetch: () => new Promise(() => {}), setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), context);
  return { elements, document, run: source => vm.runInContext(source, context) };
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
  assert.equal(document.getElementById('breadcrumb-view').textContent, 'Senders & connection');
  run("showView('guide')");
  assert.equal(document.getElementById('guide-view').hidden, false);
  assert.equal(document.getElementById('senders-view').hidden, true);
  run("showView('conversations')");
  assert.equal(document.getElementById('conversations-view').hidden, false);
  assert.equal(document.getElementById('guide-view').hidden, true);
});
