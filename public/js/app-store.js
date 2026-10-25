(() => {
  const vmSelect = document.getElementById('appStoreVm');
  const status = document.getElementById('appStoreStatus');
  const result = document.getElementById('appStoreResult');
  const customScript = document.getElementById('customInstallScript');
  const sizeLabel = document.getElementById('customScriptSize');
  const configDefs = (() => {
    try { return JSON.parse(document.getElementById('appStoreConfigDefs').textContent) || {}; }
    catch (_) { return {}; }
  })();

  const modal = document.getElementById('appStoreModal');
  const modalEyebrow = document.getElementById('appStoreModalEyebrow');
  const modalTitle = document.getElementById('appStoreModalTitle');
  const modalSub = document.getElementById('appStoreModalSub');
  const configPane = document.getElementById('appStoreConfigPane');
  const installPane = document.getElementById('appStoreInstallPane');
  const targetVm = document.getElementById('appStoreTargetVm');
  const configFields = document.getElementById('appStoreConfigFields');
  const configError = document.getElementById('appStoreConfigError');
  const cfEnabled = document.getElementById('appStoreCfEnabled');
  const cfFields = document.getElementById('appStoreCfFields');
  const cfToken = document.getElementById('appStoreCfToken');
  const cfError = document.getElementById('appStoreCfError');
  const trust = document.getElementById('appStoreTrust');
  const startButton = document.getElementById('appStoreStartInstall');
  const progressBar = document.getElementById('appStoreProgressBar');
  const progressPct = document.getElementById('appStorePct');
  const phaseLabel = document.getElementById('appStorePhase');
  const timerLabel = document.getElementById('appStoreTimer');
  const jobPill = document.getElementById('appStoreJobStatus');
  const consoleBox = document.getElementById('appStoreConsole');
  const autoScroll = document.getElementById('appStoreAutoScroll');
  const logCount = document.getElementById('appStoreLogCount');
  const summaryBox = document.getElementById('appStoreSummary');
  const hideButton = document.getElementById('appStoreHideBtn');
  const closeDoneButton = document.getElementById('appStoreCloseDone');
  const runCustomButton = document.getElementById('runCustomInstall');

  if (!vmSelect || !status || !modal) return;

  const state = {
    appId: null,
    appName: null,
    kind: null,
    jobId: null,
    pollTimer: null,
    startedMs: 0,
    lines: 0,
    total: 0,
    finished: false,
    errorStreak: 0,
  };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  const selectedVm = () => vmSelect.options[vmSelect.selectedIndex];
  const showStatus = (message, kind) => {
    status.hidden = false;
    status.textContent = message;
    status.className = `app-store-status ${kind ? `is-${kind}` : ''}`;
  };
  const clearStatus = () => {
    status.hidden = true;
    status.textContent = '';
  };
  const showConfigError = (message) => {
    configError.hidden = false;
    configError.textContent = message;
  };
  const showCfError = (message) => {
    cfError.hidden = false;
    cfError.textContent = message;
  };
  const hideErrors = () => {
    configError.hidden = true;
    cfError.hidden = true;
  };

  function extractTunnelToken(input) {
    const text = String(input || '').trim();
    const match = text.match(/eyJ[A-Za-z0-9_-]{80,}=*/);
    return match ? match[0] : null;
  }

  // ── Custom script size counter (page section) ─────────────────────────────
  if (customScript && sizeLabel) {
    const updateSize = () => {
      const bytes = new TextEncoder().encode(customScript.value).length;
      sizeLabel.textContent = `${bytes} / ${Math.floor(Number(customScript.getAttribute('maxlength') || 0) / 1024)} KB`;
    };
    customScript.addEventListener('input', updateSize);
    updateSize();
  }

  // ── Modal plumbing ────────────────────────────────────────────────────────
  function openModal() {
    modal.hidden = false;
    document.body.classList.add('app-store-modal-open');
  }
  function closeModal() {
    modal.hidden = true;
    document.body.classList.remove('app-store-modal-open');
  }
  modal.addEventListener('click', (event) => {
    if (event.target.closest('[data-modal-close]')) closeModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) closeModal();
  });

  cfEnabled.addEventListener('change', () => {
    cfFields.hidden = !cfEnabled.checked;
    if (!cfEnabled.checked) cfError.hidden = true;
  });
  trust.addEventListener('change', () => {
    startButton.disabled = !trust.checked;
  });

  // ── Config pane builder ───────────────────────────────────────────────────
  function buildConfigPane(appId, appName) {
    hideErrors();
    configFields.innerHTML = '';
    const fields = Array.isArray(configDefs[appId]) ? configDefs[appId] : [];
    for (const field of fields) {
      const wrap = document.createElement('div');
      wrap.className = 'app-store-field';
      const id = `appStoreField_${field.key}`;
      let input;
      const common = `id="${id}" name="${escapeHtml(field.key)}"`;
      if (Array.isArray(field.options) && field.options.length) {
        const options = field.options.map((option) => {
          const selected = String(option) === String(field.default ?? '') ? ' selected' : '';
          return `<option value="${escapeHtml(option)}"${selected}>${escapeHtml(option)}</option>`;
        }).join('');
        input = `<select ${common} class="form-control">${options}</select>`;
      } else if (field.type === 'password') {
        input = `<input ${common} type="password" class="form-control" placeholder="${field.autoGen ? 'auto-generated' : ''}" />`;
      } else if (field.type === 'email') {
        input = `<input ${common} type="email" class="form-control" placeholder="you@example.com" />`;
      } else {
        input = `<input ${common} type="text" class="form-control" placeholder="${escapeHtml(field.default ? String(field.default) : '')}" />`;
      }
      const requiredMark = field.required ? ' <em class="app-store-req">required</em>' : '';
      const help = field.help ? `<p class="app-store-field-help">${escapeHtml(field.help)}</p>` : '';
      wrap.innerHTML = `<label for="${id}">${escapeHtml(field.label)}${requiredMark}</label>${input}${help}`;
      configFields.appendChild(wrap);
    }
    if (!fields.length) {
      const note = document.createElement('p');
      note.className = 'app-store-no-fields';
      note.textContent = 'This app has no extra options. Check the summary below and start the installation.';
      configFields.appendChild(note);
    }
    const vm = selectedVm();
    targetVm.textContent = `${vm ? vm.textContent : '—'} · ${state.kind === 'custom' ? 'Custom script' : appName}`;
    modalEyebrow.textContent = state.kind === 'custom' ? 'CUSTOM SCRIPT' : 'APP STORE INSTALL';
    modalTitle.textContent = state.kind === 'custom' ? 'Review your script' : `Install ${appName}`;
    modalSub.textContent = state.kind === 'custom'
      ? 'The script below runs as root inside the VM over its SSH connection.'
      : 'Optional setup, and an optional Cloudflare tunnel that installs after the app.';
    trust.checked = false;
    startButton.disabled = true;
    cfEnabled.checked = false;
    cfFields.hidden = true;
  }

  function collectConfig() {
    const values = {};
    for (const input of configFields.querySelectorAll('input, select')) {
      if (!input.name) continue;
      values[input.name] = input.type === 'password' ? input.value : String(input.value).trim();
    }
    return values;
  }

  async function startInstall() {
    hideErrors();
    const vm = selectedVm();
    if (!vm || vm.dataset.status !== 'running') {
      showStatus('Start this VM and wait for SSH access before installing software.', 'error');
      closeModal();
      return;
    }
    const body = {
      appId: state.appId,
      vmId: Number(vm.value),
      confirmed: true,
    };
    if (state.kind === 'custom') {
      const script = customScript ? customScript.value : '';
      if (!script.trim()) {
        showStatus('Enter an installation script first.', 'error');
        closeModal();
        return;
      }
      body.customScript = script;
    } else if (state.kind === 'catalog') {
      body.config = collectConfig();
    }
    if (cfEnabled.checked) {
      const text = cfToken.value.trim();
      if (!extractTunnelToken(text)) {
        showCfError('Paste the full installation command from the Cloudflare dashboard — it must contain the long eyJ… token after "cloudflared service install".');
        return;
      }
      body.cloudflareToken = text;
    }
    startButton.disabled = true;
    startButton.textContent = 'Starting…';
    try {
      const response = await fetch('/apps/api/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        const message = payload.error || 'The installation could not be started.';
        if (state.kind === 'custom') showStatus(message, 'error');
        else showConfigError(message);
        startButton.disabled = !trust.checked;
        startButton.textContent = 'Start installation';
        return;
      }
      beginInstallView(payload.jobId, payload.job);
    } catch (_) {
      const message = 'Network error — the installation could not be started.';
      if (state.kind === 'custom') showStatus(message, 'error');
      else showConfigError(message);
      startButton.disabled = !trust.checked;
      startButton.textContent = 'Start installation';
    }
  }
  startButton.addEventListener('click', startInstall);

  // ── Install pane (console + progress + summary) ───────────────────────────
  function setProgress(pct) {
    const bounded = Math.max(0, Math.min(100, pct));
    progressBar.style.width = `${bounded}%`;
    progressPct.textContent = `${Math.round(bounded)}%`;
  }
  function progressFor(elapsedMs, lines) {
    const timePart = Math.min(1, elapsedMs / (6.5 * 60 * 1000));
    const activityPart = 1 - Math.exp(-lines / 70);
    return 5 + 90 * (0.55 * timePart + 0.45 * activityPart);
  }
  function formatClock(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  function nodeForChunk(kind, text) {
    const line = document.createElement('div');
    line.className = `ln ln-${kind === 'err' ? 'err' : kind === 'info' ? 'info' : 'out'}`;
    line.textContent = text.replace(/\r/g, '\n').replace(/\n+$/, '');
    return line;
  }
  function appendLogs(logs) {
    if (!Array.isArray(logs) || !logs.length) return;
    const atBottom = consoleBox.scrollTop + consoleBox.clientHeight >= consoleBox.scrollHeight - 24;
    for (const chunk of logs) {
      consoleBox.appendChild(nodeForChunk(chunk.t, chunk.s));
      state.lines += String(chunk.s || '').replace(/\r/g, '\n').split('\n').length;
    }
    while (consoleBox.childNodes.length > 4000) consoleBox.removeChild(consoleBox.firstChild);
    logCount.textContent = `${state.lines} lines`;
    if (autoScroll.checked || atBottom) {
      consoleBox.scrollTop = consoleBox.scrollHeight;
    }
  }
  function beginInstallView(jobId, job) {
    state.jobId = jobId;
    state.finished = false;
    state.errorStreak = 0;
    state.lines = 0;
    state.total = 0;
    state.startedMs = Date.parse(job && job.startedAt ? job.startedAt : new Date().toISOString()) || Date.now();
    configPane.hidden = true;
    installPane.hidden = false;
    summaryBox.hidden = true;
    summaryBox.innerHTML = '';
    hideButton.hidden = false;
    closeDoneButton.hidden = true;
    consoleBox.innerHTML = '';
    setProgress(4);
    progressPct.textContent = '4%';
    phaseLabel.textContent = 'Installing…';
    jobPill.textContent = 'running';
    jobPill.className = 'app-store-status-pill is-running';
    modalTitle.textContent = state.kind === 'custom' ? 'Custom script installation' : `Installing ${state.appName}`;
    modalEyebrow.textContent = 'LIVE PROGRESS';
    modalSub.textContent = 'You can hide this window — the installation continues on the server.';
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollJob, 1200);
    pollJob();
  }
  async function pollJob() {
    if (!state.jobId || state.finished) return;
    try {
      const response = await fetch(`/apps/api/installs/${encodeURIComponent(state.jobId)}?since=${state.total}`);
      state.errorStreak = 0;
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        finishView({ status: 'failed', result: { errorMessage: payload.error || 'The install job is gone.' } });
        return;
      }
      const job = payload.job || {};
      state.total = job.total || state.total;
      appendLogs(job.logs);
      const elapsed = Date.now() - state.startedMs;
      timerLabel.textContent = formatClock(elapsed);
      if (job.status === 'running') {
        setProgress(progressFor(elapsed, state.lines));
        phaseLabel.textContent = job.phase === 'cloudflared' ? 'Cloudflare Tunnel phase…'
          : job.kind === 'cloudflared' ? 'Installing cloudflared…' : 'Installing…';
        jobPill.textContent = 'running';
        jobPill.className = 'app-store-status-pill is-running';
      } else {
        finishView(job);
      }
    } catch (_) {
      state.errorStreak += 1;
      if (state.errorStreak >= 5) {
        finishView({ status: 'failed', result: { errorMessage: 'Lost contact with the panel while polling the installation.' } });
      }
    }
  }
  function finishView(job) {
    state.finished = true;
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    const failed = job.status !== 'success';
    setProgress(100);
    phaseLabel.textContent = failed ? 'Finished with errors' : 'Finished';
    jobPill.textContent = failed ? (job.status === 'stale' ? 'stale' : 'failed') : 'success';
    jobPill.className = `app-store-status-pill ${failed ? 'is-failed' : 'is-success'}`;
    hideButton.hidden = true;
    closeDoneButton.hidden = false;
    renderSummary(job.result || {}, failed);
  }
  function renderSummary(overview, failed) {
    const rows = [];
    const row = (label, value, cls) => {
      if (value === undefined || value === null || value === '') return;
      rows.push(`<div class="app-store-summary-row"><span>${label}</span><b class="${cls || ''}">${value}</b></div>`);
    };
    const noteBlock = (text, cls) => {
      if (!text) return '';
      return `<p class="app-store-summary-note ${cls || ''}">${escapeHtml(text)}</p>`;
    };
    const cf = overview.cloudflare || {};
    const banner = failed
      ? `<div class="app-store-summary-banner is-error"><strong>${escapeHtml(overview.errorMessage || 'The installation failed.')}</strong></div>`
      : cf.status === 'failed'
        ? `<div class="app-store-summary-banner is-warn"><strong>The app installed, but the Cloudflare tunnel failed:</strong> ${escapeHtml(cf.error || '')}</div>`
        : '';
    if (overview.kind === 'openclaw' && overview.openClawToken) {
      rows.push('<div class="app-store-summary-row"><span>Gateway token</span><b class="app-store-mono" id="appStoreOpenClawToken">' + escapeHtml(overview.openClawToken) + '</b></div>');
      rows.push('<div class="app-store-summary-row app-store-wide"><span>Also saved to</span><b>/opt/siliconhost-apps/openclaw/.env on the VM</b></div>');
    }
    row('App', overview.appName);
    if (overview.guestPort) row('Guest port', `:${overview.guestPort}`);
    if (overview.hostPort) row('Public (host) port', `:${overview.hostPort}`);
    if (overview.hostPort) {
      const scheme = overview.scheme === 'https' ? 'https' : 'http';
      rows.push(`<div class="app-store-summary-row"><span>Open after VM restart</span><b>${scheme}://&lt;your-panel-host&gt;:${overview.hostPort}</b></div>`);
      row('Port mapping activation', 'Restart the VM to apply it');
    }
    for (const credential of overview.credentials || []) {
      rows.push(`<div class="app-store-summary-row"><span>${escapeHtml(credential.label)}</span><b class="app-store-mono">${escapeHtml(credential.value)}</b></div>`);
    }
    for (const [key, value] of Object.entries(overview.config || {})) {
      row(key, escapeHtml(String(value)));
    }
    if (cf.status === 'done') {
      row('Cloudflare Tunnel', 'installed — map your hostname in the Zero Trust dashboard');
      if (cf.note) rows.push(`<div class="app-store-summary-row app-store-wide"><span>Next step</span><b>${escapeHtml(cf.note)}</b></div>`);
    } else if (cf.status === 'failed') {
      row('Cloudflare Tunnel', 'failed (see console)');
    }
    const parts = [];
    parts.push(banner);
    parts.push(`<h4>Installation summary</h4>`);
    parts.push(`<div class="app-store-summary-grid">${rows.join('')}</div>`);
    if (overview.message) parts.push(noteBlock(overview.message, 'is-message'));
    if (!failed && overview.kind === 'cloudflared') {
      parts.push(noteBlock('Check the tunnel with: systemctl status cloudflared — then map hostnames to services in dash.cloudflare.com.', 'is-message'));
    }
    summaryBox.innerHTML = parts.filter(Boolean).join('');
    summaryBox.hidden = false;
    if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();
    if (window.refreshInstalledApps) window.refreshInstalledApps();
  }
  hideButton.addEventListener('click', () => {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    closeModal();
    showStatus('The installation keeps running on the server. Track it in the Installed Apps page for this VM.', 'ok');
  });
  closeDoneButton.addEventListener('click', () => {
    closeModal();
    clearStatus();
  });

  // ── Launch buttons ────────────────────────────────────────────────────────
  function guardVmOrBail() {
    const vm = selectedVm();
    if (vm && vm.dataset.status !== 'running') {
      showStatus('Start this VM and wait for SSH access before installing software.', 'error');
      return false;
    }
    clearStatus();
    return true;
  }

  document.querySelectorAll('.app-store-launch').forEach((button) => {
    button.addEventListener('click', () => {
      if (!guardVmOrBail()) return;
      state.appId = button.dataset.appId;
      state.appName = button.dataset.appName;
      state.kind = 'catalog';
      buildConfigPane(state.appId, state.appName);
      configPane.hidden = false;
      installPane.hidden = true;
      summaryBox.hidden = true;
      openModal();
    });
  });

  if (runCustomButton && customScript) {
    runCustomButton.addEventListener('click', () => {
      if (!customScript.value.trim()) {
        showStatus('Enter an installation script first.', 'error');
        return;
      }
      if (!guardVmOrBail()) return;
      state.appId = 'custom';
      state.appName = 'Custom script';
      state.kind = 'custom';
      buildConfigPane('custom', 'Custom script');
      configPane.hidden = false;
      installPane.hidden = true;
      summaryBox.hidden = true;
      openModal();
    });
  }
})();
