(() => {
  const $ = (id) => document.getElementById(id);
  const drawer = $('vpAiDrawer');
  if (!drawer) return;
  const state = { conversations: [], current: null, busy: false };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  function open() {
    drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); $('vpAiBackdrop').hidden = false; $('vpAiInput').focus();
    loadThreads().catch(showError);
    refreshProviderStatus().catch(() => {});
  }
  async function refreshProviderStatus() {
    const dot = $('vpAiStatusDot');
    const setup = $('vpAiSetupPrompt');
    try {
      const data = await api('/credentials');
      const active = (data.credentials || []).find((c) => c.active);
      const label = active ? `${active.provider} · ${active.model}` : 'Bring your own API key';
      $('vpAiProviderStatus').textContent = label;
      if (dot) dot.dataset.state = active ? 'ready' : 'setup';
      if (setup) setup.hidden = Boolean(active);
    } catch (_) {
      if (dot) dot.dataset.state = 'unknown';
    }
  }
  function close() { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); $('vpAiBackdrop').hidden = true; $('vpAiLaunch').focus(); }
  function inlineMarkdown(text) {
    
    
    return esc(text)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  
  
  function groupTableBlocks(lines) {
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].includes('|') && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim()) && lines[i + 1].includes('-')) {
        const table = [lines[i], lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].includes('|')) { table.push(lines[i]); i += 1; }
        blocks.push({ table: true, lines: table });
        continue;
      }
      const start = i;
      while (i < lines.length && !(lines[i].includes('|') && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim()) && lines[i + 1].includes('-'))) i += 1;
      blocks.push({ table: false, lines: lines.slice(start, i) });
    }
    return blocks;
  }
  function renderTable(lines) {
    const rows = lines.map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
    const head = rows[0] || [];
    const body = rows.slice(2).filter((row) => row.some((cell) => cell));
    const renderRow = (cells, cell) => `<tr>${cells.map((c) => `<${cell}>${inlineMarkdown(c)}</${cell}>`).join('')}</tr>`;
    return `<div class="vp-ai-table-wrap"><table class="vp-ai-table"><thead>${renderRow(head, 'th')}</thead><tbody>${body.map((row) => renderRow(row, 'td')).join('')}</tbody></table></div>`;
  }
  function renderMarkdown(text) {
    const source = String(text || '');
    const parts = source.split(/```([\w-]*)\n([\s\S]*?)```/g);
    return parts.map((part, index) => {
      if (index % 3 === 2) return `<pre><button class="vp-ai-code-copy" type="button" data-copy-code>Copy code</button><code>${esc(part)}</code></pre>`;
      if (index % 3 === 1) return '';
      const out = [];
      for (const block of groupTableBlocks(esc(part).split('\n'))) {
        if (block.table) { out.push(renderTable(block.lines)); continue; }
        for (const line of block.lines) {
          if (/^#{1,3} /.test(line)) { out.push(`<p><strong>${inlineMarkdown(line.replace(/^#{1,3} /, ''))}</strong></p>`); continue; }
          if (/^---+$/.test(line.trim())) { out.push('<hr>'); continue; }
          if (/^\d+[.)] /.test(line)) { out.push(`<p class="vp-ai-list-item"><span class="vp-ai-list-num">${esc(line.match(/^\d+/)[0])}.</span> ${inlineMarkdown(line.replace(/^\d+[.)] /, ''))}</p>`); continue; }
          if (/^[-*] /.test(line)) { out.push(`<p>• ${inlineMarkdown(line.slice(2))}</p>`); continue; }
          out.push(line ? `<p>${inlineMarkdown(line)}</p>` : '<br>');
        }
      }
      return out.join('');
    }).join('');
  }
  function formatCount(n) {
    return Number.isSafeInteger(n) ? n.toLocaleString('en-US') : null;
  }
  
  
  function usageLine(usage) {
    const has = usage && (Number.isFinite(usage.input_tokens) || Number.isFinite(usage.output_tokens));
    if (!has) return `<div class="vp-ai-usage">Token usage unavailable</div>`;
    const parts = [];
    const input = Number.isFinite(usage.input_tokens) ? formatCount(usage.input_tokens) : null;
    const output = Number.isFinite(usage.output_tokens) ? formatCount(usage.output_tokens) : null;
    if (input !== null) parts.push(`${input} input`);
    if (output !== null) parts.push(`${output} output`);
    const total = (Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0) + (Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0);
    if (input !== null && output !== null) parts.push(`${formatCount(total)} total`);
    return `<div class="vp-ai-usage">Tokens: ${esc(parts.join(' · '))}</div>`;
  }
  function drawMessages(messages = []) {
    const box = $('vpAiMessages');
    if (!messages.length) {
      box.innerHTML = '<div class="vp-ai-empty"><div class="vp-ai-orb"><i data-lucide="sparkles"></i></div><h3>What can I help with?</h3><p>Ask about your panel or an accessible VM. I only inspect resources when needed.</p><a href="/settings/ai">Configure a provider key</a></div>';
      return;
    }
    box.innerHTML = messages.map((message) => {
      const tools = message.tool_activity || [];
      const activity = tools.length ? `<details class="vp-ai-tools"><summary>Tools used · ${tools.length} · ${esc(tools.every((t) => t.status === 'success' || t.status === 'no_op') ? 'all succeeded' : tools.some((t) => t.status === 'error') ? 'attention needed' : 'in progress')}</summary>${tools.map((item) => `<div class="vp-ai-tool-note" data-status="${esc(item.status)}"><span class="vp-ai-tool-dot" aria-hidden="true"></span>${esc(item.name.replaceAll('_', ' '))}${item.target ? ` · VM ${esc(item.target)}` : ''} · ${esc(item.status.replaceAll('_', ' '))}</div>`).join('')}</details>` : '';
      const usage = message.role === 'assistant' ? usageLine(message.usage) : '';
      return `<article class="vp-ai-message ${message.role === 'user' ? 'user' : 'assistant'}">${message.role === 'user' ? esc(message.content).replace(/\n/g, '<br>') : renderMarkdown(message.content)}${activity}${usage}${message.role === 'assistant' ? `<div class="vp-ai-msg-actions"><button type="button" data-copy-message="${esc(message.content)}">Copy response</button></div>` : ''}</article>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }
  async function loadThreads() {
    const data = await api('/conversations');
    state.conversations = data.conversations || [];
    const select = $('vpAiThreads');
    select.innerHTML = '<option value="">Choose a conversation</option>' + state.conversations.map((c) => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('');
    select.value = state.current || '';
    if (state.current) await openConversation(state.current);
  }
  async function openConversation(id) {
    if (!id) { state.current = null; drawMessages(); return; }
    const data = await api(`/conversations/${encodeURIComponent(id)}`);
    state.current = data.conversation.id;
    $('vpAiThreads').value = state.current;
    drawMessages(data.messages || []);
    const approvals = await api(`/conversations/${encodeURIComponent(id)}/approvals`);
    (approvals.approvals || []).reverse().forEach(renderApproval);
  }
  const operationNames = { start_vm: 'Start VM', stop_vm: 'Stop VM', restart_vm: 'Restart VM', list_files: 'List files', read_file: 'Read file', search_files: 'Search files', write_file: 'Write file', create_directory: 'Create directory', rename_file: 'Rename file', delete_file: 'Delete file' };
  function renderApproval(approval) {
    const box = $('vpAiMessages');
    const existing = box.querySelector(`[data-approval-card="${CSS.escape(approval.approval_id)}"]`);
    if (existing) existing.remove();
    const pending = approval.status === 'pending';
    const consequence = approval.operation === 'start_vm'
      ? 'This starts the selected QEMU virtual machine.'
      : approval.operation === 'stop_vm'
        ? 'This stops the VM. Applications may be interrupted and unsaved work may be lost.'
        : 'This restarts the VM. Applications may be interrupted and unsaved work may be lost.';
    const result = approval.result?.message || (approval.result?.category ? `Result: ${approval.result.category}` : '');
    const card = document.createElement('section');
    card.className = 'vp-ai-approval';
    card.dataset.approvalCard = approval.approval_id;
    card.innerHTML = `<div class="vp-ai-approval-title">Approval ${pending ? 'required' : esc(approval.status)}</div><p><strong>${esc(operationNames[approval.operation] || approval.operation)} · ${esc(approval.vm_name)} (VM ${esc(approval.vm_id)})</strong></p><p>${esc(approval.impact || consequence)}</p>${approval.explanation ? `<p class="vp-ai-approval-explanation">${esc(approval.explanation)}</p>` : ''}${approval.expires_at && pending ? `<small>Expires ${esc(new Date(approval.expires_at).toLocaleString())}</small>` : ''}${result ? `<p class="vp-ai-approval-result" role="status">${esc(result)}${approval.result?.state ? ` · final state: ${esc(approval.result.state)}` : ''}</p>` : ''}<div class="vp-ai-approval-actions">${pending ? `<button type="button" data-approval-action="approve" data-approval-id="${esc(approval.approval_id)}">Approve &amp; execute</button><button type="button" data-approval-action="reject" data-approval-id="${esc(approval.approval_id)}">Reject</button>` : ''}</div>`;
    box.append(card);
    box.scrollTop = box.scrollHeight;
  }
  function showError(error) {
    $('vpAiActivity').hidden = false;
    $('vpAiActivity').textContent = window.VP ? window.VP.errorMessage(error, 'The assistant request failed. Check your provider key and connection in AI settings.') : `${error.message} · Check your provider key and connection in AI settings.`;
  }
  $('vpAiLaunch').addEventListener('click', open);
  window.openVPAI = async (prompt, sendNow = false, options = {}) => {
    open();
    try {
      const body = { title: options.title || 'VM boot log investigation' };
      if (Number.isSafeInteger(Number(options.incidentId))) body.incident_id = Number(options.incidentId);
      const created = await api('/conversations', { method: 'POST', body });
      state.current = created.conversation.id;
      await loadThreads();
      $('vpAiInput').value = String(prompt || '');
      $('vpAiInput').focus();
      if (sendNow) $('vpAiForm').requestSubmit();
    } catch (error) { showError(error); }
  };
  $('vpAiClose').addEventListener('click', close);
  $('vpAiBackdrop').addEventListener('click', close);
  $('vpAiThreads').addEventListener('change', (event) => openConversation(event.target.value).catch(showError));
  $('vpAiNew').addEventListener('click', async () => {
    try {
      const data = await api('/conversations', { method: 'POST', body: { title: 'New conversation' } });
      state.current = data.conversation.id;
      await loadThreads();
      $('vpAiInput').focus();
    } catch (error) { showError(error); }
  });
  $('vpAiRename').addEventListener('click', async () => {
    const conversation = state.conversations.find((item) => item.id === state.current);
    if (!conversation) return;
    const title = await window.VP.promptDialog('Rename conversation', { label: 'Conversation title', value: conversation.title, confirmText: 'Rename' });
    if (!title) return;
    try { await api(`/conversations/${encodeURIComponent(state.current)}`, { method: 'PATCH', body: { title } }); await loadThreads(); }
    catch (error) { showError(error); }
  });
  $('vpAiDelete').addEventListener('click', async () => {
    const conversation = state.conversations.find((item) => item.id === state.current);
    if (!conversation) return;
    const confirmed = await window.VP.confirmDialog(`Delete “${conversation.title}” and all of its messages? This cannot be undone.`, { title: 'Delete conversation?', confirmText: 'Delete conversation' });
    if (!confirmed) return;
    try { await api(`/conversations/${encodeURIComponent(state.current)}`, { method: 'DELETE' }); state.current = null; await loadThreads(); drawMessages(); }
    catch (error) { showError(error); }
  });
  $('vpAiMessages').addEventListener('click', async (event) => {
    const approvalButton = event.target.closest('[data-approval-action]');
    if (approvalButton) {
      const id = approvalButton.dataset.approvalId;
      const card = approvalButton.closest('[data-approval-card]');
      card?.querySelectorAll('[data-approval-action]').forEach((button) => { button.disabled = true; });
      const action = approvalButton.dataset.approvalAction;
      try {
        const data = await api(`/approvals/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
        renderApproval(data.approval);
      } catch (error) {
        if (card) {
          const message = document.createElement('p');
          message.className = 'vp-ai-approval-result'; message.setAttribute('role', 'alert'); message.textContent = window.VP ? window.VP.errorMessage(error) : error.message;
          card.append(message);
          card.querySelectorAll('[data-approval-action]').forEach((button) => { button.disabled = false; });
        }
      }
      return;
    }
    const copyWithLabel = async (text, label) => {
      const ok = window.VP && VP.copyRawText ? await VP.copyRawText(text) : false;
      label.textContent = ok ? 'Copied' : 'Copy unavailable';
    };
    const button = event.target.closest('[data-copy-message]');
    if (button) { await copyWithLabel(button.dataset.copyMessage, button); return; }
    const codeCopy = event.target.closest('[data-copy-code]');
    if (codeCopy) { await copyWithLabel(codeCopy.parentElement.querySelector('code')?.innerText || '', codeCopy); return; }
    const code = event.target.closest('pre');
    if (code && !event.target.closest('button')) {
      if (window.VP && VP.copyRawText) await VP.copyRawText(code.querySelector('code')?.innerText || '');
    }
  });
  
  $('vpAiInput').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (event.isComposing || event.keyCode === 229) return;
    if (event.shiftKey && !event.ctrlKey && !event.metaKey) return; 
    event.preventDefault();
    if (event.repeat) return;
    if ($('vpAiInput').value.trim() && !state.busy) $('vpAiForm').requestSubmit();
  });
  $('vpAiMessages').addEventListener('click', (event) => {
    const suggestion = event.target && event.target.closest ? event.target.closest('[data-ai-suggestion]') : null;
    if (!suggestion) return;
    $('vpAiInput').value = suggestion.dataset.aiSuggestion;
    autoGrow();
    $('vpAiInput').focus();
  });
  function autoGrow() {
    const input = $('vpAiInput');
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight || 0, 160)}px`;
  }
  $('vpAiInput').addEventListener('input', autoGrow);
  $('vpAiForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('vpAiInput');
    const content = input.value.trim();
    if (!content || state.busy) return;
    state.busy = true; $('vpAiSend').disabled = true; $('vpAiSend').setAttribute('aria-busy', 'true'); $('vpAiActivity').hidden = false; $('vpAiActivity').textContent = 'Connecting to your selected provider…';
    try {
      if (!state.current) {
        const created = await api('/conversations', { method: 'POST', body: { title: content.slice(0, 70) } });
        state.current = created.conversation.id;
      }
      input.value = '';
      autoGrow();
      drawMessages([...$('vpAiMessages').querySelectorAll('.vp-ai-message')].map((node) => ({ role: node.classList.contains('user') ? 'user' : 'assistant', content: node.innerText })));
      $('vpAiMessages').insertAdjacentHTML('beforeend', `<article class="vp-ai-message user">${esc(content).replace(/\n/g, '<br>')}</article><article class="vp-ai-message assistant" id="vpAiPending">Thinking…</article>`);
      $('vpAiMessages').scrollTop = $('vpAiMessages').scrollHeight;
      const match = location.pathname.match(/^\/servers\/(\d+)/);
      const context = { page: location.pathname, ...(match ? { deployment_id: Number(match[1]) } : {}) };
      const response = await fetch(`/api/ai/conversations/${encodeURIComponent(state.current)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...(window.VP_TOKEN ? { authorization: `Bearer ${window.VP_TOKEN}` } : {}) }, body: JSON.stringify({ content, context }) });
      if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || `Request failed (${response.status})`); }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let result = null;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const line = frame.split('\n').find((part) => part.startsWith('data: '));
          if (!line) continue;
          const message = JSON.parse(line.slice(6));
          if (message.type === 'provider_request') $('vpAiActivity').textContent = `Contacting ${message.provider} · ${message.model}…`;
          if (message.type === 'tool_running') $('vpAiActivity').textContent = `Running ${message.name.replaceAll('_', ' ')}${message.target ? ` · VM ${message.target}` : ''}${message.approval_required ? ' · approval required before action' : ' · read-only'}`;
          if (message.type === 'tool_complete') $('vpAiActivity').textContent = `${message.name.replaceAll('_', ' ')}${message.target ? ` · VM ${message.target}` : ''} · ${message.status}`;
          if (message.type === 'approval_required') { renderApproval(message); $('vpAiActivity').textContent = `${operationNames[message.operation] || message.operation} · ${message.vm_name} · waiting for your approval`;
          }
          if (message.type === 'error') throw new Error(message.error);
          if (message.type === 'complete') result = message;
        }
      }
      if (!result) throw new Error('The provider connection ended before a response was received.');
      $('vpAiActivity').hidden = true;
      await loadThreads();
      await openConversation(state.current);
    } catch (error) {
      $('vpAiActivity').hidden = false;
      $('vpAiActivity').textContent = error.message;
      $('vpAiMessages').querySelector('#vpAiPending')?.remove();
      if (!input.value) input.value = content;
    } finally { state.busy = false; $('vpAiSend').disabled = false; $('vpAiSend').removeAttribute('aria-busy'); }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') { event.preventDefault(); open(); }
    if (event.key === 'Escape' && drawer.classList.contains('open')) close();
    if (event.key === 'Tab' && drawer.classList.contains('open')) {
      const items = [...drawer.querySelectorAll('button:not(:disabled), a[href], select, textarea, input:not(:disabled)')].filter((item) => item.offsetParent !== null);
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    }
  });
  async function init() {
    if (window.lucide?.createIcons) window.lucide.createIcons();
    const match = location.pathname.match(/^\/servers\/(\d+)/);
    if (match) drawer.dataset.deploymentId = match[1];
  }
  init();
})();
