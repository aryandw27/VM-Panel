(() => {
  const TOKEN_RE = /eyJ[A-Za-z0-9_-]{80,}=*/;
  const jobStates = new Map();

  const setStatus = (card, message, isError) => {
    const target = card.querySelector('[data-role="status"]');
    if (!target) return;
    target.hidden = !message;
    target.textContent = message || '';
    target.classList.toggle('is-error', Boolean(isError));
    target.classList.toggle('is-ok', !isError);
  };

  async function pollJob(jobId, card, onDone) {
    let since = 0;
    let failures = 0;
    for (;;) {
      try {
        const response = await fetch(`/apps/api/installs/${encodeURIComponent(jobId)}?since=${since}`);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) {
          failures += 1;
        } else {
          failures = 0;
          const job = payload.job || {};
          since = job.total || since;
          const running = job.status === 'running';
          setStatus(card, running
            ? (job.phase === 'cloudflared' ? 'Cloudflare Tunnel installing…' : 'Working…')
            : (job.status === 'success' ? 'Finished — reloading…' : `Finished: ${job.status}`), job.status !== 'success' && !running);
          if (!running) {
            onDone(job);
            return job.status === 'success';
          }
        }
      } catch (_) {
        failures += 1;
      }
      if (failures >= 6) {
        setStatus(card, 'Lost contact with the panel while waiting for this job. Reload to check its current state.', true);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 1400));
    }
  }

  function handlePortForm(card, form, installId) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const field = form.querySelector('[data-field="preferredHostPort"]');
      const raw = field ? String(field.value).trim() : '';
      const body = {};
      if (raw) {
        if (!/^\d+$/.test(raw) || Number(raw) < 1024 || Number(raw) > 65535) {
          setStatus(card, 'Enter a port number between 1024 and 65535, or leave it empty to auto-allocate.', true);
          return;
        }
        body.preferredHostPort = Number(raw);
      }
      setStatus(card, 'Updating the public port mapping…');
      try {
        const response = await fetch(`/apps/api/installs/${encodeURIComponent(installId)}/port`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) {
          setStatus(card, payload.error || 'The port mapping could not be changed.', true);
          return;
        }
        setStatus(card, 'Port mapped — reloading…');
        setTimeout(() => window.location.reload(), 900);
      } catch (_) {
        setStatus(card, 'Network error — the port mapping was not changed.', true);
      }
    });
  }

  function handleTunnelForm(card, form, installId) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (jobStates.get(installId) === 'busy') {
        setStatus(card, 'A tunnel installation is already running for this app.', true);
        return;
      }
      const field = form.querySelector('[data-field="cloudflareToken"]');
      const text = field ? field.value.trim() : '';
      if (!TOKEN_RE.test(text)) {
        setStatus(card, 'Paste the full command from dash.cloudflare.com — it must contain the long eyJ… token after "cloudflared service install".', true);
        return;
      }
      setStatus(card, 'Starting the Cloudflare Tunnel installation…');
      try {
        const response = await fetch(`/apps/api/installs/${encodeURIComponent(installId)}/cloudflare`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cloudflareToken: text }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) {
          setStatus(card, payload.error || 'The tunnel installation could not be started.', true);
          return;
        }
        jobStates.set(installId, 'busy');
        form.querySelector('button[type="submit"]').disabled = true;
        const ok = await pollJob(payload.jobId, card, () => {});
        jobStates.set(installId, 'done');
        if (ok) setTimeout(() => window.location.reload(), 1200);
      } catch (_) {
        jobStates.delete(installId);
        setStatus(card, 'Network error — the tunnel installation was not started.', true);
      }
    });
  }

  async function handleLog(card, installId) {
    const target = card.querySelector('[data-role="log"]');
    if (!target) return;
    if (!target.hidden) {
      target.hidden = true;
      return;
    }
    setStatus(card, 'Loading installation log…');
    try {
      const response = await fetch(`/apps/api/installs/${encodeURIComponent(installId)}?since=0`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        setStatus(card, payload.error || 'The installation log could not be loaded.', true);
        return;
      }
      const logs = Array.isArray(payload.job && payload.job.logs) ? payload.job.logs : [];
      const total = (payload.job && payload.job.total) || logs.length;
      if (!total) {
        setStatus(card, 'No log output was recorded for this installation.');
        target.hidden = false;
        target.textContent = '(no output)';
        return;
      }
      target.textContent = logs.map((chunk) => `[${chunk.t === 'err' ? 'stderr' : chunk.t === 'info' ? 'info' : 'stdout'}] ${chunk.s}`).join('');
      target.hidden = false;
      setStatus(card, '');
    } catch (_) {
      setStatus(card, 'Network error — the installation log could not be loaded.', true);
    }
  }

  function handleCopy(card, installId) {
    const lines = [`Installed app #${installId}`];
    for (const row of card.querySelectorAll('.installed-apps-summary-row, .installed-apps-meta .app-store-summary-row')) {
      const label = row.querySelector('span');
      const value = row.querySelector('b');
      if (label && value) lines.push(`${label.textContent}: ${value.textContent}`);
    }
    const message = card.querySelector('.installed-apps-message');
    if (message) lines.push(message.textContent);
    const text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => setStatus(card, 'Copied the installation details to your clipboard.'),
        () => setStatus(card, 'Copy failed — select the text manually.', true),
      );
    } else {
      setStatus(card, 'Clipboard is unavailable in this browser.', true);
    }
  }

  document.querySelectorAll('.installed-apps-card[data-install-id]').forEach((card) => {
    const installId = card.getAttribute('data-install-id');
    card.querySelectorAll('.installed-apps-form').forEach((form) => {
      const action = form.getAttribute('data-action');
      if (action === 'port') handlePortForm(card, form, installId);
      if (action === 'cloudflare') handleTunnelForm(card, form, installId);
    });
    card.querySelectorAll('button[data-action]').forEach((button) => {
      const action = button.getAttribute('data-action');
      button.addEventListener('click', () => {
        if (action === 'log') handleLog(card, installId);
        if (action === 'copy') handleCopy(card, installId);
      });
    });
  });

  // app-store.js reports finished background installs by calling this hook.
  window.refreshInstalledApps = window.refreshInstalledApps || (() => window.location.reload());
})();
