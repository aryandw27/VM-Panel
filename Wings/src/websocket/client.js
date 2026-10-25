'use strict';

const WebSocket = require('ws');
const os = require('os');
const {
  getWebSocketUrl,
  getAuthHeaders,
  getNodeId,
  getNodeName,
  getVps,
  getSshPort,
  getVmDir,
  getImagesDir,
} = require('../lib/config');
const logger = require('../lib/logger');

const MAX_RECONNECT_DELAY_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 25000;

class WingsClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.closing = false;
    this.commandHandlers = new Map();
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  isConnected() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  connect() {
    if (this.closing) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    const url = getWebSocketUrl();
    logger.info(`Connecting to panel at ${url}`);

    const ws = new WebSocket(url, { headers: getAuthHeaders(), handshakeTimeout: 20000 });
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      logger.info(`Connected to panel as node ${getNodeId()} (${getNodeName()})`);
      this.register();
      this.startHeartbeat();
    });

    ws.on('message', (data) => {
      try {
        this.handleMessage(JSON.parse(data.toString()));
      } catch (error) {
        logger.warn('Discarded malformed panel message', { error: error.message });
      }
    });

    ws.on('pong', () => {
      this.lastPongAt = Date.now();
    });

    ws.on('close', (code, reason) => {
      this.connected = false;
      this.stopHeartbeat();
      if (this.closing) return;
      logger.warn(`Panel connection closed (${code}${reason && reason.length ? ': ' + reason.toString() : ''})`);
      this.scheduleReconnect();
    });

    ws.on('error', (error) => {
      logger.warn('Panel connection error', { error: error.message });
    });
  }

  register() {
    const vps = getVps();
    this.send({
      type: 'register',
      node_id: getNodeId(),
      name: getNodeName(),
      version: '1.0.0',
      ip: vps.ip || '',
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      vm_dir: getVmDir(),
      images_dir: getImagesDir(),
      ssh: {
        user: vps.ssh_user || 'root',
        port: parseInt(vps.ssh_port, 10) || getSshPort(),
        password: vps.ssh_password || '',
      },
      capabilities: ['vm_create', 'vm_start', 'vm_stop', 'vm_delete', 'vm_stats', 'node_stats'],
    });
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected()) return;
      this.send({ type: 'heartbeat', timestamp: Date.now() });
      // The panel pings us as well; drop a socket the panel has clearly forgotten.
      if (Date.now() - this.lastPongAt > HEARTBEAT_INTERVAL_MS * 4) {
        logger.warn('No reply from the panel for too long; reconnecting');
        try { this.ws.terminate(); } catch (_) {}
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.closing) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** Math.min(this.reconnectAttempts, 5), MAX_RECONNECT_DELAY_MS);
    logger.info(`Reconnecting to panel in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  onCommand(action, handler) {
    this.commandHandlers.set(action, handler);
  }

  send(message) {
    if (!this.isConnected()) return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      logger.warn('Failed to send message to panel', { error: error.message });
      return false;
    }
  }

  sendEvent(event, data) {
    return this.send({ type: 'event', event, data });
  }

  async handleMessage(message) {
    if (!message || typeof message !== 'object') return;

    switch (message.type) {
      case 'connected':
        logger.info(`Panel accepted the node connection (node ${message.node_id})`);
        return;
      case 'command':
        await this.runCommand(message);
        return;
      case 'pong':
        this.lastPongAt = Date.now();
        return;
      default:
        logger.debug('Ignored panel message', { type: message.type });
    }
  }

  async runCommand(message) {
    const { request_id: requestId, action, payload } = message;
    const handler = this.commandHandlers.get(action);
    if (!handler) {
      this.send({ type: 'command_result', request_id: requestId, ok: false, error: `Unsupported action "${action}"` });
      return;
    }

    try {
      const data = await handler(payload || {});
      this.send({ type: 'command_result', request_id: requestId, ok: true, data: data ?? null });
    } catch (error) {
      logger.error(`Command ${action} failed`, { error: error.message });
      this.send({ type: 'command_result', request_id: requestId, ok: false, error: error.message });
    }
  }

  close() {
    this.closing = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000, 'Wings shutting down'); } catch (_) {}
      this.ws = null;
    }
    this.connected = false;
  }
}

module.exports = new WingsClient();
