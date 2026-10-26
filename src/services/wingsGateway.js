'use strict';

const { WebSocketServer } = require('ws');
const { collections } = require('../lib/db');
const logger = require('../lib/logger');

const CONNECT_PATH = '/api/wings/connect';
const STATS_INTERVAL_MS = 15000;
const STATS_CACHE_MS = 5000;
const PING_INTERVAL_MS = 30000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

const connections = new Map();
const pendingRequests = new Map();
const statsCache = new Map();

let requestSeq = 0;
let pingTimer = null;

function nowIso() {
  return new Date().toISOString();
}

function normalizeNodeId(nodeId) {
  const id = Number(nodeId);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function readToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return String(req.headers['x-wings-token'] || '').trim();
}

function readNodeId(req, parsedUrl) {
  return normalizeNodeId(req.headers['x-wings-node'] || parsedUrl.searchParams.get('node_id'));
}

async function findNode(nodeId, token) {
  if (!nodeId || !token) return null;
  try {
    const node = await collections.nodes.findOne({ id: Number(nodeId) });
    if (!node) return null;
    const expected = String(node.token || '');
    if (!expected || expected !== token) return null;
    return node;
  } catch (error) {
    logger.warn('[wings] node lookup failed: ' + (error && error.message));
    return null;
  }
}

function connectionFor(nodeId) {
  return connections.get(normalizeNodeId(nodeId)) || null;
}

function isOnline(nodeId) {
  const conn = connectionFor(nodeId);
  return Boolean(conn && conn.ws.readyState === 1);
}

function describe(nodeId) {
  const conn = connectionFor(nodeId);
  if (!conn) return { online: false };
  return {
    online: conn.ws.readyState === 1,
    version: conn.info.version || '',
    ip: conn.info.ip || '',
    hostname: conn.info.hostname || '',
    connected_at: conn.connectedAt,
    last_seen_at: conn.lastSeenAt,
    stats: conn.stats || null,
  };
}

function rejectUpgrade(socket, status, reason) {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  } catch (_) {}
  try { socket.destroy(); } catch (_) {}
}

async function updateNodeRecord(nodeId, updates) {
  try {
    await collections.nodes.updateOne({ id: Number(nodeId) }, { $set: { ...updates, updated_at: nowIso() } });
  } catch (error) {
    logger.debug('[wings] could not persist node state: ' + (error && error.message));
  }
}

function settleRequest(requestId, { ok, data, error }) {
  const entry = pendingRequests.get(requestId);
  if (!entry) return;
  pendingRequests.delete(requestId);
  clearTimeout(entry.timer);
  if (ok) entry.resolve(data);
  else entry.reject(new Error(error || 'Wings command failed'));
}

function scheduleStatsPoll(conn) {
  const poll = async () => {
    if (!conn.ws || conn.ws.readyState !== 1) return;
    try {
      const stats = await request(conn.nodeId, 'node_stats', {}, 20000);
      if (stats) {
        conn.stats = stats;
        conn.lastSeenAt = nowIso();
        statsCache.set(conn.nodeId, { at: Date.now(), stats });
      }
    } catch (_) {
      // A missing stats reply only means the node is busy; the socket state stays authoritative.
    }
  };
  poll();
  conn.statsTimer = setInterval(poll, STATS_INTERVAL_MS);
  if (typeof conn.statsTimer.unref === 'function') conn.statsTimer.unref();
}

function handleRegister(conn, message) {
  const info = {
    version: String(message.version || ''),
    ip: String(message.ip || ''),
    hostname: String(message.hostname || ''),
    name: String(message.name || ''),
    capabilities: (message.capabilities && typeof message.capabilities === 'object') ? message.capabilities : [],
  };
  conn.info = info;
  conn.lastSeenAt = nowIso();

  const updates = {
    wings_online: true,
    wings_version: info.version,
    wings_ip: info.ip,
    wings_hostname: info.hostname,
    wings_last_seen_at: conn.lastSeenAt,
  };
  const hasCapabilities = Array.isArray(info.capabilities)
    ? info.capabilities.length > 0
    : Boolean(info.capabilities && Object.keys(info.capabilities).length);
  if (hasCapabilities) updates.runtime_capabilities = info.capabilities;

  const ssh = message.ssh || {};
  if (ssh.user) {
    // The node only fills in credentials the administrator has not already supplied in the panel.
    collections.nodes.findOne({ id: conn.nodeId }).then((node) => {
      const $set = { ...updates };
      if (node && !node.ssh_user) {
        $set.ssh_user = String(ssh.user);
        $set.ssh_port = parseInt(ssh.port, 10) || 22;
        if (ssh.password) $set.ssh_password = String(ssh.password);
      }
      if (node && !node.ssh_ip && info.ip) $set.ssh_ip = info.ip;
      return collections.nodes.updateOne({ id: conn.nodeId }, { $set: { ...$set, updated_at: nowIso() } });
    }).catch((error) => logger.debug('[wings] register persist failed: ' + error.message));
  } else {
    updateNodeRecord(conn.nodeId, updates);
  }

  logger.info(`[wings] node ${conn.nodeId} (${info.name || info.hostname || 'unnamed'}) registered with v${info.version || '?'}`);
}

async function handleMessage(conn, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch (_) {
    return;
  }

  conn.lastSeenAt = nowIso();

  switch (message.type) {
    case 'register':
      handleRegister(conn, message);
      return;
    case 'command_result':
      settleRequest(message.request_id, { ok: message.ok !== false, data: message.data, error: message.error });
      return;
    case 'event':
      await handleEvent(conn, message.event, message.data || {});
      return;
    case 'heartbeat':
      if (message.stats) {
        conn.stats = message.stats;
        statsCache.set(conn.nodeId, { at: Date.now(), stats: message.stats });
      }
      return;
    case 'ping':
      try { conn.ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() })); } catch (_) {}
      return;
    default:
      logger.debug('[wings] unhandled message type: ' + message.type);
  }
}

async function handleEvent(conn, event, data) {
  const vmId = Number(data.vm_id || data.id);
  if (!vmId) return;
  const statusByEvent = {
    vm_created: 'stopped',
    vm_install_started: 'installing',
    vm_started: 'running',
    vm_stopped: 'stopped',
    vm_deleted: 'deleted',
  };
  const status = event === 'vm_created' && data.status ? String(data.status) : statusByEvent[event];
  if (!status || status === 'deleted') {
    logger.debug(`[wings] event ${event} for vm ${vmId}`);
    return;
  }
  try {
    await collections.vms.updateOne(
      { id: vmId, node_id: conn.nodeId },
      { $set: { status, updated_at: nowIso() } },
    );
  } catch (error) {
    logger.debug('[wings] vm status update failed: ' + error.message);
  }
}

function attach(server) {
  if (!server) return null;
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let parsed;
    try {
      parsed = new URL(req.url, 'http://localhost');
    } catch (_) {
      return;
    }
    if (parsed.pathname !== CONNECT_PATH) return;

    const nodeId = readNodeId(req, parsed);
    const token = readToken(req);
    if (!nodeId || !token) return rejectUpgrade(socket, 401, 'Unauthorized');

    findNode(nodeId, token).then((node) => {
      if (!node) return rejectUpgrade(socket, 403, 'Forbidden');
      wss.handleUpgrade(req, socket, head, (ws) => accept(ws, node));
    }).catch(() => rejectUpgrade(socket, 500, 'Internal Server Error'));
  });

  if (!pingTimer) {
    pingTimer = setInterval(() => {
      for (const conn of connections.values()) {
        if (conn.ws.readyState !== 1) continue;
        if (conn.alive === false) {
          try { conn.ws.terminate(); } catch (_) {}
          cleanup(conn.nodeId, 'heartbeat timeout');
          continue;
        }
        conn.alive = false;
        try { conn.ws.ping(); } catch (_) {}
      }
    }, PING_INTERVAL_MS);
    if (typeof pingTimer.unref === 'function') pingTimer.unref();
  }

  logger.info('[wings] control channel listening on ' + CONNECT_PATH);
  return wss;
}

function cleanup(nodeId, reason) {
  const conn = connections.get(nodeId);
  if (!conn) return;
  if (conn.statsTimer) clearInterval(conn.statsTimer);
  connections.delete(nodeId);
  statsCache.delete(nodeId);
  logger.warn(`[wings] node ${nodeId} disconnected${reason ? ' (' + reason + ')' : ''}`);
  updateNodeRecord(nodeId, { wings_online: false, wings_last_seen_at: nowIso() });
}

function accept(ws, node) {
  const nodeId = Number(node.id);
  const existing = connections.get(nodeId);
  if (existing) {
    try { existing.ws.close(4000, 'Replaced by a newer connection'); } catch (_) {}
    cleanup(nodeId, 'replaced');
  }

  const conn = {
    nodeId,
    ws,
    info: { version: '', ip: '', hostname: '', name: node.name || '', capabilities: [] },
    stats: null,
    connectedAt: nowIso(),
    lastSeenAt: nowIso(),
    alive: true,
    statsTimer: null,
  };
  connections.set(nodeId, conn);

  ws.on('pong', () => { conn.alive = true; conn.lastSeenAt = nowIso(); });
  ws.on('message', (raw) => { handleMessage(conn, raw).catch(() => {}); });
  ws.on('close', () => cleanup(nodeId, 'socket closed'));
  ws.on('error', (error) => logger.warn('[wings] socket error: ' + error.message));

  try {
    ws.send(JSON.stringify({ type: 'connected', node_id: nodeId, panel_time: nowIso() }));
  } catch (_) {}

  scheduleStatsPoll(conn);
  updateNodeRecord(nodeId, { wings_online: true, wings_last_seen_at: conn.lastSeenAt });
}

function request(nodeId, action, payload = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const id = normalizeNodeId(nodeId);
  const conn = id ? connections.get(id) : null;
  if (!conn || conn.ws.readyState !== 1) {
    return Promise.reject(new Error(`Wings node ${nodeId || '?'} is offline. Start the Wings service on that VPS and try again.`));
  }

  const requestId = `req_${++requestSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Wings node ${id} did not answer ${action} within ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    pendingRequests.set(requestId, { resolve, reject, timer, nodeId: id });
    try {
      conn.ws.send(JSON.stringify({ type: 'command', request_id: requestId, action, payload }));
    } catch (error) {
      pendingRequests.delete(requestId);
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function getNodeStats(nodeId, { maxAgeMs = STATS_CACHE_MS } = {}) {
  const id = normalizeNodeId(nodeId);
  if (!id || !isOnline(id)) return null;
  const cached = statsCache.get(id);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.stats;
  try {
    const stats = await request(id, 'node_stats', {}, 15000);
    if (stats) {
      statsCache.set(id, { at: Date.now(), stats });
      const conn = connections.get(id);
      if (conn) conn.stats = stats;
    }
    return stats;
  } catch (error) {
    if (cached) return cached.stats;
    logger.debug('[wings] stats request failed: ' + error.message);
    return null;
  }
}

function listStatuses() {
  const out = {};
  for (const nodeId of connections.keys()) out[nodeId] = describe(nodeId);
  return out;
}

module.exports = {
  attach,
  request,
  isOnline,
  describe,
  listStatuses,
  getNodeStats,
  statsCache,
};
