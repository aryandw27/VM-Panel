const test = require('node:test');
const assert = require('node:assert/strict');


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeElement(tag) {
  const listeners = new Map();
  let _id = '';
  const el = {
    get id() { return _id; },
    set id(v) { _id = String(v); if (typeof byId !== 'undefined') byId.set(_id, el); },
    tag,
    children: [],
    attributes: {},
    dataset: {},
    style: {},
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    hidden: false,
    disabled: false,
    removed: false,
    classList: {
      add: (...cls) => { el.className = `${el.className} ${cls.join(' ')}`.trim(); },
      remove: (...cls) => { el.className = el.className.split(' ').filter((c) => !cls.includes(c)).join(' '); },
      contains: (c) => el.className.split(' ').includes(c),
    },
    setAttribute: (k, v) => {
      el.attributes[k] = String(v);
      if (k === 'id') byId.set(String(v), el);
      if (k.startsWith('data-')) el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
    },
    getAttribute: (k) => el.attributes[k],
    removeAttribute: (k) => { delete el.attributes[k]; },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    appendChild: (child) => { el.children.push(child); return child; },
    append: (...kids) => { el.children.push(...kids); return el; },
    replaceChildren: (...kids) => { el.children = kids; return el; },
    remove: () => { el.removed = true; },
    focus: () => {},
    select: () => {},
    click: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    insertAdjacentHTML: (pos, html) => { el.innerHTML += html; },
    fire: (type, event = {}) => {
      let prevented = false;
      const full = { target: el, preventDefault: () => { prevented = true; }, ...event };
      for (const fn of listeners.get(type) || []) fn(full);
      return full;
    },
    get prevented() { return undefined; },
  };
  return el;
}

const byId = new Map();
for (const id of ['vpAiDrawer', 'vpAiThreads', 'vpAiNew', 'vpAiInput', 'vpAiForm', 'vpAiSend', 'vpAiActivity',
  'vpAiMessages', 'vpAiLaunch', 'vpAiClose', 'vpAiBackdrop', 'vpAiRename', 'vpAiDelete',
  'aiProvider', 'aiEndpointGroup', 'aiModel', 'aiCustomModel', 'aiApiKey', 'aiEndpoint', 'aiNickname',
  'aiCredentialForm', 'aiCredentials', 'aiActiveStatus', 'aiTools', 'aiToolsStatus', 'aiSaveTools',
  'aiHistory', 'aiLoadModels', 'aiModelsStatus', 'vpAiStatusDot', 'vpAiSetupPrompt', 'vpAiProviderStatus']) {
  const el = makeElement(id.startsWith('vpAiInput') ? 'textarea' : id.startsWith('ai') ? 'input' : 'div');
  el.setAttribute('id', id);
  byId.set(id, el);
}
byId.get('aiProvider').value = 'openai';
byId.get('vpAiInput').value = '';

byId.get('vpAiForm').requestSubmit = function () {
  this.fire('submit', { submitter: byId.get('vpAiSend') });
};
byId.get('aiCredentialForm').querySelector = () => null;

const toasts = [];
global.window = {
  VP_TOKEN: '',
  VP: {
    toast: (msg, type) => { toasts.push({ msg, type }); return () => {}; },
    errorMessage: (e, fallback = 'Something went wrong.') => (e && e.message) || fallback,
    busy: async (button, label, fn) => {
      if (typeof label === 'function') fn = label;
      if (button) button.disabled = true;
      try { return await fn(); } finally { if (button) button.disabled = false; }
    },
  },
};
global.location = { pathname: '/dashboard' };
global.CSS = { escape: (s) => String(s) };
const body = makeElement('body');
global.document = {
  activeElement: null,
  body,
  getElementById: (id) => byId.get(id) || null,
  createElement: (tag) => {
    const el = makeElement(tag);
    const origSet = el.setAttribute;
    el.setAttribute = (k, v) => {
      origSet(k, v);
      if (k === 'id') byId.set(String(v), el);
    };
    return el;
  },
  createTextNode: (text) => ({ text: String(text) }),
  addEventListener: () => {},
};
global.navigator = {};
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);


let modelBehaviors = []; 
const fetchLog = [];
function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
global.fetch = async (url, options = {}) => {
  const method = (options.method || 'GET').toUpperCase();
  fetchLog.push(`${method} ${url}`);
  if (url === '/api/ai/providers' && method === 'GET') {
    return jsonResponse({ providers: [{ id: 'openai', models: ['gpt-4o-mini'] }, { id: 'anthropic', models: ['claude-x'] }, { id: 'compatible', models: [] }] });
  }
  if (url === '/api/ai/credentials' && method === 'GET') return jsonResponse({ credentials: [] });
  if (url === '/api/ai/tools' && method === 'GET') return jsonResponse({ tools: [], permissions: {} });
  if (url === '/api/ai/history' && method === 'GET') return jsonResponse({ events: [] });
  const modelsMatch = url.match(/^\/api\/ai\/providers\/([^/]+)\/models$/);
  if (modelsMatch && method === 'POST') {
    const next = modelBehaviors.length > 1 ? modelBehaviors.shift() : modelBehaviors[0];
    if (!next) return jsonResponse({ models: ['gpt-4o-mini'] });
    if (next.throws) throw next.throws;
    if (next.delay) await sleep(next.delay);
    return jsonResponse(next.body, next.status || 200);
  }
  if (url === '/api/ai/conversations' && method === 'POST') return jsonResponse({ conversation: { id: 'c1' } });
  if (url === '/api/ai/conversations' && method === 'GET') return jsonResponse({ conversations: [] });
  const convoMatch = url.match(/^\/api\/ai\/conversations\/([^/]+)$/);
  if (convoMatch && method === 'GET') return jsonResponse({ conversation: { id: 'c1' }, messages: global.__historyMessages || [] });
  if (url.endsWith('/approvals') && method === 'GET') return jsonResponse({ approvals: [] });
  if (url.endsWith('/messages') && method === 'POST') {
    if (global.__messagesBehavior === 'fail') return jsonResponse({ error: 'Provider exploded' }, 500);
    if (global.__messagesBehavior === 'slow-ok') await sleep(150);
    const frame = `data: ${JSON.stringify({ type: 'complete', content: 'hi' })}\n\n`;
    let sent = false;
    return {
      ok: true, status: 200,
      body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: new TextEncoder().encode(frame) })) }) },
    };
  }
  return jsonResponse({});
};

require('../public/js/ai-assistant.js');
require('../public/js/ai-settings.js');

const input = () => byId.get('vpAiInput');
const form = () => byId.get('vpAiForm');

const messagePosts = () => fetchLog.filter((l) => l === 'POST /api/ai/conversations/c1/messages').length;

test('Enter sends exactly one message', async () => {
  fetchLog.length = 0;
  global.__messagesBehavior = 'ok';
  input().value = 'hello';
  const before = messagePosts();
  input().fire('keydown', { key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, repeat: false, isComposing: false, keyCode: 13 });
  await sleep(50);
  assert.equal(messagePosts(), before + 1);
});

test('Shift+Enter inserts a newline instead of sending', async () => {
  fetchLog.length = 0;
  input().value = 'line one';
  const ev = input().fire('keydown', { key: 'Enter', shiftKey: true, ctrlKey: false, metaKey: false, repeat: false, isComposing: false, keyCode: 13 });
  assert.equal(messagePosts(), 0);
  void ev;
});

test('Enter on empty input sends nothing', () => {
  fetchLog.length = 0;
  input().value = '   ';
  input().fire('keydown', { key: 'Enter', shiftKey: false, repeat: false, isComposing: false, keyCode: 13 });
  assert.equal(messagePosts(), 0);
});

test('IME composition Enter never submits', () => {
  fetchLog.length = 0;
  input().value = 'nihongo';
  input().fire('keydown', { key: 'Enter', shiftKey: false, repeat: false, isComposing: true, keyCode: 229 });
  assert.equal(messagePosts(), 0);
});

test('rapid Enter does not duplicate sends', async () => {
  fetchLog.length = 0;
  global.__messagesBehavior = 'slow-ok';
  input().value = 'spam me';
  
  form().fire('submit', {});
  await sleep(20);
  form().fire('submit', {});
  await sleep(300);
  assert.equal(messagePosts(), 1);
  global.__messagesBehavior = 'ok';
});

test('failed send preserves the message for retry', async () => {
  fetchLog.length = 0;
  global.__messagesBehavior = 'fail';
  input().value = 'do not lose me';
  const before = messagePosts();
  form().fire('submit', {});
  await sleep(50);
  assert.equal(messagePosts(), before + 1, 'attempt was made');
  assert.equal(input().value, 'do not lose me');
  global.__messagesBehavior = 'ok';
});

test('provider switch auto-loads models and preserves valid selection', async () => {
  fetchLog.length = 0;
  modelBehaviors = [{ body: { models: ['claude-x', 'claude-y'] } }];
  const provider = byId.get('aiProvider');
  const select = byId.get('aiModel');
  select.replaceChildren();
  select.value = '';
  provider.value = 'anthropic';
  provider.fire('change', {});
  await sleep(300);
  assert.ok(fetchLog.some((l) => l === 'POST /api/ai/providers/anthropic/models'), 'auto fetch on switch');
  assert.equal(select.value, 'claude-x');
});

test('stale responses never overwrite the current provider', async () => {
  fetchLog.length = 0;
  const provider = byId.get('aiProvider');
  const select = byId.get('aiModel');
  
  modelBehaviors = [{ body: { models: ['slow-model'] }, delay: 250 }];
  provider.value = 'openrouter';
  provider.fire('change', {});
  await sleep(200); 
  modelBehaviors = [{ body: { models: ['fast-model'] } }];
  provider.value = 'compatible';
  provider.fire('change', {});
  await sleep(600);
  assert.equal(select.value, 'fast-model');
});

test('empty model list shows retry and cache avoids refetch', async () => {
  fetchLog.length = 0;
  const provider = byId.get('aiProvider');
  modelBehaviors = [{ body: { models: [] } }];
  provider.value = 'openai';
  provider.fire('change', {});
  await sleep(300);
  const status = byId.get('aiModelsStatus');
  assert.match(status.textContent, /No models were returned/);
  assert.ok(byId.get('aiModelsRetry'), 'retry button offered');
  const calls = fetchLog.filter((l) => l === 'POST /api/ai/providers/openai/models').length;
  provider.fire('change', {});
  await sleep(300);
  assert.equal(fetchLog.filter((l) => l === 'POST /api/ai/providers/openai/models').length, calls, 'cached, no refetch');
});

test('failed discovery notifies with retry option', async () => {
  toasts.length = 0;
  const provider = byId.get('aiProvider');
  modelBehaviors = [{ status: 429, body: { error: 'Too many requests', category: 'rate_limited', retry_after: 20 } }];
  
  byId.get('aiLoadModels').fire('click', {});
  await sleep(300);
  assert.ok(toasts.some((t) => t.type === 'error'), 'error toast shown');
  assert.ok(byId.get('aiModelsRetry'), 'retry button offered');
});

test('assistant messages render token usage or an honest unavailable note', async () => {
  global.__historyMessages = [
    { role: 'user', content: 'hi', created_at: '2026-01-01' },
    { role: 'assistant', content: 'hello', usage: { input_tokens: 920, output_tokens: 328 }, created_at: '2026-01-01' },
    { role: 'assistant', content: 'old', usage: null, created_at: '2026-01-01' },
    { role: 'assistant', content: 'partial', usage: { input_tokens: 50, output_tokens: null }, created_at: '2026-01-01' },
  ];
  await window.openVPAI('usage check', false);
  await sleep(50);
  const html = byId.get('vpAiMessages').innerHTML;
  assert.match(html, /Tokens: 920 input · 328 output · 1,248 total/);
  assert.match(html, /Token usage unavailable/);
  assert.match(html, /Tokens: 50 input/);
  assert.ok(!html.includes('NaN'), 'no fabricated numbers');
  global.__historyMessages = null;
});

test('suggestion click fills the composer without sending', () => {
  fetchLog.length = 0;
  const box = byId.get('vpAiMessages');
  const suggestion = makeElement('button');
  suggestion.setAttribute('data-ai-suggestion', 'Check resource usage');
  box.fire('click', { target: { closest: (sel) => (sel === '[data-ai-suggestion]' ? suggestion : null) } });
  assert.equal(byId.get('vpAiInput').value, 'Check resource usage');
  assert.equal(fetchLog.length, 0, 'no request fired');
});

test('markdown tables, lists, headings, and links render safely', async () => {
  global.__historyMessages = [
    { role: 'assistant', content: '## Status\n\n| Name | State |\n| --- | --- |\n| web | running |\n\n1. first step\n2. second step\n\nSee [docs](https://example.com/help) and `code`.', usage: null, created_at: '2026-01-01' },
    { role: 'assistant', content: 'Evil [x](javascript:alert(1)) and <img src=x onerror=alert(1)>', usage: null, created_at: '2026-01-01' },
  ];
  await window.openVPAI('render check', false);
  await sleep(50);
  const html = byId.get('vpAiMessages').innerHTML;
  assert.match(html, /<table class="vp-ai-table">/);
  assert.match(html, /<th>State<\/th>/);
  assert.match(html, /vp-ai-list-num/);
  assert.match(html, /<a href="https:\/\/example\.com\/help" target="_blank" rel="noopener">docs<\/a>/);
  assert.ok(!html.includes('<a href="javascript'), 'unsafe scheme never becomes a link');
  assert.ok(!html.includes('<img'), 'raw html escaped');
  global.__historyMessages = null;
});

test('tool activity renders as labelled collapsible section', async () => {
  global.__historyMessages = [
    { role: 'assistant', content: 'done', tool_activity: [{ name: 'get_vm_stats', status: 'success' }, { name: 'read_file', status: 'error' }], usage: null, created_at: '2026-01-01' },
  ];
  await window.openVPAI('tools check', false);
  await sleep(50);
  const html = byId.get('vpAiMessages').innerHTML;
  assert.match(html, /<details class="vp-ai-tools">/);
  assert.match(html, /attention needed/);
  assert.match(html, /data-status="error"/);
  global.__historyMessages = null;
});

test('provider status dot reflects configuration', async () => {
  await window.openVPAI('status check', false);
  await sleep(100);
  const dot = byId.get('vpAiStatusDot');
  assert.equal(dot.dataset.state, 'setup');
  assert.equal(byId.get('vpAiSetupPrompt').hidden, false);
});
