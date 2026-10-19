const test = require('node:test');
const assert = require('node:assert/strict');


function makeElement(tag) {
  const listeners = new Map();
  const el = {
    tag,
    children: [],
    attributes: {},
    style: {},
    className: '',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    removed: false,
    focused: false,
    classList: { add: (...cls) => { el.className = `${el.className} ${cls.join(' ')}`.trim(); } },
    setAttribute: (k, v) => { el.attributes[k] = String(v); },
    getAttribute: (k) => el.attributes[k],
    removeAttribute: (k) => { delete el.attributes[k]; },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    appendChild: (child) => { el.children.push(child); return child; },
    append: (...kids) => { el.children.push(...kids); return el; },
    remove: () => { el.removed = true; },
    focus: () => { el.focused = true; },
    select: () => {},
    fire: (type, event = {}) => {
      for (const fn of listeners.get(type) || []) fn({ target: el, ...event });
    },
  };
  return el;
}

const body = makeElement('body');
const elementsById = new Map();

function textOf(node) {
  if (typeof node === 'string') return node;
  if (!node) return '';
  if (node.text) return node.text;
  let out = node.textContent || '';
  for (const child of node.children || []) out += textOf(child);
  return out;
}

function liveToasts() {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.className && node.className.split(' ').includes('toast') && !node.removed) found.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(body);
  return found;
}

function clearToasts() {
  for (const t of liveToasts()) { try { t.remove(); } catch (_) {} }
  VP._internal.seenToasts.clear();
}
global.window = {};
global.navigator = {};
global.document = {
  activeElement: null,
  body,
  execResult: true,
  execCommand: () => global.document.execResult,
  getElementById: (id) => elementsById.get(id) || null,
  createElement: (tag) => makeElement(tag),
  createTextNode: (text) => ({ text: String(text) }),
  addEventListener: () => {},
};
const realCreateElement = global.document.createElement;
global.document.createElement = (tag) => {
  const el = realCreateElement(tag);
  const origSet = el.setAttribute;
  el.setAttribute = (k, v) => {
    origSet(k, v);
    if (k === 'id') elementsById.set(String(v), el);
  };
  return el;
};

const VP = require('../public/js/panel.js').VP || global.window.VP;

function findByClass(root, cls) {
  if (root.className && root.className.split(' ').includes(cls)) return root;
  for (const child of root.children || []) {
    if (typeof child === 'object') {
      const found = findByClass(child, cls);
      if (found) return found;
    }
  }
  return null;
}

test('toast renders typed, labelled, role-annotated notifications', () => {
  clearToasts();
  const roles = { success: 'status', error: 'alert', warning: 'alert', info: 'status' };
  for (const type of ['success', 'error', 'warning', 'info']) {
    const dismiss = VP.toast(`message-${type}`, type, { sticky: true });
    assert.equal(typeof dismiss, 'function');
    const node = liveToasts().find((t) => textOf(t).includes(`message-${type}`));
    assert.ok(node, `${type} toast rendered`);
    assert.equal(node.attributes.role, roles[type]);
    assert.ok(textOf(node).includes(VP._internal.TOAST_TITLES[type]), `${type} toast labelled`);
    dismiss();
  }
  clearToasts();
});

test('toast suppresses duplicate messages while visible', () => {
  clearToasts();
  VP.toast('duplicate-check', 'info', { sticky: true });
  VP.toast('duplicate-check', 'info', { sticky: true });
  VP.toast('duplicate-check', 'info', { sticky: true });
  assert.equal(liveToasts().length, 1, 'only one live duplicate toast');
  clearToasts();
});

test('toast caps the stack instead of piling up', () => {
  clearToasts();
  for (let i = 0; i < 8; i += 1) VP.toast(`cap-${i}`, 'info', { sticky: true });
  assert.ok(VP._internal.seenToasts.size <= 4, `stack capped, got ${VP._internal.seenToasts.size}`);
  clearToasts();
});

test('loading toast stays until dismissed', async () => {
  VP._internal.seenToasts.clear();
  const dismiss = VP.toast('Working on it', 'loading');
  assert.equal(VP._internal.seenToasts.size, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(VP._internal.seenToasts.size, 1, 'loading toast does not auto-dismiss');
  dismiss();
  assert.equal(VP._internal.seenToasts.size, 0);
});

test('error toast auto-dismisses but can be sticky', async () => {
  VP._internal.seenToasts.clear();
  VP.toast('boom', 'error', { duration: 5 });
  assert.equal(VP._internal.seenToasts.size, 1);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(VP._internal.seenToasts.size, 0);
});

test('confirmDialog confirms and cancels with explicit buttons', async () => {
  const pending = VP.confirmDialog('Delete this thing?', { title: 'Delete?', confirmText: 'Delete thing' });
  const overlay = body.children[body.children.length - 1];
  const box = overlay.children[0];
  const row = box.children[box.children.length - 1];
  assert.equal(textOf(row.children[0]), 'Cancel');
  assert.equal(textOf(row.children[1]), 'Delete thing');
  row.children[1].fire('click');
  assert.equal(await pending, true);

  const pending2 = VP.confirmDialog('Sure?', { title: 'Sure?' });
  const overlay2 = body.children[body.children.length - 1];
  overlay2.fire('keydown', { key: 'Escape' });
  assert.equal(await pending2, false);
});

test('promptDialog validates, submits on Enter, and cancels', async () => {
  const pending = VP.promptDialog('Rename', { label: 'Name', value: 'old' });
  const overlay = body.children[body.children.length - 1];
  const box = overlay.children[overlay.children.length - 1];
  const input = box.children.find((c) => c.tag === 'input');
  const row = box.children[box.children.length - 1];
  input.value = '   ';
  row.children[1].fire('click');
  assert.equal(input.focused, true, 'invalid input keeps the dialog open and refocuses');
  input.value = 'new name';
  input.fire('keydown', { key: 'Enter' });
  assert.equal(await pending, 'new name');

  const pending2 = VP.promptDialog('Rename', { label: 'Name' });
  const overlay2 = body.children[body.children.length - 1];
  overlay2.fire('click', { target: overlay2 });
  assert.equal(await pending2, null);
});

test('secretDialog exposes copy without making the secret editable', async () => {
  let copied = null;
  global.navigator.clipboard = { writeText: async (t) => { copied = t; } };
  const pending = VP.secretDialog({ title: 'Key', secret: 'raw-secret-123' });
  const overlay = body.children[body.children.length - 1];
  const box = overlay.children[overlay.children.length - 1];
  const input = box.children.find((c) => c.tag === 'input');
  assert.equal(input.value, 'raw-secret-123');
  assert.equal(input.attributes.readonly, 'true');
  const row = box.children[box.children.length - 1];
  row.children[0].fire('click');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(copied, 'raw-secret-123');
  row.children[1].fire('click');
  assert.equal(await pending, true);
  delete global.navigator.clipboard;
});

test('errorMessage maps known failures to actionable guidance', () => {
  assert.match(VP.errorMessage({ status: 401, message: 'x' }), /log in again/);
  assert.match(VP.errorMessage({ status: 403, message: 'x' }), /permission/);
  assert.match(VP.errorMessage({ status: 404, message: 'x' }), /not been found|not found/);
  assert.match(VP.errorMessage({ status: 409, message: 'x' }), /Refresh/);
  assert.match(VP.errorMessage({ status: 429, message: 'x' }), /Too many requests/);
  assert.match(VP.errorMessage({ status: 402, message: 'billing?' }), /billing or credit/);
  assert.match(VP.errorMessage({ data: { category: 'provider_credits' }, message: 'x' }), /billing or credit/);
  assert.match(VP.errorMessage({ data: { category: 'invalid_credentials' }, message: 'x' }), /API key/);
  assert.match(VP.errorMessage({ message: 'Failed to fetch' }), /reach the service/);
  assert.match(VP.errorMessage({ status: 400, data: { reference: 'abc123' }, message: 'Bad' }), /Reference: abc123/);
  assert.equal(VP.errorMessage(null, 'Fallback here.'), 'Fallback here.');
});

test('errorMessage truncates untrusted long messages', () => {
  const out = VP.errorMessage({ status: 500, message: `sk-live-SECRET${'x'.repeat(600)}` });
  assert.ok(out.length <= 360, `bounded length, got ${out.length}`);
});

test('api() attaches status metadata and survives network failure', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) });
  await assert.rejects(VP.api('/x'), /Forbidden/);
  try {
    await VP.api('/x');
  } catch (e) {
    assert.equal(e.status, 403);
  }
  global.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    await VP.api('/x');
    assert.fail('should throw');
  } catch (e) {
    assert.equal(e.status, 0);
    assert.match(e.message, /reach the service/);
  }
  global.fetch = realFetch;
});

test('busy() disables controls during work and always restores them', async () => {
  const btn = makeElement('button');
  btn.disabled = false;
  const result = await VP.busy(btn, 'Saving…', async () => {
    assert.equal(btn.disabled, true);
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(btn.disabled, false);
  await assert.rejects(VP.busy(btn, async () => { throw new Error('nope'); }), /nope/);
  assert.equal(btn.disabled, false);
});

test('copyRawText uses the async clipboard when available', async () => {
  let written = null;
  global.navigator.clipboard = { writeText: async (t) => { written = t; } };
  assert.equal(await VP.copyRawText('ssh -p 2222 deploy@example.com'), true);
  assert.equal(written, 'ssh -p 2222 deploy@example.com');
  delete global.navigator.clipboard;
});

test('copyRawText falls back to execCommand and reports honestly', async () => {
  delete global.navigator.clipboard;
  global.document.execResult = true;
  assert.equal(await VP.copyRawText('fallback-value'), true);
  global.document.execResult = false;
  assert.equal(await VP.copyRawText('fallback-value'), false);
  assert.equal(await VP.copyRawText(''), false);
  assert.equal(await VP.copyRawText(null), false);
});

test('copyText toasts success only on real success', async () => {
  clearToasts();
  global.navigator.clipboard = { writeText: async () => {} };
  assert.equal(await VP.copyText('abc', 'SSH command copied to clipboard.'), true);
  assert.ok(liveToasts().some((t) => textOf(t).includes('SSH command copied to clipboard.')));
  clearToasts();
  delete global.navigator.clipboard;
  global.document.execResult = false;
  assert.equal(await VP.copyText('abc'), false);
  assert.ok(liveToasts().some((t) => textOf(t).includes('Copy failed')));
  clearToasts();
});

test('copyButton reads fresh text per click with transient label', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  clearToasts();
  let written = null;
  global.navigator.clipboard = { writeText: async (t) => { written = t; } };
  const btn = makeElement('button');
  btn.textContent = 'Copy SSH';
  let current = 'ssh -p 1 a@x';
  VP.copyButton(btn, () => current, { success: 'SSH command copied to clipboard.' });
  btn.fire('click');
  await sleep(20);
  assert.equal(written, 'ssh -p 1 a@x');
  assert.equal(btn.textContent, 'Copied');
  current = 'ssh -p 2 b@y'; 
  await sleep(1700); 
  assert.equal(btn.textContent, 'Copy SSH');
  btn.fire('click');
  await sleep(20);
  assert.equal(written, 'ssh -p 2 b@y');
  delete global.navigator.clipboard;
  clearToasts();
});
