(function () {
  const root = document.documentElement;
  const page = document.getElementById('themePage');
  if (!page) return;
  const registry = new Map((window.VP_BUILT_IN_THEMES || []).map((theme) => [theme.id, theme]));
  let saved = page.dataset.selectedTheme || 'default';
  const defaultMode = root.dataset.theme || 'dark';
  let preview = null;
  const previewBar = document.getElementById('themePreviewBar');
  const status = document.getElementById('themeStatus');
  const statusText = status.querySelector('span:last-child');
  const statusName = document.getElementById('themeStatusName');

  function setVisual(themeId) {
    const theme = registry.get(themeId) || registry.get('default');
    root.dataset.panelTheme = theme.id;
    root.dataset.theme = theme.id === 'default' ? defaultMode : theme.mode;
  }
  function setPreview(themeId) {
    preview = themeId;
    setVisual(themeId);
    previewBar.hidden = false;
    document.getElementById('themePreviewName').textContent = registry.get(themeId).name;
    document.querySelectorAll('.theme-card').forEach((card) => {
      const active = card.dataset.themeCard === themeId;
      card.classList.toggle('is-previewing', active);
      card.querySelector('[data-theme-preview]').setAttribute('aria-pressed', String(active));
    });
  }
  function clearPreview() {
    preview = null;
    setVisual(saved);
    previewBar.hidden = true;
    document.querySelectorAll('.theme-card').forEach((card) => {
      card.classList.remove('is-previewing');
      card.querySelector('[data-theme-preview]').setAttribute('aria-pressed', 'false');
    });
  }
  document.querySelectorAll('[data-theme-preview]').forEach((button) => {
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => setPreview(button.dataset.themePreview));
  });
  document.getElementById('themeCancelPreview').addEventListener('click', clearPreview);
  document.querySelectorAll('[data-theme-apply]').forEach((button) => button.addEventListener('click', async () => {
    const themeId = button.dataset.themeApply;
    button.disabled = true;
    status.classList.remove('is-error');
    statusText.textContent = 'Saving…';
    try {
      const response = await fetch('/api/account/theme', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ themeId }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Unable to save this theme');
      page.dataset.selectedTheme = result.themeId;
      saved = result.themeId;
      setVisual(result.themeId);
      statusName.textContent = registry.get(result.themeId).name;
      statusText.replaceChildren(document.createTextNode('Saved theme: '), statusName);
      previewBar.hidden = true;
      preview = null;
      document.querySelectorAll('.theme-card').forEach((card) => {
        const selected = card.dataset.themeCard === result.themeId;
        card.classList.toggle('is-selected', selected);
        card.classList.remove('is-previewing');
        card.querySelector('[data-theme-apply]').textContent = selected ? 'Selected' : 'Apply';
        card.querySelector('[data-theme-apply]').setAttribute('aria-pressed', String(selected));
      });
      if (window.VP && VP.toast) VP.toast('Appearance preference saved', 'success');
    } catch (error) {
      status.classList.add('is-error');
      statusText.textContent = error.message;
      if (preview) setVisual(preview); else setVisual(saved);
    } finally {
      button.disabled = false;
    }
  }));
})();
