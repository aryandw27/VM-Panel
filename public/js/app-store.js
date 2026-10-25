(() => {
  const vmSelect = document.getElementById('appStoreVm');
  const status = document.getElementById('appStoreStatus');
  const result = document.getElementById('appStoreResult');
  const customScript = document.getElementById('customInstallScript');
  const sizeLabel = document.getElementById('customScriptSize');
  if (!vmSelect || !status || !result) return;

  const selectedVm = () => vmSelect.options[vmSelect.selectedIndex];
  const showStatus = (message, kind) => {
    status.hidden = false;
    status.textContent = message;
    status.className = `app-store-status ${kind ? `is-${kind}` : ''}`;
  };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  async function install(appId, appName, script) {
    const vm = selectedVm();
    if (vm.dataset.status !== 'running') {
      showStatus('Start this VM and wait for SSH access before installing software.', 'error');
      return;
    }
    const notice = appId === 'custom'
      ? 'This script will run as root inside the selected VM. Continue only if you trust every command.'
      : `Install ${appName} on ${vm.textContent.trim()}? The reviewed installer will make changes inside that VM.`;
    if (!window.confirm(notice)) return;

    showStatus(`Installing ${appName}… This can take several minutes. Keep this page open.`, '');
    result.hidden = true;
    document.querySelectorAll('.app-store-launch,#runCustomInstall').forEach((button) => { button.disabled = true; });
    try {
      const response = await fetch('/apps/api/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          confirmed: true,
          vmId: vm.value,
          appId,
          ...(script !== undefined ? { customScript: script } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Installation failed.');
      showStatus(`${appName} installed successfully.`, 'success');
      renderResult(data.result, vm, appName);
    } catch (error) {
      showStatus(error.message || 'Installation failed. Check the VM SSH connection and try again.', 'error');
    } finally {
      document.querySelectorAll('.app-store-launch,#runCustomInstall').forEach((button) => { button.disabled = false; });
    }
  }

  function renderResult(info, vm, appName) {
    result.hidden = false;
    if (info.appId === 'wordpress') {
      result.innerHTML = `<h2>WordPress is running in your VM</h2>
        <p>Guest port <code>${info.guestPort}</code> is mapped to host port <code>${info.hostPort}</code>. Restart the VM to activate this QEMU port mapping, then visit <code>http://&lt;your-panel-host&gt;:${info.hostPort}</code> to finish WordPress setup. Allow the selected port through your host firewall if needed.</p>`;
    } else if (info.appId === 'openclaw') {
      const tunnel = `ssh -N -L 18789:127.0.0.1:18789 -p ${vm.dataset.sshPort} ${vm.dataset.username}@<PANEL_HOST>`;
      result.innerHTML = `<h2>OpenClaw gateway is installed</h2>
        <p>OpenClaw is not publicly exposed. On your computer, create a private SSH tunnel through your VM:</p>
        <pre>${escapeHtml(tunnel)}</pre>
        <p>Then open <code>http://localhost:18789</code>, configure a model provider, and paste this one-time gateway token when prompted:</p>
        <pre id="openClawToken">${escapeHtml(info.openClawToken || '')}</pre>
        <button type="button" class="btn btn-outline" id="copyOpenClawToken">Copy gateway token</button>
        <p class="muted">Save the token in a password manager. It is not shown again after leaving this page.</p>`;
      document.getElementById('copyOpenClawToken')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(info.openClawToken || '');
          showStatus('OpenClaw gateway token copied.', 'success');
        } catch (_) {
          showStatus('Clipboard access is unavailable; select and copy the token above.', 'error');
        }
      });
    } else if (info.appId === 'custom') {
      result.innerHTML = '<h2>Custom installer completed</h2><p>The script finished successfully. Verify the application and its services inside your VM.</p>';
    } else {
      const title = appName && appName !== 'custom script' ? `${appName} installed` : 'Installer completed';
      const message = typeof info.message === 'string' && info.message.trim()
        ? info.message
        : 'The installer finished successfully. Verify the application and its services inside your VM.';
      result.innerHTML = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>`;
    }
    result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  document.querySelectorAll('.app-store-launch').forEach((button) => {
    button.addEventListener('click', () => install(button.dataset.appId, button.dataset.appName));
  });
  document.getElementById('runCustomInstall')?.addEventListener('click', () => {
    const source = customScript.value;
    if (!source.trim()) return showStatus('Enter a shell script to run.', 'error');
    install('custom', 'custom script', source);
  });
  customScript?.addEventListener('input', () => {
    const size = new Blob([customScript.value]).size;
    sizeLabel.textContent = `${(size / 1024).toFixed(1)} / ${Math.floor(Number(customScript.max) / 1024)} KB`;
    if (size > Number(customScript.max)) sizeLabel.textContent += ' · over limit';
  });
})();
