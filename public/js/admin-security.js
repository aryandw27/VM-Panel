(function () {
  const rateLimitForm = document.getElementById('rateLimitForm');
  const blockIpForm = document.getElementById('blockIpForm');
  if (!rateLimitForm || !blockIpForm) return;

  function showMessage(elementId, message, isError) {
    const element = document.getElementById(elementId);
    element.textContent = message;
    element.className = `security-form-message is-visible ${isError ? 'is-error' : 'is-success'}`;
  }

  async function sendJson(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'Request failed');
    return result;
  }

  rateLimitForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = rateLimitForm.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const form = new FormData(rateLimitForm);
      await sendJson('/admin/security/api/config', {
        enabled: form.has('enabled'),
        maxRequests: Number(form.get('maxRequests')),
        windowSeconds: Number(form.get('windowSeconds')),
        punishmentSeconds: Number(form.get('punishmentSeconds')),
      });
      showMessage('securityFormMessage', 'Rate limit settings saved.', false);
    } catch (error) {
      showMessage('securityFormMessage', error.message, true);
    } finally {
      submit.disabled = false;
    }
  });

  blockIpForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = blockIpForm.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const form = new FormData(blockIpForm);
      await sendJson('/admin/security/api/blocks', {
        ip: String(form.get('ip')).trim(),
        durationSeconds: Number(form.get('durationSeconds')),
        reason: String(form.get('reason')).trim(),
      });
      location.reload();
    } catch (error) {
      showMessage('blockFormMessage', error.message, true);
    } finally {
      submit.disabled = false;
    }
  });

  document.querySelectorAll('[data-block-ip]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await sendJson('/admin/security/api/blocks', {
          ip: button.dataset.blockIp,
          durationSeconds: 0,
          reason: 'Manually blocked from request analytics',
        });
        location.reload();
      } catch (error) {
        showMessage('blockFormMessage', error.message, true);
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-unblock-ip]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const response = await fetch(`/admin/security/api/blocks/${encodeURIComponent(button.dataset.unblockIp)}/unblock`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to unblock IP');
        location.reload();
      } catch (error) {
        button.disabled = false;
        showMessage('blockFormMessage', error.message, true);
      }
    });
  });
})();
