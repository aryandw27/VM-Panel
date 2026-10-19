(() => {
  const $ = (id) => document.getElementById(id);
  const state = { providers: [], credentials: [], tools: [] };
  async function api(path, options = {}) {
    const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(window.VP_TOKEN ? { authorization: `Bearer ${window.VP_TOKEN}` } : {}), ...(options.headers || {}) };
    const response = await fetch(`/api/ai${path}`, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data.error || `Request failed (${response.status})`);
      err.status = response.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function updateProviderFields() {
    const selected = $('aiProvider').value;
    const provider = state.providers.find((p) => p.id === selected);
    $('aiEndpointGroup').hidden = selected !== 'compatible';
    $('aiModel').hidden = selected === 'compatible';
    $('aiCustomModel').hidden = selected !== 'compatible';
    $('aiModel').replaceChildren(...(provider?.models || []).map((model) => { const option = document.createElement('option'); option.value = model; option.textContent = model; return option; }));
  }
  async function loadCredentials() {
    const data = await api('/credentials');
    state.credentials = data.credentials || [];
    $('aiCredentials').innerHTML = state.credentials.length ? state.credentials.map((c) => `<div class="credential-row"><div><strong>${esc(c.nickname)}</strong>${c.active ? ' <span class="pill pill-green">ACTIVE</span>' : ''}<small>${esc(c.provider)} · ${esc(c.model)} · ${esc(c.key_hint)}${c.last_used_at ? ` · Last used ${esc(new Date(c.last_used_at).toLocaleString())}` : ''}</small></div><div style="display:flex;gap:7px;flex-wrap:wrap">${c.active ? '' : `<button class="btn btn-sm ai-activate" data-id="${esc(c.id)}">Activate</button>`}<button class="btn btn-sm ai-rename" data-id="${esc(c.id)}" data-name="${esc(c.nickname)}">Rename</button><button class="btn btn-sm ai-test" data-id="${esc(c.id)}">Test</button><button class="btn btn-sm btn-danger ai-delete" data-id="${esc(c.id)}" data-name="${esc(c.nickname)}">Delete</button></div></div>`).join('') : '<p class="hint">No provider keys saved. Add your own key above to start chatting.</p>';
    const active = state.credentials.find((c) => c.active);
    $('aiActiveStatus').textContent = active ? `Active · ${active.provider} · ${active.model} · ${active.connection_status}` : 'No active provider';
    $('vpAiProviderStatus') && ($('vpAiProviderStatus').textContent = active ? `${active.provider} · ${active.model}` : 'Add a key in Account → AI assistant');
  }
  async function loadTools() {
    const data = await api('/tools');
    state.tools = data.tools || [];
    const groups = { vm_inspection: 'VM inspection · read-only', recovery_inventory: 'Recovery inventory · read-only', vm_lifecycle: 'VM lifecycle controls · explicit approval required', file_operations: 'VM guest files · writes need approval', operations: 'Schedules & incidents · read-only' };
    const groupOrder = ['vm_inspection', 'recovery_inventory', 'vm_lifecycle', 'file_operations', 'operations'];
    $('aiTools').innerHTML = groupOrder.map((category) => {
      const tools = state.tools.filter((tool) => tool.category === category);
      if (!tools.length) return '';
      return `<section class="ai-tool-group"><h4>${esc(groups[category])}</h4>${tools.map((tool) => `<label class="tool-row"><span><strong>${esc(tool.name.replaceAll('_', ' '))}</strong><br><span class="hint">${esc(tool.description)}</span></span><input type="checkbox" data-tool="${esc(tool.name)}" ${data.permissions?.[tool.name] ? 'checked' : ''} ${category === 'vm_lifecycle' && data.lifecycle_globally_enabled !== true ? 'disabled' : ''} aria-label="Enable ${esc(tool.name)}"/></label>`).join('')}</section>`;
    }).join('');
    if (data.lifecycle_globally_enabled !== true) $('aiToolsStatus').textContent = 'VM lifecycle controls are disabled globally by the administrator; read-only tools remain available.';
  }
  async function loadHistory() {
    const data = await api('/history');
    $('aiHistory').innerHTML = data.events.length ? data.events.map((e) => `<div class="history-row"><strong>${esc(e.status === 'success' ? 'Request completed' : `Request failed · ${e.category || 'provider error'}`)}</strong> · ${esc(e.provider)} / ${esc(e.model)}${e.response_status ? ` · HTTP ${esc(e.response_status)}` : ''}${e.elapsed_ms ? ` · ${Math.round(e.elapsed_ms / 1000)}s` : ''}${e.provider_usage ? ` · Provider-reported tokens: ${esc(e.provider_usage.input_tokens)} in / ${esc(e.provider_usage.output_tokens)} out` : ''}<br><span class="hint">${esc(new Date(e.created_at).toLocaleString())}${e.tool_activity?.length ? ` · Tools: ${esc(e.tool_activity.map((tool) => `${tool.name} (${tool.status})`).join(', '))}` : ''}</span></div>`).join('') : '<p class="hint">No requests have been made yet.</p>';
  }
  const MODEL_CACHE_TTL = 5 * 60 * 1000;
  const modelCache = new Map(); 
  let modelSeq = 0;
  let pendingProvider = null;
  let providerChangeTimer = null;

  function setModelStatus(text, retry) {
    const status = $('aiModelsStatus');
    status.textContent = text;
    const oldRetry = document.getElementById('aiModelsRetry');
    if (oldRetry) oldRetry.remove();
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'aiModelsRetry';
      button.className = 'btn btn-sm';
      button.style.marginLeft = '8px';
      button.textContent = 'Retry';
      button.addEventListener('click', () => fetchModels({ refresh: true }));
      status.appendChild(button);
    }
  }

  function populateModels(provider, models, preserve) {
    const select = $('aiModel');
    select.replaceChildren(...models.map((model) => { const option = document.createElement('option'); option.value = model; option.textContent = model; return option; }));
    if (models.includes(preserve)) {
      select.value = preserve;
    } else if (models.length) {
      select.value = models[0];
    }
    if (provider === 'compatible' && models.length) { select.hidden = false; $('aiCustomModel').hidden = true; }
  }

  async function fetchModels({ refresh = false } = {}) {
    const provider = $('aiProvider').value;
    const select = $('aiModel');
    if (!refresh) {
      const cached = modelCache.get(provider);
      if (cached && (Date.now() - cached.at) < MODEL_CACHE_TTL) {
        populateModels(provider, cached.models, select.value);
        setModelStatus(cached.models.length ? `${cached.models.length} available models loaded.` : 'No models were returned. Enter a model ID supported by this endpoint.', !cached.models.length);
        return;
      }
    }
    if (pendingProvider === provider) return; 
    pendingProvider = provider;
    const seq = ++modelSeq;
    const preserve = select.value;
    select.disabled = true;
    setModelStatus('Loading available models…');
    try {
      const data = await api(`/providers/${encodeURIComponent(provider)}/models`, { method: 'POST', body: { api_key: $('aiApiKey').value, endpoint: $('aiEndpoint').value } });
      if (seq !== modelSeq || $('aiProvider').value !== provider) return; 
      const models = Array.isArray(data.models) ? data.models.filter((m) => typeof m === 'string' && m) : [];
      modelCache.set(provider, { models, at: Date.now() });
      populateModels(provider, models, preserve);
      setModelStatus(models.length ? `${models.length} available models loaded.` : 'No models were returned. Enter a model ID supported by this endpoint.', !models.length);
    } catch (error) {
      if (seq !== modelSeq || $('aiProvider').value !== provider) return;
      setModelStatus(window.VP ? window.VP.errorMessage(error, 'Model loading failed.') : error.message, true);
      if (window.VP) window.VP.toast(window.VP.errorMessage(error, 'Model loading failed.'), 'error');
    } finally {
      if (pendingProvider === provider) pendingProvider = null;
      if (seq === modelSeq) select.disabled = false;
    }
  }

  $('aiProvider').addEventListener('change', () => {
    updateProviderFields();
    clearTimeout(providerChangeTimer);
    providerChangeTimer = setTimeout(() => fetchModels(), 120);
  });
  $('aiLoadModels').addEventListener('click', () => fetchModels({ refresh: true }));
  $('aiCredentialForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const submitter = event.submitter || $('aiCredentialForm').querySelector('[type="submit"]');
    window.VP.busy(submitter, 'Saving…', async () => {
      const provider = $('aiProvider').value;
      const status = $('aiFormStatus');
      status.textContent = 'Saving encrypted credential…';
      try {
        const model = provider === 'compatible' && !$('aiCustomModel').hidden ? $('aiCustomModel').value.trim() : $('aiModel').value;
        await api('/credentials', { method: 'POST', body: { provider, nickname: $('aiNickname').value, api_key: $('aiApiKey').value, model, endpoint: $('aiEndpoint').value } });
        $('aiApiKey').value = '';
        $('aiNickname').value = '';
        status.textContent = 'Saved. Use Test to check the provider connection.';
        await loadCredentials();
      } catch (error) { status.textContent = window.VP.errorMessage(error); }
    }).catch((error) => { $('aiFormStatus').textContent = window.VP.errorMessage(error); });
  });
  $('aiCredentials').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-id]');
    if (!button) return;
    button.disabled = true;
    try {
      if (button.classList.contains('ai-test')) {
        button.textContent = 'Testing…';
        await api(`/credentials/${encodeURIComponent(button.dataset.id)}/test`, { method: 'POST' });
        button.textContent = 'Connected';
        await loadCredentials();
      } else if (button.classList.contains('ai-activate')) {
        await api(`/credentials/${encodeURIComponent(button.dataset.id)}/activate`, { method: 'POST' });
        window.VP.toast('Provider configuration activated.', 'success');
        await loadCredentials();
      } else if (button.classList.contains('ai-rename')) {
        const nickname = await window.VP.promptDialog('Rename provider configuration', { label: 'Configuration name', value: button.dataset.name || '', confirmText: 'Rename' });
        if (!nickname) return;
        await api(`/credentials/${encodeURIComponent(button.dataset.id)}`, { method: 'PATCH', body: { nickname } });
        window.VP.toast('Provider configuration renamed.', 'success');
        await loadCredentials();
      } else if (button.classList.contains('ai-delete')) {
        const confirmed = await window.VP.confirmDialog(`Delete the saved provider configuration “${button.dataset.name}”? This removes its encrypted key from this account and cannot be undone.`, { title: 'Delete provider configuration?', confirmText: 'Delete configuration' });
        if (!confirmed) return;
        await api(`/credentials/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE' });
        window.VP.toast('Provider configuration deleted.', 'success');
        await loadCredentials();
      }
    } catch (error) { window.VP.toast(window.VP.errorMessage(error), 'error'); }
    finally { button.disabled = false; }
  });
  $('aiSaveTools').addEventListener('click', async () => {
    try {
      const permissions = Object.fromEntries([...$('aiTools').querySelectorAll('[data-tool]')].map((input) => [input.dataset.tool, input.checked]));
      await api('/tools', { method: 'PUT', body: { permissions } });
      $('aiToolsStatus').textContent = 'Tool permissions saved.';
    } catch (error) { $('aiToolsStatus').textContent = error.message; }
  });
  Promise.all([api('/providers').then((data) => { state.providers = data.providers || []; updateProviderFields(); }), loadCredentials(), loadTools(), loadHistory()]).catch((error) => { $('aiActiveStatus').textContent = error.message; });
})();
