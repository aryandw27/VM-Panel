(() => {
  const initialElement = document.getElementById('discordLoggingInitial');
  const rows = document.getElementById('discordRoutes');
  const form = document.getElementById('discordLoggingForm');
  if (!initialElement || !rows || !form) return;

  const initial = JSON.parse(initialElement.textContent || '{}');
  const status = document.getElementById('discordFormStatus');
  const botStatus = document.getElementById('discordBotStatus');
  const guildHint = document.getElementById('discordGuildHint');
  let guilds = initial.guilds || [];
  const channelCache = new Map();
  const events = initial.events || [];
  const labels = {
    'vm:create': 'VM created', 'vm:start': 'VM started', 'vm:stop': 'VM stopped',
    'vm:kill': 'VM force-stopped', 'vm:delete': 'VM deleted', 'vm:update': 'VM updated',
    'vm:app_install': 'App installed', 'backup:create': 'Backup created',
    'backup:restore': 'Backup restored', 'backup:delete': 'Backup deleted',
    'auth:login': 'User login', 'auth:login_success': 'Successful login',
    'auth:login_failed': 'Failed login', 'auth:failed_login': 'Failed login',
    'auth:register': 'User registered', 'admin:user_create': 'Admin created user',
    'admin:user_delete': 'Admin deleted user', 'admin:user_suspend': 'User suspended',
    'admin:security_ip_block': 'IP blocked', 'admin:security_rate_limit_update': 'Rate limit updated',
  };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function setStatus(message, kind = '') {
    status.textContent = message;
    status.className = `logging-feedback ${kind ? `is-${kind}` : ''}`;
  }

  function eventOptions(selected) {
    return events.map((event) => {
      const label = labels[event] || event.replace(/[:_]/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
      return `<option value="${escapeHtml(event)}" ${event === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
  }

  function guildOptions(selected) {
    const present = guilds.some((guild) => guild.id === selected);
    const missing = selected && !present
      ? `<option value="${escapeHtml(selected)}" selected>Previously configured server</option>` : '';
    return `<option value="">Choose server</option>${missing}${guilds.map((guild) => `<option value="${escapeHtml(guild.id)}" ${guild.id === selected ? 'selected' : ''}>${escapeHtml(guild.name)}</option>`).join('')}`;
  }

  async function loadChannels(guildId, select, selectedChannel = '') {
    if (!guildId) {
      select.innerHTML = '<option value="">Choose server first</option>';
      select.disabled = true;
      return;
    }
    select.disabled = true;
    select.innerHTML = '<option value="">Loading channels…</option>';
    try {
      let channels = channelCache.get(guildId);
      if (!channels) {
        const response = await fetch(`/admin/logging/api/guilds/${encodeURIComponent(guildId)}/channels`, {
          headers: { Accept: 'application/json' },
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to load channels.');
        channels = data.channels;
        channelCache.set(guildId, channels);
      }
      select.innerHTML = `<option value="">Choose channel</option>${channels.map((channel) => `<option value="${escapeHtml(channel.id)}" ${channel.id === selectedChannel ? 'selected' : ''}># ${escapeHtml(channel.name)}</option>`).join('')}`;
      select.disabled = false;
      if (selectedChannel && !channels.some((channel) => channel.id === selectedChannel)) {
        select.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(selectedChannel)}" selected>Previously configured channel</option>`);
      }
    } catch (error) {
      select.innerHTML = '<option value="">Channels unavailable</option>';
      select.disabled = true;
      setStatus(error.message, 'error');
    }
  }

  function addRoute(route = {}) {
    const row = document.createElement('tr');
    const event = route.event || events[0] || '';
    row.innerHTML = `<td><select class="form-control logging-event" aria-label="Logging event">${eventOptions(event)}</select></td>
      <td><select class="form-control logging-guild" aria-label="Discord server">${guildOptions(route.guildId || '')}</select></td>
      <td><select class="form-control logging-channel" aria-label="Discord channel" disabled><option value="">Choose server first</option></select></td>
      <td><input type="text" class="form-control logging-template" maxlength="1000" aria-label="Message template" value="${escapeHtml(route.template || '{user} · {event} · {server} · {ip}')}"></td>
      <td><input type="color" class="logging-color" aria-label="Embed color" value="${/^#[0-9a-f]{6}$/i.test(route.color || '') ? escapeHtml(route.color) : '#5865F2'}"></td>
      <td><input type="checkbox" class="logging-route-enabled" aria-label="Enable route" ${route.enabled === false ? '' : 'checked'}></td>
      <td><div class="logging-route-actions"><button type="button" class="btn btn-sm btn-outline logging-test">Test</button><button type="button" class="btn btn-sm btn-danger logging-remove" aria-label="Remove route">Remove</button></div></td>`;
    rows.appendChild(row);

    const guild = row.querySelector('.logging-guild');
    const channel = row.querySelector('.logging-channel');
    loadChannels(guild.value, channel, route.channelId || '');
    guild.addEventListener('change', () => loadChannels(guild.value, channel));
    row.querySelector('.logging-remove').addEventListener('click', () => row.remove());
    row.querySelector('.logging-test').addEventListener('click', async () => {
      if (!guild.value || !channel.value) return setStatus('Choose a server and channel before testing.', 'error');
      setStatus('Sending a test message…');
      try {
        const response = await fetch('/admin/logging/api/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ guildId: guild.value, channelId: channel.value }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || 'Test message failed.');
        setStatus('Test message delivered.', 'success');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
  }

  function collectRoutes() {
    return [...rows.querySelectorAll('tr')].map((row) => ({
      event: row.querySelector('.logging-event').value,
      guildId: row.querySelector('.logging-guild').value,
      channelId: row.querySelector('.logging-channel').value,
      template: row.querySelector('.logging-template').value,
      color: row.querySelector('.logging-color').value,
      enabled: row.querySelector('.logging-route-enabled').checked,
    }));
  }

  function renderState(state) {
    guilds = state.guilds || [];
    botStatus.textContent = state.status || 'offline';
    document.getElementById('discordEnabled').checked = state.enabled === true;
    document.getElementById('discordLogoUrl').value = state.avatarUrl || '';
    document.getElementById('discordBotToken').placeholder = state.tokenConfigured
      ? 'Saved securely · leave blank to keep current token'
      : 'Paste the bot token';
    rows.replaceChildren();
    (state.routes || []).forEach(addRoute);
    guildHint.textContent = guilds.length
      ? `Bot connected to ${guilds.length} Discord server${guilds.length === 1 ? '' : 's'}.`
      : 'No servers discovered yet. Invite the bot, enable the Guilds intent, then refresh status.';
    if (state.error) setStatus(state.error, 'error');
  }

  document.getElementById('addLoggingRoute').addEventListener('click', () => addRoute({
    event: events[0],
    guildId: guilds[0]?.id || '',
    template: '{user} · {event} · {server} · {ip}',
    color: '#5865F2',
    enabled: true,
  }));

  document.getElementById('refreshDiscord').addEventListener('click', async () => {
    try {
      const response = await fetch('/admin/logging/api', { headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to refresh bot status.');
      channelCache.clear();
      renderState(data.logging);
      setStatus('Bot status refreshed.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('Saving settings…');
    try {
      const response = await fetch('/admin/logging/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          enabled: document.getElementById('discordEnabled').checked,
          botToken: document.getElementById('discordBotToken').value,
          avatarUrl: document.getElementById('discordLogoUrl').value,
          routes: collectRoutes(),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to save logging settings.');
      document.getElementById('discordBotToken').value = '';
      renderState(data.logging);
      setStatus('Bot settings and routes saved.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  });

  renderState(initial);
})();
