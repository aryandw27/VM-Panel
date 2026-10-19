window.VP = (() => {
  const state = { socket: null };

  const TOAST_TYPES = ['success', 'error', 'warning', 'info', 'loading'];
  const TOAST_TITLES = { success: 'Success', error: 'Error', warning: 'Warning', info: 'Notice', loading: 'Working' };
  const TOAST_TIMEOUT = { success: 4500, info: 4500, warning: 6500, error: 9000, loading: 0 };
  const TOAST_MAX = 4;
  const seenToasts = new Map(); 

  function toastWrap() {
    let wrap = document.getElementById('toasts');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'toasts';
      wrap.setAttribute('aria-live', 'polite');
      document.body.appendChild(wrap);
    }
    return wrap;
  }

  function refreshIcons(root) {
    try {
      const scope = (typeof window !== 'undefined' && window.lucide && typeof window.lucide.createIcons === 'function') ? window.lucide : null;
      if (scope) scope.createIcons({ attrs: {}, nameAttr: 'data-lucide' });
    } catch (_) {}
    void root;
  }

  
  
  function toast(msg, type = 'info', opts = {}) {
    if (typeof type === 'object' && type !== null) { opts = type; type = 'info'; }
    if (!TOAST_TYPES.includes(type)) type = 'info';
    const text = String(msg ?? '').slice(0, 500) || 'Something happened.';
    const key = `${type}\n${text}`;
    const existing = seenToasts.get(key);
    if (existing && existing.el.isConnected !== false) {
      if (existing.timer) { clearTimeout(existing.timer); existing.timer = scheduleDismiss(key, existing.el, type, opts); }
      return () => dismissToast(key);
    }
    const wrap = toastWrap();
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.setAttribute('role', (type === 'error' || type === 'warning') ? 'alert' : 'status');
    const title = el('strong', { class: 'toast-title' }, opts.title || TOAST_TITLES[type]);
    const body = el('span', { class: 'toast-msg' }, text);
    const close = el('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss notification' }, '×');
    close.addEventListener('click', () => dismissToast(key));
    t.appendChild(title);
    t.appendChild(body);
    t.appendChild(close);
    wrap.appendChild(t);
    refreshIcons(t);
    const timer = scheduleDismiss(key, t, type, opts);
    
    const sticky = opts.sticky === true || (type === 'loading' && opts.sticky !== false);
    seenToasts.set(key, { el: t, timer, sticky });
    enforceToastCap();
    return () => dismissToast(key);
  }

  function scheduleDismiss(key, node, type, opts) {
    const sticky = opts.sticky === true || (type === 'loading' && opts.sticky !== false);
    if (sticky) return null;
    const ms = Number.isFinite(opts.duration) ? opts.duration : (TOAST_TIMEOUT[type] || 4500);
    return setTimeout(() => {
      node.classList.add('toast-leaving');
      setTimeout(() => dismissToast(key), 300);
    }, ms);
  }

  function dismissToast(key) {
    const entry = seenToasts.get(key);
    if (!entry) return;
    seenToasts.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    try { entry.el.remove(); } catch (_) {}
  }

  function enforceToastCap() {
    const keys = Array.from(seenToasts.keys());
    while (keys.length > TOAST_MAX) {
      const dropIdx = keys.findIndex((k) => !seenToasts.get(k)?.sticky);
      dismissToast(dropIdx >= 0 ? keys[dropIdx] : keys[0]);
      keys.splice(dropIdx >= 0 ? dropIdx : 0, 1);
    }
  }

  
  
  function errorMessage(err, fallback = 'Something went wrong while processing your request. Please try again.') {
    const ref = err?.data?.reference || err?.reference;
    const suffix = ref ? ` Reference: ${String(ref).slice(0, 40)}.` : '';
    const status = Number(err?.status);
    const category = String(err?.data?.category || err?.category || '');
    if (status === 401) return 'Your session has expired. Please log in again.' + suffix;
    if (status === 403) return 'You do not have permission to perform this action.' + suffix;
    if (status === 404) return 'The requested resource was not found. It may have been moved or removed.' + suffix;
    if (status === 409) return 'This resource changed while you were working. Refresh and try again.' + suffix;
    if (status === 429) {
      const wait = Number(err?.data?.retry_after);
      if (Number.isFinite(wait) && wait > 0) return `Too many requests. Try again in about ${Math.ceil(wait)} seconds.`;
      return 'Too many requests. Wait a moment before trying again.' + suffix;
    }
    if (status === 402 || category === 'provider_credits' || category === 'billing') return 'The provider rejected this request because of a possible billing or credit limit. Check your provider account and usage.' + suffix;
    if (category === 'invalid_credentials') return 'The provider rejected this API key. Check the key and its permissions.' + suffix;
    if (category === 'provider_rate_limit') return 'The provider rate-limited this request. Wait a moment and try again.' + suffix;
    if (category === 'unsupported_model') return 'The provider could not find this model. Choose a model available to your account.' + suffix;
    if (category === 'provider_outage') return 'The provider returned a service error. Try again later.' + suffix;
    if (category === 'operation_uncertain') return 'The operation did not confirm a final result. Check the current state before retrying.' + suffix;
    if (status === 0 || /failed to fetch|networkerror|load failed/i.test(String(err?.message || ''))) return 'We couldn\u2019t reach the service. Check your connection and try again.' + suffix;
    const raw = String(err?.message || '').slice(0, 300).trim();
    if (raw) return raw + suffix;
    return fallback + suffix;
  }

  async function api(url, opts = {}) {
    const o = { ...opts, headers: { ...(opts.headers || {}) } };
    if (o.body && typeof o.body !== 'string') {
      o.headers['Content-Type'] = 'application/json';
      o.body = JSON.stringify(o.body);
    }
    let r;
    try {
      r = await fetch(url, o);
    } catch (networkError) {
      const err = new Error('We couldn\u2019t reach the service. Check your connection and try again.');
      err.status = 0;
      throw err;
    }
    let data = null;
    try { data = await r.json(); } catch (_) { data = null; }
    if (!r.ok) {
      const err = new Error((data && data.error) || `Request failed (${r.status})`);
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  
  async function busy(button, label, fn) {
    if (typeof label === 'function') { fn = label; label = null; }
    const relatives = Array.isArray(button) ? button : [button];
    const prior = relatives.map((b) => (b ? b.disabled : null));
    relatives.forEach((b) => { if (b) { b.disabled = true; b.setAttribute('aria-busy', 'true'); } });
    const labelEl = (relatives[0] && label) ? relatives[0] : null;
    const priorText = labelEl ? labelEl.textContent : null;
    if (labelEl) labelEl.textContent = label;
    try {
      return await fn();
    } finally {
      relatives.forEach((b, i) => { if (b) { b.disabled = prior[i]; b.removeAttribute('aria-busy'); } });
      if (labelEl && priorText !== null) labelEl.textContent = priorText;
    }
  }

  function qs(sel, ctx) { return (ctx || document).querySelector(sel); }
  function qsa(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else e.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function fmtBytes(n) {
    if (n === 0) return '0 B';
    if (!n && n !== 0) return '—';
    let num = typeof n === 'string' ? parseFloat(n) : n;
    if (isNaN(num)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (num >= 1024 && i < units.length - 1) { num /= 1024; i++; }
    return `${num.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function fmtDate(s) {
    if (!s) return '-';
    return new Date(s).toLocaleString();
  }

  
  
  function confirmDialog(message, { danger = true, title = 'Are you sure?', confirmText, cancelText = 'Cancel', details } = {}) {
    return new Promise((resolve) => {
      const previouslyFocused = (typeof document !== 'undefined' && document.activeElement) ? document.activeElement : null;
      const close = (value) => { try { overlay.remove(); } catch (_) {} resolve(value); try { previouslyFocused && previouslyFocused.focus && previouslyFocused.focus(); } catch (_) {} };
      const overlay = el('div', { class: 'vp-modal-overlay' });
      const box = el('div', { class: 'vp-modal', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title });
      const heading = el('h3', { class: 'vp-modal-title', id: 'vpModalTitle' }, title);
      box.setAttribute('aria-labelledby', 'vpModalTitle');
      box.appendChild(heading);
      box.appendChild(el('p', { class: 'muted vp-modal-message' }, message));
      if (details) box.appendChild(el('p', { class: 'hint vp-modal-details' }, details));
      const row = el('div', { class: 'vp-modal-actions' });
      const cancel = el('button', { class: 'btn', type: 'button' }, cancelText);
      const ok = el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button' }, confirmText || (danger ? title.replace(/\?$/, '') : 'Confirm'));
      cancel.addEventListener('click', () => close(false));
      ok.addEventListener('click', () => close(true));
      overlay.addEventListener('click', (event) => { if (event.target === overlay) close(false); });
      overlay.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(false); });
      row.append(cancel, ok);
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      
      try { (danger ? cancel : ok).focus(); } catch (_) {}
    });
  }

  
  
  function promptDialog(title, { label, value = '', placeholder = '', confirmText = 'Save', required = true, pattern, patternHint } = {}) {
    return new Promise((resolve) => {
      const previouslyFocused = (typeof document !== 'undefined' && document.activeElement) ? document.activeElement : null;
      const close = (result) => { try { overlay.remove(); } catch (_) {} resolve(result); try { previouslyFocused && previouslyFocused.focus && previouslyFocused.focus(); } catch (_) {} };
      const overlay = el('div', { class: 'vp-modal-overlay' });
      const box = el('div', { class: 'vp-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
      box.appendChild(el('h3', { class: 'vp-modal-title' }, title));
      const fieldId = `vpPrompt-${Math.random().toString(36).slice(2, 8)}`;
      if (label) box.appendChild(el('label', { class: 'vp-modal-label', for: fieldId }, label));
      const input = el('input', { class: 'form-control vp-modal-input', id: fieldId, type: 'text', value, placeholder });
      const hint = el('p', { class: 'hint vp-modal-error', role: 'alert', hidden: 'true' }, '');
      const row = el('div', { class: 'vp-modal-actions' });
      const cancel = el('button', { class: 'btn', type: 'button' }, 'Cancel');
      const ok = el('button', { class: 'btn btn-primary', type: 'button' }, confirmText);
      const submit = () => {
        const text = String(input.value ?? '').trim();
        if (required && !text) { hint.textContent = 'Enter a value.'; hint.hidden = false; try { input.focus(); } catch (_) {} return; }
        if (pattern && text && !(new RegExp(pattern).test(text))) { hint.textContent = patternHint || 'The value is not in the expected format.'; hint.hidden = false; try { input.focus(); } catch (_) {} return; }
        close(required || text ? text : null);
      };
      cancel.addEventListener('click', () => close(null));
      ok.addEventListener('click', submit);
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
      overlay.addEventListener('click', (event) => { if (event.target === overlay) close(null); });
      overlay.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(null); });
      box.appendChild(input);
      box.appendChild(hint);
      row.append(cancel, ok);
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      try { input.focus(); input.select && input.select(); } catch (_) {}
    });
  }

  
  function secretDialog({ title = 'Copy this now', intro = 'This value will not be shown again.', secret = '', confirmText = 'Done' } = {}) {
    return new Promise((resolve) => {
      const previouslyFocused = (typeof document !== 'undefined' && document.activeElement) ? document.activeElement : null;
      const close = () => { try { overlay.remove(); } catch (_) {} resolve(true); try { previouslyFocused && previouslyFocused.focus && previouslyFocused.focus(); } catch (_) {} };
      const overlay = el('div', { class: 'vp-modal-overlay' });
      const box = el('div', { class: 'vp-modal', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title });
      box.appendChild(el('h3', { class: 'vp-modal-title' }, title));
      box.appendChild(el('p', { class: 'muted vp-modal-message' }, intro));
      const fieldId = `vpSecret-${Math.random().toString(36).slice(2, 8)}`;
      const input = el('input', { class: 'form-control vp-modal-input', id: fieldId, type: 'text', readonly: 'true' });
      input.value = String(secret);
      const row = el('div', { class: 'vp-modal-actions' });
      const copy = el('button', { class: 'btn', type: 'button' }, 'Copy');
      const done = el('button', { class: 'btn btn-primary', type: 'button' }, confirmText);
      copy.addEventListener('click', () => copyText(String(secret)));
      done.addEventListener('click', close);
      overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
      overlay.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
      box.appendChild(input);
      row.append(copy, done);
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      try { input.focus(); input.select(); } catch (_) {}
    });
  }

  function hide(sel) { qsa(sel).forEach((x) => { x.style.display = 'none'; }); }
  function show(sel) { qsa(sel).forEach((x) => { x.style.display = ''; }); }

  document.addEventListener('DOMContentLoaded', () => {
    qsa('[data-confirm]').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        const ok2 = await confirmDialog(b.dataset.confirmMsg || 'This action cannot be undone.');
        if (ok2) {
          if (b.dataset.form) {
            document.getElementById(b.dataset.form).submit();
          } else {
            window.location = b.href;
          }
        }
      });
    });
  });

  function playSound(type) {
    try {
      const src = type === 'online' ? '/arix/online.mp3' : type === 'offline' ? '/arix/offline.mp3' : '/arix/copy.mp3';
      const a = new Audio(src);
      a.volume = 0.4;
      a.play().catch(() => {});
    } catch (_) {}
  }

  
  
  async function copyRawText(text) {
    const value = String(text ?? '');
    if (!value) return false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (_) {}
    
    
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', 'true');
      area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
      const active = document.activeElement;
      document.body.appendChild(area);
      area.focus();
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      try { active && active.focus && active.focus(); } catch (_) {}
      return ok === true;
    } catch (_) {
      return false;
    }
  }

  async function copyText(t, successMessage = 'Copied to clipboard!') {
    const ok = await copyRawText(t);
    if (ok) {
      playSound('copy');
      toast(successMessage, 'success');
    } else {
      toast('Copy failed. Select the text manually to copy it.', 'error');
    }
    return ok;
  }

  
  
  function copyButton(button, getText, { success = 'Copied to clipboard!', copiedLabel = 'Copied' } = {}) {
    if (!button) return;
    button.addEventListener('click', async () => {
      const value = typeof getText === 'function' ? getText() : getText;
      if (!String(value ?? '').trim()) {
        toast('Nothing to copy yet.', 'warning');
        return;
      }
      const prior = button.textContent;
      button.disabled = true;
      const ok = await copyText(value, success);
      button.disabled = false;
      if (ok && copiedLabel) {
        button.textContent = copiedLabel;
        setTimeout(() => { button.textContent = prior; }, 1600);
      }
    });
  }

  return { toast, api, errorMessage, busy, qs, qsa, el, fmtBytes, fmtDate, confirmDialog, promptDialog, secretDialog, hide, show, state, playSound, copyText, copyRawText, copyButton, _internal: { TOAST_TYPES, TOAST_TITLES, enforceToastCap, seenToasts } };
})();
