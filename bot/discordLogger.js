const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const config = require('../src/lib/config');
const { collections, settings } = require('../src/lib/db');
const logger = require('../src/lib/logger');

const CONFIG_KEY = 'logging.discord';
const TOKEN_KEY = 'logging.discord_token';
const TOKEN_DOMAIN = 'siliconhost-discord-logging-v1';
const DISCORD_API = 'https://discord.com/api/v10';
const EVENTS = [
  'vm:create', 'vm:start', 'vm:stop', 'vm:kill', 'vm:delete', 'vm:update',
  'vm:app_install', 'vm:resize', 'vm:transfer_owner',
  'backup:create', 'backup:restore', 'backup:delete',
  'auth:login', 'auth:login_success', 'auth:login_failed', 'auth:failed_login',
  'auth:register', 'auth:email_verified', 'auth:logout', 'auth:password_reset',
  'auth:impersonate_start', 'auth:impersonate_end', 'auth:tfa_enabled', 'auth:tfa_disabled',
  'admin:user_create', 'admin:user_delete', 'admin:user_suspend', 'admin:user_unsuspend',
  'admin:user_ban', 'admin:user_unban', 'admin:user_status_update', 'admin:user_update',
  'admin:quota_update', 'admin:session_revoke', 'admin:session_revoke_all',
  'admin:security_ip_block', 'admin:security_ip_unblock', 'admin:security_rate_limit_update',
  'admin:logging_config_update', 'admin:settings_update', 'admin:settings_arix_update',
  'admin:cache_auto_config', 'admin:cache_clear', 'admin:node_create',
  'admin:node_delete', 'admin:node_settings_update',
  'api_key:create', 'api_key:revoke', 'webhook:create', 'webhook:delete',
  'billing:coupon_create', 'billing:invoice_create', 'billing:invoice_status',
  'billing:plan_create', 'billing:plan_delete', 'billing:plan_update', 'billing:settings_update',
  'mongodb:backup_export', 'mongodb:backup_import', 'mongodb:collection_create',
  'mongodb:collection_drop', 'mongodb:collection_truncate', 'mongodb:db_create',
  'mongodb:db_drop', 'mongodb:document_delete', 'mongodb:document_insert',
  'mongodb:document_update', 'mongodb:index_create', 'mongodb:index_drop',
  'mongodb:user_create', 'mongodb:user_delete',
  'network:firewall_create', 'network:firewall_delete', 'network:forward_create',
  'network:forward_delete', 'network:pool_create', 'network:pool_delete',
  'plugin:update', 'profile:password_changed',
  'schedule:create', 'schedule:delete', 'schedule:run', 'schedule:update',
  'storage:iso_delete', 'storage:iso_download', 'storage:pool_create',
  'storage:pool_delete', 'storage:volume_create', 'storage:volume_delete',
  'subuser:add', 'subuser:remove', 'system:update_rollback', 'system:update_started',
  'template:sync', 'test:ping',
];
const EVENT_SET = new Set(EVENTS);

function encryptionKey() {
  const secret = String(config.jwtSecret || '');
  if (secret.length < 32 || secret === 'vpanel-insecure-secret-change-me') {
    throw new TypeError('Set a unique JWT_SECRET of at least 32 characters before configuring Discord logging.');
  }
  return crypto.createHash('sha256').update(`${TOKEN_DOMAIN}:${secret}`).digest();
}

function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptToken(encrypted) {
  if (!encrypted || !encrypted.ciphertext || !encrypted.iv || !encrypted.tag) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function normalizeRoutes(input) {
  if (!Array.isArray(input) || input.length > 200) {
    throw new TypeError('Logging routes must be a list of up to 200 entries');
  }
  return input.map((route) => {
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      throw new TypeError('Each logging route must be an object');
    }
    const event = String(route.event || '');
    const guildId = String(route.guildId || '');
    const channelId = String(route.channelId || '');
    const template = String(route.template || '').trim();
    const color = String(route.color || '#5865F2');
    if (!EVENT_SET.has(event)) throw new TypeError('Choose a supported logging event');
    if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(channelId)) {
      throw new TypeError('Choose a valid Discord server and channel');
    }
    if (!template || template.length > 1000) {
      throw new TypeError('Message templates must contain 1 to 1000 characters');
    }
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new TypeError('Embed color must be a six-digit hex color');
    return {
      id: String(route.id || crypto.randomUUID()).slice(0, 64),
      event,
      guildId,
      channelId,
      template,
      color: color.toUpperCase(),
      enabled: route.enabled !== false,
    };
  });
}

function safeAvatarUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new TypeError('Bot logo must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:') throw new TypeError('Bot logo must be a valid HTTPS URL');
  if (parsed.href.length > 2048) throw new TypeError('Bot logo URL must be 2048 characters or fewer');
  return parsed.href;
}

function safeDetails(value) {
  const redactText = (text) => String(text).replace(
    /((?:password|token|secret|credential|private.?key|api.?key)\s*[:=]\s*)[^\s,;"']+/gi,
    '$1[redacted]'
  );
  const redact = (item) => {
    if (Array.isArray(item)) return item.slice(0, 20).map(redact);
    if (!item || typeof item !== 'object') return redactText(item ?? '').slice(0, 500);
    const out = {};
    for (const [key, child] of Object.entries(item).slice(0, 30)) {
      if (/password|token|secret|credential|private.?key|api.?key|cookie/i.test(key)) continue;
      out[key] = redact(child);
    }
    return out;
  };
  try {
    return JSON.stringify(redact(value)).slice(0, 1000);
  } catch (_) {
    return '[details unavailable]';
  }
}

function renderTemplate(template, values) {
  return String(template).replace(/\{(user|ip|server|event|time|details)\}/g, (_match, key) => {
    return String(values[key] || 'Unknown').slice(0, 500);
  }).slice(0, 4000);
}

class DiscordLogger {
  constructor() {
    this.socket = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.status = 'offline';
    this.statusError = '';
    this.stopping = false;
    this.lastSequence = null;
  }

  async readConfig() {
    const stored = settings.get(CONFIG_KEY, {});
    const tokenRecord = settings.get(TOKEN_KEY, {});
    let token = '';
    let tokenError = '';
    try {
      token = decryptToken(tokenRecord);
    } catch (_) {
      tokenError = 'The saved bot token cannot be decrypted. Re-enter the token and save to restore the connection.';
    }
    return {
      enabled: stored.enabled === true,
      avatarUrl: stored.avatarUrl || '',
      routes: Array.isArray(stored.routes) ? stored.routes : [],
      token,
      tokenError,
    };
  }

  async getAdminState() {
    const current = await this.readConfig();
    const guilds = await collections.discord_bot_guilds.find({}).sort({ name: 1 }).toArray();
    return {
      enabled: current.enabled,
      tokenConfigured: Boolean(current.token),
      avatarUrl: current.avatarUrl,
      routes: current.routes,
      events: EVENTS,
      guilds: guilds.map(({ id, name, icon }) => ({ id, name, icon })),
      status: this.status,
      error: this.statusError || current.tokenError,
    };
  }

  async getGuildChannels(guildId) {
    if (!/^\d{17,20}$/.test(String(guildId))) throw new TypeError('Choose a valid Discord server');
    const guild = await collections.discord_bot_guilds.findOne({ id: String(guildId) });
    if (!guild) throw new TypeError('The bot is not connected to that Discord server');
    return collections.discord_bot_channels.find(
      { guildId: String(guildId), type: { $in: [0, 5] } },
      { projection: { id: 1, name: 1, type: 1 } }
    ).sort({ name: 1 }).toArray();
  }

  async save(input) {
    const current = await this.readConfig();
    const enabled = input.enabled === true || input.enabled === 'true' || input.enabled === '1';
    const newToken = String(input.botToken || '').trim();
    if (newToken && (newToken.length < 40 || newToken.length > 300 || !/^[A-Za-z0-9._-]+$/.test(newToken))) {
      throw new TypeError('Discord bot token must be a valid token between 40 and 300 characters');
    }
    let encrypted = settings.get(TOKEN_KEY, {});
    if (newToken) encrypted = encryptToken(newToken);
    const routes = normalizeRoutes(input.routes);
    const activeRoutes = routes.filter((route) => route.enabled);
    if (activeRoutes.length) {
      const channelIds = [...new Set(activeRoutes.map((route) => route.channelId))];
      const channels = await collections.discord_bot_channels.find({ id: { $in: channelIds } }).toArray();
      const channelById = new Map(channels.map((channel) => [channel.id, channel]));
      for (const route of activeRoutes) {
        const channel = channelById.get(route.channelId);
        if (!channel || channel.guildId !== route.guildId || ![0, 5].includes(channel.type)) {
          throw new TypeError('An enabled route points to a channel that is no longer available. Refresh server channels and try again.');
        }
      }
    }
    const configRecord = {
      enabled,
      avatarUrl: safeAvatarUrl(input.avatarUrl),
      routes,
      updatedAt: new Date().toISOString(),
    };
    if (enabled && !newToken && !current.token) throw new TypeError('Enter a Discord bot token before enabling logging');
    if (newToken) await settings.set(TOKEN_KEY, encrypted);
    await settings.set(CONFIG_KEY, configRecord);
    await this.start();
    return this.getAdminState();
  }

  async discordRequest(endpoint, token, options = {}) {
    if (!token) throw new Error('Discord bot token is not configured');
    return axios({
      method: options.method || 'GET',
      url: `${DISCORD_API}${endpoint}`,
      data: options.data,
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'SiliconHost VM Panel (https://github.com/aryandw27/VM-Panel, 1.0)',
      },
      timeout: 10000,
    });
  }

  async start() {
    await this.stop();
    const current = await this.readConfig();
    if (current.tokenError) {
      this.status = 'error';
      this.statusError = current.tokenError;
      return;
    }
    if (!current.enabled || !current.token) {
      this.status = 'offline';
      this.statusError = '';
      return;
    }
    try {
      this.status = 'connecting';
      this.statusError = '';
      const gateway = await this.discordRequest('/gateway/bot', current.token);
      const socket = new WebSocket(`${gateway.data.url}?v=10&encoding=json`);
      this.socket = socket;
      this.stopping = false;
      socket.on('message', (raw) => {
        this.handleGatewayMessage(socket, current.token, raw).catch((error) => {
          logger.warn(`[discord-logger] Gateway event processing failed: ${error.message}`);
        });
      });
      socket.on('error', (error) => {
        this.statusError = error.message;
        logger.warn(`[discord-logger] Gateway connection failed: ${error.message}`);
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        if (!this.stopping) this.scheduleReconnect();
      });
    } catch (error) {
      this.status = 'error';
      this.statusError = error.response?.status === 401
        ? 'Discord rejected the bot token. Check the token and try again.'
        : error.message;
      logger.warn(`[discord-logger] Could not start bot: ${error.message}`);
    }
  }

  async handleGatewayMessage(socket, token, raw) {
    if (this.socket !== socket) return;
    let packet;
    try {
      packet = JSON.parse(raw.toString());
    } catch (_) {
      logger.warn('[discord-logger] Ignoring invalid gateway payload');
      return;
    }
    if (packet.s !== null && packet.s !== undefined) this.lastSequence = packet.s;
    if (packet.op === 10) {
      const interval = Number(packet.d?.heartbeat_interval);
      if (!Number.isFinite(interval) || interval < 1000) {
        logger.warn('[discord-logger] Discord sent an invalid heartbeat interval');
        socket.close();
        return;
      }
      socket.send(JSON.stringify({
        op: 2,
        d: {
          token,
          intents: 1,
          properties: { os: process.platform, browser: 'siliconhost-vm-panel', device: 'siliconhost-vm-panel' },
        },
      }));
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ op: 1, d: this.lastSequence }));
        }
      }, interval);
      if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
      return;
    }
    if (packet.op === 1) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ op: 1, d: this.lastSequence }));
      }
      return;
    }
    if (packet.op === 7 || packet.op === 9) {
      socket.close();
      return;
    }
    if (packet.op !== 0) return;
    const guilds = packet.t === 'READY' ? packet.d?.guilds || [] : [packet.d];
    if (packet.t === 'GUILD_DELETE') {
      if (!packet.d.unavailable) {
        await collections.discord_bot_guilds.deleteOne({ id: String(packet.d.id) });
        await collections.discord_bot_channels.deleteMany({ guildId: String(packet.d.id) });
      }
      return;
    }
    if (packet.t === 'CHANNEL_DELETE') {
      await collections.discord_bot_channels.deleteOne({ id: String(packet.d.id) });
      return;
    }
    if (packet.t === 'CHANNEL_CREATE' || packet.t === 'CHANNEL_UPDATE') {
      const channel = packet.d;
      if (![0, 5].includes(channel.type) || !channel.guild_id) {
        await collections.discord_bot_channels.deleteOne({ id: String(channel.id) });
      } else {
        await collections.discord_bot_channels.updateOne(
          { id: String(channel.id) },
          { $set: {
            id: String(channel.id),
            guildId: String(channel.guild_id),
            name: String(channel.name || '').slice(0, 100),
            type: channel.type,
          } },
          { upsert: true }
        );
      }
      return;
    }
    if (['READY', 'GUILD_CREATE', 'GUILD_UPDATE'].includes(packet.t)) {
      for (const guild of guilds) {
        if (!guild?.id) continue;
        const set = { id: String(guild.id), updatedAt: new Date().toISOString() };
        if (guild.name) set.name = String(guild.name).slice(0, 100);
        if (guild.icon !== undefined) set.icon = guild.icon || '';
        await collections.discord_bot_guilds.updateOne(
          { id: String(guild.id) },
          { $set: set },
          { upsert: true }
        );
        if (packet.t === 'GUILD_CREATE' && Array.isArray(guild.channels)) {
          const channels = guild.channels
            .filter((channel) => [0, 5].includes(channel.type))
            .map((channel) => ({
              id: String(channel.id),
              guildId: String(guild.id),
              name: String(channel.name || '').slice(0, 100),
              type: channel.type,
            }));
          await collections.discord_bot_channels.deleteMany({ guildId: String(guild.id) });
          if (channels.length) await collections.discord_bot_channels.insertMany(channels, { ordered: false });
        }
      }
      this.status = 'online';
      this.statusError = '';
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.status = 'reconnecting';
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((error) => logger.warn(`[discord-logger] Reconnect failed: ${error.message}`));
    }, 5000);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    this.lastSequence = null;
  }

  async emitPlatformEvent(event, payload = {}, meta = {}) {
    const current = await this.readConfig();
    if (!current.enabled || !current.token) return;
    const destinations = current.routes.filter((route) => route.enabled && route.event === event);
    if (!destinations.length) return;

    const [user, vm] = await Promise.all([
      meta.user_id ? collections.users.findOne({ id: Number(meta.user_id) }, { projection: { username: 1 } }) : null,
      meta.vm_id ? collections.vms.findOne({ id: Number(meta.vm_id) }, { projection: { name: 1 } }) : null,
    ]);
    const detailValue = payload.details && typeof payload.details === 'object'
      ? payload.details
      : payload.details || payload.info || '';
    const details = safeDetails(detailValue);
    const values = {
      user: payload.username || user?.username || 'System',
      ip: meta.ip || payload.ip || 'Unknown',
      server: vm?.name || payload.name || '—',
      event,
      time: new Date().toISOString(),
      details,
    };

    await Promise.all(destinations.map(async (route) => {
      const description = renderTemplate(route.template, values);
      const embed = {
        title: `SiliconHost VM Panel · ${event}`.slice(0, 256),
        description,
        color: parseInt(route.color.slice(1), 16),
        timestamp: new Date().toISOString(),
        footer: { text: 'SiliconHost VM Panel' },
        ...(current.avatarUrl ? { author: { name: 'SiliconHost VM Panel', icon_url: current.avatarUrl } } : {}),
      };
      try {
        await this.discordRequest(`/channels/${route.channelId}/messages`, current.token, {
          method: 'POST',
          data: { embeds: [embed], allowed_mentions: { parse: [] } },
        });
      } catch (error) {
        logger.warn(`[discord-logger] Failed to send ${event} to channel ${route.channelId}: ${error.response?.status || error.message}`);
      }
    }));
  }

  async sendTest(guildId, channelId) {
    const current = await this.readConfig();
    if (!current.token) throw new Error('Configure a bot token before sending a test');
    if (!/^\d{17,20}$/.test(String(guildId)) || !/^\d{17,20}$/.test(String(channelId))) {
      throw new TypeError('Choose a valid Discord server and channel');
    }
    const [guild, channel] = await Promise.all([
      collections.discord_bot_guilds.findOne({ id: String(guildId) }),
      collections.discord_bot_channels.findOne({ id: String(channelId), guildId: String(guildId), type: { $in: [0, 5] } }),
    ]);
    if (!guild || !channel) {
      throw new TypeError('Choose a text channel in a server where this bot is connected');
    }
    const message = {
      embeds: [{
        title: 'SiliconHost VM Panel · Test',
        description: 'Discord logging connection is working.',
        color: 0x5865F2,
        timestamp: new Date().toISOString(),
        footer: { text: 'SiliconHost VM Panel' },
        ...(current.avatarUrl ? { author: { name: 'SiliconHost VM Panel', icon_url: current.avatarUrl } } : {}),
      }],
      allowed_mentions: { parse: [] },
    };
    await this.discordRequest(`/channels/${channelId}/messages`, current.token, { method: 'POST', data: message });
    return { ok: true };
  }
}

module.exports = new DiscordLogger();
module.exports.EVENTS = EVENTS;
module.exports.normalizeRoutes = normalizeRoutes;
module.exports.renderTemplate = renderTemplate;
module.exports.safeDetails = safeDetails;
module.exports.encryptToken = encryptToken;
module.exports.decryptToken = decryptToken;
