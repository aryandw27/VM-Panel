const net = require('net');
const crypto = require('crypto');
const { collections, settings } = require('../lib/db');
const sshService = require('./sshService');
const vmService = require('./vmService');
const { logActivity } = require('./activityService');

const MAX_CUSTOM_SCRIPT_BYTES = 16 * 1024;
const catalog = [
  {
    id: 'wordpress',
    name: 'WordPress',
    category: 'Web publishing',
    description: 'A persistent WordPress and MariaDB Compose stack, ready for its browser-based setup wizard.',
    icon: 'file-text',
    guestPort: 8080,
    exposure: 'Public HTTP after the VM restarts to apply its saved port mapping.',
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    category: 'AI assistant',
    description: 'Builds and runs the official OpenClaw Docker image with token authentication enabled.',
    icon: 'bot',
    exposure: 'Private by default. Use an SSH tunnel; no public host port is opened.',
  },
];

function dockerSetup() {
  return `set -euo pipefail
if ! command -v apt-get >/dev/null 2>&1; then
  echo "This reviewed installer currently supports Debian and Ubuntu guests." >&2
  exit 1
fi
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 git openssl
systemctl enable --now docker
`;
}

function wordpressScript() {
  return `${dockerSetup()}
APP_DIR=/opt/siliconhost-apps/wordpress
APP_PORT=8080
mkdir -p "$APP_DIR"
cd "$APP_DIR"
if [ ! -f .env ]; then
  printf 'APP_PORT=%s\\nDB_NAME=wordpress\\nDB_USER=wordpress\\nDB_PASSWORD=%s\\nDB_ROOT_PASSWORD=%s\\n' "$APP_PORT" "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > .env
  chmod 600 .env
fi
cat > compose.yaml <<'YAML'
services:
  database:
    image: mariadb:11.4
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: \${DB_NAME}
      MARIADB_USER: \${DB_USER}
      MARIADB_PASSWORD: \${DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - database:/var/lib/mysql
  wordpress:
    image: wordpress:php8.3-apache
    restart: unless-stopped
    depends_on:
      - database
    ports:
      - "0.0.0.0:\${APP_PORT}:80"
    environment:
      WORDPRESS_DB_HOST: database:3306
      WORDPRESS_DB_NAME: \${DB_NAME}
      WORDPRESS_DB_USER: \${DB_USER}
      WORDPRESS_DB_PASSWORD: \${DB_PASSWORD}
    volumes:
      - wordpress:/var/www/html
volumes:
  database:
  wordpress:
YAML
docker compose up -d
echo "WordPress containers are running on guest port $APP_PORT."
`;
}

function openClawScript(token) {
  return `${dockerSetup()}
APP_DIR=/opt/siliconhost-apps/openclaw
TOKEN=${token}
mkdir -p "$APP_DIR"
if [ ! -d "$APP_DIR/source/.git" ]; then
  git clone --depth 1 https://github.com/openclaw/openclaw.git "$APP_DIR/source"
fi
cd "$APP_DIR/source"
COMMIT="$(git rev-parse HEAD)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker build --build-arg "GIT_COMMIT=$COMMIT" --build-arg "OPENCLAW_BUILD_TIMESTAMP=$BUILD_TIME" -t openclaw:local .
mkdir -p "$APP_DIR/state/workspace"
cat > "$APP_DIR/state/openclaw.json" <<CONFIG
{"gateway":{"mode":"local","bind":"lan","auth":{"mode":"token","token":"$TOKEN"},"controlUi":{"allowedOrigins":["http://localhost:18789","http://127.0.0.1:18789"]}}}
CONFIG
chmod 600 "$APP_DIR/state/openclaw.json"
cat > "$APP_DIR/.env" <<ENV
OPENCLAW_GATEWAY_TOKEN=$TOKEN
ENV
chmod 600 "$APP_DIR/.env"
cat > "$APP_DIR/compose.yaml" <<'YAML'
services:
  gateway:
    image: openclaw:local
    restart: unless-stopped
    init: true
    cap_drop:
      - NET_RAW
      - NET_ADMIN
    security_opt:
      - no-new-privileges:true
    environment:
      HOME: /home/node
      OPENCLAW_HOME: /home/node
      OPENCLAW_STATE_DIR: /home/node/.openclaw
      OPENCLAW_CONFIG_PATH: /home/node/.openclaw/openclaw.json
      OPENCLAW_CONFIG_DIR: /home/node/.openclaw
      OPENCLAW_WORKSPACE_DIR: /home/node/.openclaw/workspace
      OPENCLAW_GATEWAY_PORT: "18789"
      OPENCLAW_GATEWAY_TOKEN: \${OPENCLAW_GATEWAY_TOKEN}
      TZ: UTC
    volumes:
      - ./state:/home/node/.openclaw
      - ./state/workspace:/home/node/.openclaw/workspace
    ports:
      - "18789:18789"
    command: ["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "18789"]
YAML
cd "$APP_DIR"
docker compose up -d
echo "OpenClaw gateway started. Configure a model provider during onboarding."
`;
}

function parsePortForwards(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function checkAvailablePort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    });
    server.listen({ host: '0.0.0.0', port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve(true));
    });
  });
}

async function allocateHostPort(vm) {
  const min = Math.max(1024, Number.parseInt(settings.get('vm.auto_port_min'), 10) || 25501);
  const max = Math.min(65535, Number.parseInt(settings.get('vm.auto_port_max'), 10) || 25600);
  const allVms = await collections.vms.find({}, {
    projection: { ssh_port: 1, vnc_port: 1, agent_port: 1, port_forwards: 1 },
  }).toArray();
  const used = new Set();
  for (const item of allVms) {
    for (const port of [item.ssh_port, item.vnc_port, item.agent_port]) {
      if (Number.isInteger(Number(port))) used.add(Number(port));
    }
    for (const forward of parsePortForwards(item.port_forwards)) {
      if (Number.isInteger(Number(forward.host))) used.add(Number(forward.host));
    }
  }
  for (let port = min; port <= max; port += 1) {
    if (!used.has(port) && await checkAvailablePort(port)) return port;
  }
  throw new Error('No free public port is available in the configured VM port range.');
}

function ensureGuestPortAvailable(vm, guestPort) {
  const forwards = parsePortForwards(vm.port_forwards);
  if (forwards.some((forward) => Number(forward.guest) === guestPort)) {
    throw new Error(`Guest port ${guestPort} is already forwarded. Remove or change that mapping before installing this app.`);
  }
  return forwards;
}

async function runScript(vm, script, timeout = 20 * 60 * 1000) {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  const command = `printf '%s' '${encoded}' | sudo -n bash -c 'base64 -d | bash'`;
  const result = await sshService.withExec(vm, command, { timeout, maxOutputBytes: 32 * 1024 });
  if (result.code !== 0) {
    const error = new Error(`Guest installer exited with status ${result.code}.`);
    error.code = 'APP_INSTALL_FAILED';
    throw error;
  }
}

async function install({ vm, user, appId, customScript }) {
  if (vm.status !== 'running') throw new Error('Start the VM and wait for SSH access before installing an app.');
  const id = String(appId || '');
  let hostPort = null;
  let guestPort = null;
  let openClawToken = null;
  let script;

  if (id === 'custom') {
    if (typeof customScript !== 'string' || !customScript.trim()) throw new TypeError('Enter an installation script.');
    if (Buffer.byteLength(customScript, 'utf8') > MAX_CUSTOM_SCRIPT_BYTES) {
      throw new TypeError(`Custom scripts are limited to ${MAX_CUSTOM_SCRIPT_BYTES / 1024} KB.`);
    }
    script = customScript;
  } else if (id === 'wordpress') {
    const app = catalog.find((entry) => entry.id === id);
    guestPort = app.guestPort;
    const forwards = ensureGuestPortAvailable(vm, guestPort);
    hostPort = await allocateHostPort(vm);
    script = wordpressScript();
    await runScript(vm, script);
    await vmService.update(vm, { port_forwards: [...forwards, { host: hostPort, guest: guestPort }] }, user);
  } else if (id === 'openclaw') {
    openClawToken = crypto.randomBytes(32).toString('hex');
    script = openClawScript(openClawToken);
    await runScript(vm, script);
  } else {
    throw new TypeError('Choose an app from the catalog or select custom script.');
  }

  await logActivity({
    user_id: user.id,
    vm_id: vm.id,
    event: 'vm:app_install',
    details: { app: id, ...(hostPort ? { host_port: hostPort, guest_port: guestPort } : {}) },
  });
  return {
    appId: id,
    hostPort,
    guestPort,
    restartRequired: Boolean(hostPort),
    ...(openClawToken ? { openClawToken } : {}),
  };
}

module.exports = {
  catalog,
  install,
  parsePortForwards,
  wordpressScript,
  openClawScript,
  MAX_CUSTOM_SCRIPT_BYTES,
};
