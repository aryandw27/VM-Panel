(() => {
  const TOKENS = [
    '--sh-bg', '--sh-surface', '--sh-surface-raised', '--sh-surface-hover',
    '--sh-border', '--sh-border-strong', '--sh-text', '--sh-text-muted', '--sh-text-subtle',
    '--sh-accent', '--sh-success', '--sh-danger', '--sh-warning',
    '--sh-sidebar-bg', '--sh-sidebar-text', '--sh-sidebar-hover', '--sh-sidebar-hover-text',
    '--sh-sidebar-icon', '--sh-sidebar-muted', '--sh-topbar-bg',
    '--sh-auth-bg', '--sh-auth-card-bg', '--sh-auth-card-border',
  ];

  const DEFAULTS = {
    '--sh-bg': '#000000',
    '--sh-surface': '#070809',
    '--sh-surface-raised': '#0b0d10',
    '--sh-surface-hover': '#12151a',
    '--sh-border': '#1e2126',
    '--sh-border-strong': '#2a2e35',
    '--sh-text': '#f2f4f8',
    '--sh-text-muted': '#9aa4b2',
    '--sh-text-subtle': '#6b7482',
    '--sh-accent': '#8ab4ff',
    '--sh-success': '#6fca9b',
    '--sh-danger': '#e9878d',
    '--sh-warning': '#e3bd72',
    '--sh-sidebar-bg': '#050607',
    '--sh-sidebar-text': '#b1bdca',
    '--sh-sidebar-hover': '#0b0d10',
    '--sh-sidebar-hover-text': '#ffffff',
    '--sh-sidebar-icon': '#8d9aa8',
    '--sh-sidebar-muted': '#6b7482',
    '--sh-topbar-bg': '#050607',
    '--sh-auth-bg': '#000000',
    '--sh-auth-card-bg': '#0a0a0a',
    '--sh-auth-card-border': '#1e2126',
  };

  const PRESETS = [
    { id: 'siliconhost-dark', label: 'SiliconHost Dark', tokens: {} },
    { id: 'amoled-black', label: 'AMOLED Black', tokens: { ...DEFAULTS } },
    {
      id: 'nord',
      label: 'Nord',
      tokens: {
        '--sh-bg': '#2e3440', '--sh-surface': '#333a47', '--sh-surface-raised': '#3b4252',
        '--sh-surface-hover': '#434c5e', '--sh-border': '#434c5e', '--sh-border-strong': '#4c566a',
        '--sh-text': '#eceff4', '--sh-text-muted': '#b9c2cf', '--sh-text-subtle': '#8d97a8',
        '--sh-accent': '#88c0d0', '--sh-success': '#a3be8c', '--sh-danger': '#bf616a',
        '--sh-warning': '#ebcb8b', '--sh-sidebar-bg': '#292e39', '--sh-sidebar-text': '#c0c8d4',
        '--sh-sidebar-hover': '#3b4252', '--sh-sidebar-hover-text': '#eceff4',
        '--sh-sidebar-icon': '#8d97a8', '--sh-sidebar-muted': '#75808f',
        '--sh-topbar-bg': '#2b303c', '--sh-auth-bg': '#232833', '--sh-auth-card-bg': '#2e3440',
        '--sh-auth-card-border': '#434c5e',
      },
    },
    {
      id: 'crimson',
      label: 'Crimson',
      tokens: {
        '--sh-bg': '#0a0309', '--sh-surface': '#120511', '--sh-surface-raised': '#180818',
        '--sh-surface-hover': '#200d1e', '--sh-border': '#33152f', '--sh-border-strong': '#481d41',
        '--sh-text': '#f5e9f2', '--sh-text-muted': '#c2a3bb', '--sh-text-subtle': '#8d6f85',
        '--sh-accent': '#ff4d6d', '--sh-success': '#57bf91', '--sh-danger': '#ff6b80',
        '--sh-warning': '#ffb86c', '--sh-sidebar-bg': '#0d040c', '--sh-sidebar-text': '#d5b8cd',
        '--sh-sidebar-hover': '#180818', '--sh-sidebar-hover-text': '#ffffff',
        '--sh-sidebar-icon': '#a9829c', '--sh-sidebar-muted': '#7a5c72',
        '--sh-topbar-bg': '#0d040c', '--sh-auth-bg': '#070206', '--sh-auth-card-bg': '#120511',
        '--sh-auth-card-border': '#33152f',
      },
    },
    {
      id: 'forest',
      label: 'Forest',
      tokens: {
        '--sh-bg': '#071209', '--sh-surface': '#0c1a10', '--sh-surface-raised': '#112317',
        '--sh-surface-hover': '#17301c', '--sh-border': '#1d3b23', '--sh-border-strong': '#2a5231',
        '--sh-text': '#eef5ef', '--sh-text-muted': '#a8c2ab', '--sh-text-subtle': '#71886f',
        '--sh-accent': '#4ade80', '--sh-success': '#4ade80', '--sh-danger': '#f87171',
        '--sh-warning': '#facc15', '--sh-sidebar-bg': '#060f08', '--sh-sidebar-text': '#bcd4bd',
        '--sh-sidebar-hover': '#112317', '--sh-sidebar-hover-text': '#ffffff',
        '--sh-sidebar-icon': '#87a489', '--sh-sidebar-muted': '#5e7360',
        '--sh-topbar-bg': '#060f08', '--sh-auth-bg': '#040a05', '--sh-auth-card-bg': '#0c1a10',
        '--sh-auth-card-border': '#1d3b23',
      },
    },
  ];

  const GROUPS = [
    { title: 'Base surfaces', tokens: ['--sh-bg', '--sh-surface', '--sh-surface-raised', '--sh-surface-hover', '--sh-border', '--sh-border-strong'] },
    { title: 'Text', tokens: ['--sh-text', '--sh-text-muted', '--sh-text-subtle'] },
    { title: 'Status colors', tokens: ['--sh-accent', '--sh-success', '--sh-danger', '--sh-warning'] },
    { title: 'Sidebar', tokens: ['--sh-sidebar-bg', '--sh-sidebar-text', '--sh-sidebar-hover', '--sh-sidebar-hover-text', '--sh-sidebar-icon', '--sh-sidebar-muted'] },
    { title: 'Topbar & sign-in', tokens: ['--sh-topbar-bg', '--sh-auth-bg', '--sh-auth-card-bg', '--sh-auth-card-border'] },
  ];

  const LABELS = {
    '--sh-bg': 'Page background',
    '--sh-surface': 'Card surface',
    '--sh-surface-raised': 'Raised surface',
    '--sh-surface-hover': 'Hover surface',
    '--sh-border': 'Border',
    '--sh-border-strong': 'Border (strong)',
    '--sh-text': 'Text',
    '--sh-text-muted': 'Muted text',
    '--sh-text-subtle': 'Subtle text',
    '--sh-accent': 'Accent',
    '--sh-success': 'Success',
    '--sh-danger': 'Danger',
    '--sh-warning': 'Warning',
    '--sh-sidebar-bg': 'Sidebar background',
    '--sh-sidebar-text': 'Sidebar text',
    '--sh-sidebar-hover': 'Sidebar hover',
    '--sh-sidebar-hover-text': 'Sidebar hover text',
    '--sh-sidebar-icon': 'Sidebar icon',
    '--sh-sidebar-muted': 'Sidebar section label',
    '--sh-topbar-bg': 'Topbar background',
    '--sh-auth-bg': 'Sign-in background',
    '--sh-auth-card-bg': 'Sign-in card',
    '--sh-auth-card-border': 'Sign-in card border',
  };

  const groupsRoot = document.getElementById('custGroups');
  const presetsRoot = document.getElementById('custPresets');
  const saveButton = document.getElementById('custSave');
  const resetButton = document.getElementById('custReset');
  const statusEl = document.getElementById('custStatus');
  if (!groupsRoot || !presetsRoot) return;

  let saved = (() => {
    try {
      const parsed = JSON.parse(document.getElementById('custOverrides').textContent);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ...parsed };
    } catch (_) {}
    return {};
  })();
  let draft = { ...saved };

  const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  const expandHex = (value) => {
    let text = String(value || '').trim();
    if (!text) return '';
    if (text[0] !== '#') text = `#${text}`;
    if (/^#[0-9a-fA-F]{3}$/.test(text)) {
      text = `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
    }
    return text.toLowerCase();
  };

  const showStatus = (message, ok) => {
    statusEl.hidden = !message;
    statusEl.textContent = message || '';
    statusEl.classList.toggle('is-ok', ok !== false);
    statusEl.classList.toggle('is-error', ok === false);
  };

  function applyPreview() {
    for (const token of TOKENS) {
      if (Object.prototype.hasOwnProperty.call(draft, token)) {
        document.documentElement.style.setProperty(token, draft[token]);
      } else {
        document.documentElement.style.removeProperty(token);
      }
    }
  }

  function valueFor(token) {
    return draft[token] || DEFAULTS[token] || '#000000';
  }

  function syncInputs() {
    for (const row of groupsRoot.querySelectorAll('.admin-custom-row')) {
      const token = row.getAttribute('data-token');
      const colorInput = row.querySelector('input[type="color"]');
      const textInput = row.querySelector('input[type="text"]');
      const value = valueFor(token);
      colorInput.value = value;
      textInput.value = value;
      textInput.classList.remove('is-invalid');
    }
  }

  function buildPresets() {
    presetsRoot.innerHTML = '';
    for (const preset of PRESETS) {
      const base = { ...defaultValueBase(), ...preset.tokens };
      const swatchTokens = [
        base['--sh-bg'], base['--sh-surface-raised'], base['--sh-border'],
        base['--sh-accent'], base['--sh-success'], base['--sh-danger'],
      ];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'admin-custom-preset';
      button.setAttribute('data-preset', preset.id);
      button.innerHTML = `
        <span class="admin-custom-preset-swatch">${swatchTokens.map((color) => `<i style="background:${color}"></i>`).join('')}</span>
        <b>${preset.label}</b>`;
      button.addEventListener('click', () => {
        draft = { ...preset.tokens };
        adoptPresetActive(preset.id);
        syncInputs();
        applyPreview();
        showStatus(`Preset "${preset.label}" loaded — press Save palette to publish it.`);
      });
      presetsRoot.appendChild(button);
    }
    adoptPresetActive(null);
  }

  function defaultValueBase() {
    return { ...DEFAULTS };
  }

  function adoptPresetActive(presetId) {
    let matched = null;
    for (const preset of PRESETS) {
      const keys = new Set([...Object.keys(draft), ...Object.keys(preset.tokens)]);
      let identical = Object.keys(draft).length === Object.keys(preset.tokens).length;
      for (const key of keys) {
        const draftValue = draft[key];
        const presetValue = preset.tokens[key];
        if ((draftValue || DEFAULTS[key]) !== (presetValue || DEFAULTS[key])) {
          identical = false;
          break;
        }
      }
      if (identical) matched = preset.id;
    }
    for (const button of presetsRoot.querySelectorAll('.admin-custom-preset')) {
      button.classList.toggle('is-active', presetId ? button.getAttribute('data-preset') === presetId : button.getAttribute('data-preset') === matched);
    }
  }

  function buildGroups() {
    groupsRoot.innerHTML = '';
    for (const group of GROUPS) {
      const box = document.createElement('div');
      box.className = 'admin-custom-group';
      const heading = document.createElement('h3');
      heading.textContent = group.title;
      box.appendChild(heading);
      for (const token of group.tokens) {
        const row = document.createElement('div');
        row.className = 'admin-custom-row';
        row.setAttribute('data-token', token);
        row.innerHTML = `
          <label for="cust_${token.slice(5)}">${LABELS[token] || token}</label>
          <input type="color" id="cust_${token.slice(5)}" data-token="${token}" />
          <input type="text" data-token="${token}" maxlength="7" spellcheck="false" />`;
        const colorInput = row.querySelector('input[type="color"]');
        const textInput = row.querySelector('input[type="text"]');
        colorInput.addEventListener('input', () => {
          textInput.value = colorInput.value;
          textInput.classList.remove('is-invalid');
          draft[token] = colorInput.value;
          applyPreview();
          adoptPresetActive(null);
        });
        textInput.addEventListener('input', () => {
          const normalized = expandHex(textInput.value);
          if (HEX_RE.test(normalized)) {
            textInput.classList.remove('is-invalid');
            colorInput.value = normalized;
            draft[token] = normalized;
            applyPreview();
            adoptPresetActive(null);
          } else {
            textInput.classList.add('is-invalid');
            delete draft[token];
            applyPreview();
          }
        });
        box.appendChild(row);
      }
      groupsRoot.appendChild(box);
    }
  }

  saveButton.addEventListener('click', async () => {
    const invalid = groupsRoot.querySelector('input[type="text"].is-invalid');
    if (invalid) {
      const row = invalid.closest('.admin-custom-row');
      const label = row ? row.querySelector('label') : null;
      showStatus(`${label ? label.textContent : 'A color'} is not a valid hex value like #8ab4ff.`, false);
      return;
    }
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
      const response = await fetch('/admin/customisation/palette', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides: draft }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        showStatus(payload.error || 'The palette could not be saved.', false);
        return;
      }
      saved = { ...payload.overrides };
      draft = { ...saved };
      adoptPresetActive(null);
      showStatus('Palette saved — every account now sees these colors after a page refresh.');
    } catch (_) {
      showStatus('Network error — the palette was not saved.', false);
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = 'Save palette';
    }
  });

  resetButton.addEventListener('click', async () => {
    resetButton.disabled = true;
    try {
      const response = await fetch('/admin/customisation/palette/reset', { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        showStatus(payload.error || 'The palette could not be reset.', false);
        return;
      }
      saved = {};
      draft = {};
      syncInputs();
      applyPreview();
      adoptPresetActive(null);
      showStatus('Palette cleared — the active themes use their built-in colors again.');
    } catch (_) {
      showStatus('Network error — the palette was not reset.', false);
    } finally {
      resetButton.disabled = false;
    }
  });

  buildGroups();
  buildPresets();
  syncInputs();
  applyPreview();
})();
