const net = require('net');
const { WebSocketServer } = require('ws');
const logger = require('../lib/logger');
const authService = require('./authService');
const vmService = require('./vmService');

function tokenFromReq(req) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams.get('token');
    if (q) return q;
  } catch (_) {}

  if (req.headers && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    const b = req.headers.authorization.slice(7).trim();
    if (b) return b;
  }

  const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('token='));
  if (cookie) {
    const raw = cookie.split('=')[1];
    try { return decodeURIComponent(raw); } catch (_) { return raw; }
  }

  const proto = req.headers['sec-websocket-protocol'];
  if (proto) {
    const parts = proto.split(',').map((s) => s.trim());
    if (parts.length === 2 && parts[0] === 'token') return parts[1];
  }
  return null;
}

async function authenticate(vmId, req) {
  const token = tokenFromReq(req);
  if (!token) return null;
  let user = null;
  try {
    const payload = authService.verifyToken(token);
    if (payload && payload.sub) user = await authService.findById(Number(payload.sub));
  } catch (_) {
    return null;
  }
  if (!user || user.suspended) return null;
  const vm = await vmService.getVm(vmId);
  if (!vm || !(await vmService.canAccess(user, vm, 'console'))) return null;
  const running = vmService.isRunning(vm);
  const port = parseInt(vm.vnc_port, 10);
  if (!running || !port) return null;
  return { user, vm: { ...vm, vnc_port: port } };
}

function attachVncProxy(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    const m = req.url.match(/^\/vncws\/(\d+)(?:[?].*)?$/);
    if (!m) return;

    let ctx = null;
    try {
      ctx = await authenticate(parseInt(m[1], 10), req);
    } catch (err) {
      logger.error(`[vnc] auth error for vm ${m[1]}: ${err.message}`);
    }

    if (!ctx) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      let tcpReady = false;
      const pending = [];
      let closed = false;

      const tcp = net.connect({ host: '127.0.0.1', port: ctx.vm.vnc_port });

      const cleanup = (err) => {
        if (closed) return;
        closed = true;
        if (err && err.code !== 'ECONNRESET') {
          logger.warn(`[vnc] TCP error vm ${ctx.vm.id}: ${err.message}`);
        }
        try { tcp.destroy(); } catch (_) {}
        try {
          if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
            ws.close();
          }
        } catch (_) {}
      };

      tcp.on('error', cleanup);
      tcp.on('close', cleanup);
      ws.on('error', cleanup);
      ws.on('close', cleanup);

      ws.on('message', (data) => {
        if (tcpReady) {
          try { tcp.write(data); } catch (_) {}
        } else {
          pending.push(data);
        }
      });

      tcp.on('connect', () => {
        tcpReady = true;
        while (pending.length) {
          try { tcp.write(pending.shift()); } catch (_) {}
        }
      });

      tcp.on('data', (data) => {
        if (ws.readyState === ws.OPEN) {
          try { ws.send(data, { binary: true }); } catch (_) {}
        }
      });

      logger.debug(`[vnc] ${ctx.user.username} -> vm ${ctx.vm.id} (port ${ctx.vm.vnc_port})`);
    });
  });
}

module.exports = { attachVncProxy };
