#!/usr/bin/env node






const fs = require('fs');
const path = require('path');
const net = require('net');
const { execSync } = require('child_process');
const config = require('../src/lib/config');
const { initDb, closeDb, collections } = require('../src/lib/db');
const vmService = require('../src/services/vmService');

const check = process.argv.includes('--check');
const errors = [];
const warnings = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function hasBin(b) {
  try { execSync(`which ${b}`, { stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}

function parseMongoTarget(uri) {
  try {
    const url = new URL(uri);
    const host = url.hostname || '127.0.0.1';
    const port = Number(url.port || 27017);
    return { host, port, isLocal: ['127.0.0.1', 'localhost', '::1'].includes(host) };
  } catch (_) {
    return { host: '127.0.0.1', port: 27017, isLocal: false };
  }
}

function tcpReachable(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function canSelfHealLocalMongo() {
  return process.platform === 'linux'
    && typeof process.getuid === 'function'
    && process.getuid() === 0;
}

function startDockerDaemon() {
  for (const cmd of ['systemctl start docker', 'service docker start']) {
    try { execSync(cmd, { stdio: 'ignore', timeout: 30000 }); return true; } catch (_) {}
  }
  return false;
}

function findMongoContainer() {
  try {
    const list = execSync('docker ps -a --format "{{.Names}}|{{.Image}}"', { encoding: 'utf8', timeout: 10000 });
    const lines = list.split('\n').map((l) => l.trim()).filter(Boolean);
    const byName = lines.find((l) => l.split('|')[0] === 'mongodb');
    const byImage = lines.find((l) => /mongo/i.test(l.split('|')[1] || ''));
    return byName ? 'mongodb' : (byImage ? (byImage.split('|')[0] || null) : null);
  } catch (_) {
    return null;
  }
}

function startLocalMongo() {
  for (const cmd of ['systemctl start mongod', 'systemctl start mongodb', 'service mongod start', 'service mongodb start']) {
    try { execSync(cmd, { stdio: 'ignore', timeout: 20000 }); return true; } catch (_) {}
  }
  // Docker-hosted database (the installer deploys MongoDB as a container that
  // publishes 127.0.0.1:<port>:27017). The daemon itself may be down — without
  // it, `docker start` fails and --restart unless-stopped cannot do its job.
  const daemonStarted = startDockerDaemon();
  let container = findMongoContainer();
  if (!container && daemonStarted) {
    try { execSync('sleep 2', { stdio: 'ignore', timeout: 5000 }); } catch (_) {}
    container = findMongoContainer();
  }
  if (container) {
    try {
      execSync(`docker start ${container}`, { stdio: 'ignore', timeout: 30000 });
      return true;
    } catch (_) {}
  }
  // Bringing the daemon up may revive restart-enabled containers even when the
  // Mongo container could not be identified by name or image.
  return daemonStarted;
}

async function connectDatabase() {
  const target = parseMongoTarget(config.mongoUri);
  let reachable = await tcpReachable(target.host, target.port);
  let selfHealed = false;

  if (!reachable && target.isLocal && canSelfHealLocalMongo()) {
    console.log(`[info] MongoDB is not listening on ${target.host}:${target.port} — starting the local database service...`);
    if (startLocalMongo()) {
      selfHealed = true;
      for (let i = 0; i < 24; i += 1) {
        if (await tcpReachable(target.host, target.port, 900)) {
          reachable = true;
          break;
        }
        await sleep(500);
      }
    }
    if (!reachable) console.log('[warn] MongoDB could not be brought online automatically.');
  }

  if (!reachable) {
    console.log(`[warn] MongoDB is not reachable at ${target.host}:${target.port} — trying anyway (it may use a socket or replica set).`);
  }

  const attempts = reachable || selfHealed ? 5 : 2;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await initDb();
      return true;
    } catch (e) {
      if (attempt < attempts) {
        console.log(`[info] MongoDB not ready (attempt ${attempt}/${attempts}) — retrying...`);
        await sleep(2000);
      } else {
        errors.push(`MongoDB connection failed: ${e.message}`);
      }
      await closeDb();
    }
  }
  return false;
}

(async () => {
console.log('');
console.log('  vpanel build');
console.log('  =================');
console.log('');


for (const d of [
  config.vmDir, config.uploads.dir, config.uploads.logo, config.uploads.favicon,
  config.uploads.background, config.uploads.music, config.uploads.avatar,
  config.uploads.backup, path.join(config.root, 'data'),
  path.join(config.root, 'storage/logs'),
]) ensureDir(d);
console.log('[ok] directories ready');


if (await connectDatabase()) {
  try {
    const userCount = await collections.users.countDocuments();
    console.log(`[ok] database ready (${userCount} users)`);
  } catch (e) {
    warnings.push(`Database is connected but could not be queried: ${e.message}`);
  }
}


console.log('[info] system dependency report:');
for (const bin of ['qemu-system-x86_64', 'cloud-localds', 'qemu-img', 'wget', 'openssl']) {
  const ok = hasBin(bin);
  console.log(`       ${ok ? 'ok  ' : 'MISS'}  ${bin}`);
  if (!ok) {
    warnings.push(`${bin} is missing. VM create/start will not work.`);
  }
}


const novncDir = path.join(config.root, 'public/vendor/novnc/core');
if (!fs.existsSync(path.join(novncDir, 'rfb.js'))) {
  console.log('[info] noVNC not found. Downloading...');
  const NOVNC_VERSION = '1.5.0';
  const tmp = path.join(config.root, 'data/tmp/novnc.tar.gz');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  try {
    const url = `https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz`;
    execSync(`wget -q -O "${tmp}" "${url}"`, { stdio: 'inherit' });
    const dir = path.join(config.root, 'public/vendor/novnc');
    fs.mkdirSync(dir, { recursive: true });
    execSync(`tar xzf "${tmp}" -C "${path.dirname(tmp)}"`, { stdio: 'inherit' });
    execSync(`rm -rf "${dir}/core" "${dir}/vendor" && mkdir -p "${dir}/vendor" && cp -r "${path.dirname(tmp)}/noVNC-${NOVNC_VERSION}/core" "${dir}/core" && cp -r "${path.dirname(tmp)}/noVNC-${NOVNC_VERSION}/vendor/pako" "${dir}/vendor/pako"`, { stdio: 'inherit' });
    fs.rmSync(tmp, { force: true });
    console.log('[ok] noVNC downloaded');
  } catch (e) {
    warnings.push(`Could not download noVNC: ${e.message}. The graphical VNC console will not work until it is installed.`);
  }
} else {
  console.log('[ok] noVNC present');
}


if (config.jwtSecret === 'vpanel-insecure-secret-change-me') {
  warnings.push('JWT_SECRET is still the default. Set a strong value in .env before production.');
}


if (!fs.existsSync(path.join(config.root, '.env'))) {
  warnings.push('.env not found. Copy .env.example to .env and adjust values.');
}

console.log('');
for (const w of warnings) console.log(`[warn] ${w}`);
for (const e of errors) console.log(`[error] ${e}`);
console.log('');

if (errors.length) {
  if (errors.some((message) => message.startsWith('MongoDB connection failed'))) {
    console.log('       MongoDB must be running for the panel to work.');
    console.log('       Local database:  systemctl start mongod   (or: docker start mongodb)');
    console.log('       If MONGO_URI in .env points to another server, check that host instead.');
    console.log('');
  }
  console.log('[error] Build finished with errors. Fix the issue and re-run: node scripts/build.js');
  await closeDb();
  process.exit(1);
}

if (check && warnings.length) {
  await closeDb();
  process.exit(1);
}

console.log('[done] Build complete. Run with: npm start  (or pm2 start ecosystem.config.js)');
await closeDb();
})();
