const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, execSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('../lib/config');
const { collections, getNextId, settings, ensureConnected } = require('../lib/db');
const logger = require('../lib/logger');
const { logActivity } = require('./activityService');
const { createVmOperationCoordinator } = require('./vmOperationCoordinator');
const wingsGateway = require('./wingsGateway');
const runtimes = require('./runtimes');
const capacityService = require('./capacityService');
const {
  isKnownKind, isContainerKind, definitionFor, isValidImage, imageEntry,
} = require('./runtimes/definitions');
const { normalizeAccess } = require('./runtimes/util');

const VM_DIR = config.vmDir;
const RUNNING_PREFIX = 'qemu-system';
const withVmOperation = createVmOperationCoordinator({
  collections,
  ensureConnected,
  inspectState: async (id) => {
    const vm = await getVm(id);
    return vm ? statusOf(vm) : 'missing';
  },
});

function ensureDirs() {
  for (const d of [VM_DIR, config.uploads.backup]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
ensureDirs();

function vmDir(vm) {
  return path.join(VM_DIR, String(vm.id));
}

function hasBin(bin) {
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
}

function runBoundedProcess(command, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    let killTimer;
    const child = spawn(command, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 2000);
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer);
      reject(Object.assign(new Error('The VM disk operation could not start.'), { category: 'operation_failed', cause: error }));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer);
      if (timedOut) return reject(Object.assign(new Error('The VM disk operation timed out; inspect the VM and disk state before retrying.'), { category: 'operation_uncertain' }));
      if (code !== 0) return reject(Object.assign(new Error('The VM disk operation failed.'), { category: 'operation_failed' }));
      return resolve();
    });
  });
}

function getOsList() {
  let raw = settings.get('vm.os_list');
  if (typeof raw === 'string') raw = JSON.parse(raw);
  return Array.isArray(raw) ? raw : [];
}

function parseForwards(str) {
  const out = [];
  if (!str) return out;
  if (Array.isArray(str)) {
    return str
      .map((forward) => ({ host: Number(forward.host), guest: Number(forward.guest) }))
      .filter((forward) => Number.isInteger(forward.host) && forward.host > 0 && forward.host <= 65535
        && Number.isInteger(forward.guest) && forward.guest > 0 && forward.guest <= 65535);
  }
  if (typeof str === 'string' && str.trim().startsWith('[')) {
    try {
      return parseForwards(JSON.parse(str));
    } catch (_) {
      return out;
    }
  }
  for (const part of String(str).split(',')) {
    const m = part.trim().match(/^(\d+):(\d+)$/);
    if (m) {
      const forward = { host: parseInt(m[1], 10), guest: parseInt(m[2], 10) };
      if (forward.host > 0 && forward.host <= 65535 && forward.guest > 0 && forward.guest <= 65535) out.push(forward);
    }
  }
  return out;
}

function normalizePortForwards(input) {
  if (!Array.isArray(input)) throw new TypeError('Port forwards must be a list.');
  const hosts = new Set();
  return input.map((forward) => {
    const host = Number(forward?.host);
    const guest = Number(forward?.guest);
    if (!Number.isInteger(host) || host < 1 || host > 65535 || !Number.isInteger(guest) || guest < 1 || guest > 65535) {
      throw new TypeError('Each port forward must use host and guest ports between 1 and 65535.');
    }
    if (hosts.has(host)) throw new TypeError(`Host port ${host} is forwarded more than once.`);
    hosts.add(host);
    return { host, guest };
  });
}

function checkHostPortAvailable(port) {
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

function reservedHostPorts(vm) {
  return [
    vm.ssh_port,
    vm.agent_port,
    vm.vnc_port,
    ...parseForwards(vm.port_forwards).map((forward) => forward.host),
  ].map(Number).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

async function validateHostForwards(vm, forwards, { reservedVms = null, isPortAvailable = checkHostPortAvailable } = {}) {
  const normalized = normalizePortForwards(forwards);
  const ownReserved = new Set([vm.ssh_port, vm.agent_port, vm.vnc_port]
    .map(Number).filter((port) => Number.isInteger(port) && port > 0));
  const otherVms = reservedVms || await collections.vms.find({ id: { $ne: Number(vm.id) } }, {
    projection: { id: 1, name: 1, ssh_port: 1, agent_port: 1, vnc_port: 1, port_forwards: 1 },
  }).toArray();
  const reservedByOther = new Map();
  for (const other of otherVms) {
    for (const port of reservedHostPorts(other)) {
      if (!reservedByOther.has(port)) reservedByOther.set(port, other.name || `VM ${other.id}`);
    }
  }

  const usedPorts = new Set([...ownReserved, ...reservedByOther.keys()]);
  const min = Math.max(1024, parseInt(settings.get('vm.auto_port_min') || config.autoPortMin, 10));
  const max = Math.min(65535, parseInt(settings.get('vm.auto_port_max') || config.autoPortMax, 10));
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
    throw new Error('The configured VM host-port range is invalid. Correct it in admin settings before saving port forwards.');
  }
  async function allocateReplacement(guestPort) {
    for (let port = min; port <= max; port += 1) {
      if (usedPorts.has(port)) continue;
      if (await isPortAvailable(port)) {
        usedPorts.add(port);
        return port;
      }
    }
    throw new Error(`No free host port is available in the configured VM range ${min}-${max} for guest port ${guestPort}.`);
  }

  const validated = [];
  for (const forward of normalized) {
    const owner = reservedByOther.get(forward.host);
    const available = !ownReserved.has(forward.host)
      && !owner
      && !usedPorts.has(forward.host)
      && await isPortAvailable(forward.host);
    if (available) {
      usedPorts.add(forward.host);
      validated.push(forward);
    } else {
      const host = await allocateReplacement(forward.guest);
      logger.info(`[vm] remapped requested host port ${forward.host} to ${host} for guest port ${forward.guest} on VM ${vm.id}`);
      validated.push({ ...forward, host });
    }
  }
  return validated;
}

function inUsePort(port) {
  try {
    execSync(`ss -tln | grep -q ':${port} '`, { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

async function allocPort() {
  const min = parseInt(settings.get('vm.auto_port_min') || config.autoPortMin, 10);
  const max = parseInt(settings.get('vm.auto_port_max') || config.autoPortMax, 10);
  const vms = await collections.vms.find({}, { projection: { ssh_port: 1 } }).toArray();
  const used = new Set(vms.map((r) => r.ssh_port));
  for (let p = min; p <= max; p++) {
    if (!used.has(p) && !inUsePort(p)) return p;
  }
  throw new Error(`No free port in range ${min}-${max}. All ports in use.`);
}

async function allocVncPort() {
  const min = parseInt(settings.get('vm.vnc_port_min') || config.autoVncPortMin, 10);
  const max = parseInt(settings.get('vm.vnc_port_max') || config.autoVncPortMax, 10);
  if (min <= 5900) throw new Error('VNC port range must start above 5900');
  const vms = await collections.vms.find({}, { projection: { vnc_port: 1 } }).toArray();
  const used = new Set(vms.map((r) => r.vnc_port));
  for (let p = min; p <= max; p++) {
    if (!used.has(p) && !inUsePort(p)) return p;
  }
  throw new Error(`No free VNC port in range ${min}-${max}. All ports in use.`);
}

async function allocAgentPort() {
  const min = parseInt(settings.get('vm.agent_port_min') || config.autoAgentPortMin, 10);
  const max = parseInt(settings.get('vm.agent_port_max') || config.autoAgentPortMax, 10);
  const vms = await collections.vms.find({}, { projection: { agent_port: 1 } }).toArray();
  const used = new Set(vms.map((r) => r.agent_port));
  for (let p = min; p <= max; p++) {
    if (!used.has(p) && !inUsePort(p)) return p;
  }
  throw new Error(`No free agent port in range ${min}-${max}. All ports in use.`);
}

function genAgentToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function ensureAgentPort(vm) {
  if (!vm.agent_port) {
    vm.agent_port = await allocAgentPort();
    await collections.vms.updateOne({ id: Number(vm.id) }, { $set: { agent_port: vm.agent_port, updated_at: now() } });
  }
  if (!vm.agent_token) {
    vm.agent_token = genAgentToken();
    await collections.vms.updateOne({ id: Number(vm.id) }, { $set: { agent_token: vm.agent_token, updated_at: now() } });
  }
  return vm;
}

async function ensureVncPort(vm) {
  if (vm.vnc_port) return vm.vnc_port;
  const port = await allocVncPort();
  await collections.vms.updateOne({ id: Number(vm.id) }, { $set: { vnc_port: port, updated_at: now() } });
  vm.vnc_port = port;
  return port;
}

function hasKvm() {
  if (process.env.NO_KVM === '1' || process.env.NOKVM === '1') return false;
  try {
    if (!fs.existsSync('/dev/kvm')) return false;
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function buildQemuArgs(vm) {
  const dir = vmDir(vm);
  const img = vm.img_file || path.join(dir, 'disk.qcow2');
  const seed = vm.seed_file || path.join(dir, 'seed.iso');
  const fwds = parseForwards(vm.port_forwards);
  const kvmAvailable = hasKvm();
  const accelMode = kvmAvailable ? 'kvm:tcg' : 'tcg';
  const cpuType = kvmAvailable ? 'host' : 'qemu64';
  const access = parsedAccess(vm);
  const hostForwards = [
    ...(access.ssh && vm.ssh_port ? [`hostfwd=tcp::${vm.ssh_port}-:22`] : []),
    ...(vm.agent_port ? [`hostfwd=tcp::${vm.agent_port}-:9090`] : []),
    ...fwds.map((forward) => `hostfwd=tcp::${forward.host}-:${forward.guest}`),
  ];

  const args = [
    '-m', String(vm.memory),
    '-smp', String(vm.cpus),
    '-cpu', cpuType,
    '-machine', `type=pc,accel=${accelMode}`,
    '-drive', `file=${img},format=qcow2,if=virtio`,
    '-drive', `file=${seed},format=raw,if=virtio`,
    '-boot', 'order=c',
    '-device', 'virtio-net-pci,netdev=n0',
    '-netdev', `user,id=n0,${hostForwards.join(',')}`,
    '-object', 'rng-random,filename=/dev/urandom,id=rng0',
    '-device', 'virtio-rng-pci,rng=rng0',
    '-rtc', 'base=utc,clock=host',
    '-device', 'virtio-balloon-pci',
  ];

  if (vm.vnc_port) {
    args.push('-vnc', `127.0.0.1:${vm.vnc_port - 5900}`);
    if (vm.gui_mode && process.env.DISPLAY) {
      args.push('-display', 'gtk');
    }
  } else if (vm.gui_mode && process.env.DISPLAY) {
    args.push('-display', 'gtk');
  } else {
    args.push('-display', 'none');
  }

  args.push(
    '-serial', `file:${path.join(dir, 'boot.log')}`,
    '-vga', 'std',
    '-pidfile', path.join(dir, 'qemu.pid'),
    '-daemonize',
  );

  return args;
}

function explainQemuStartFailure(output) {
  try {
    const forwardingFailure = String(output || '').match(/Could not set up host forwarding rule ['"]tcp::(\d+)-:(\d+)['"]/i);
    if (forwardingFailure) {
      const hostPort = Number(forwardingFailure[1]);
      const guestPort = Number(forwardingFailure[2]);
      return `QEMU could not bind host port ${hostPort} for guest port ${guestPort}. The host port may already be in use; change the mapping in VM Settings to a different unused host port, then try again.`;
    }
  } catch (_) {}
  return 'QEMU exited before the VM reached running state. Review the VM boot log for details.';
}

function qemuStartFailure(vm, logOffset = 0) {
  let output = '';
  let fd;
  try {
    fd = fs.openSync(path.join(vmDir(vm), 'qemu.log'), 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(logOffset, size - 16 * 1024);
    const buffer = Buffer.alloc(Math.max(0, size - start));
    fs.readSync(fd, buffer, 0, buffer.length, start);
    output = buffer.toString('utf8');
  } catch (_) {
    // Fall through to the generic startup error when QEMU produced no readable log.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return explainQemuStartFailure(output);
}

function getBootLog(vm) {
  const dir = vmDir(vm);
  let content = '';
  const bootLog = path.join(dir, 'boot.log');
  const qemuLog = path.join(dir, 'qemu.log');
  if (fs.existsSync(bootLog)) {
    try {
      const data = fs.readFileSync(bootLog, 'utf8');
      if (data && data.trim()) content += data;
    } catch (_) {}
  }
  if (fs.existsSync(qemuLog)) {
    try {
      const qdata = fs.readFileSync(qemuLog, 'utf8');
      if (qdata && qdata.trim()) {
        content = (content ? content + '\n\n=== QEMU System Output ===\n' : '') + qdata;
      }
    } catch (_) {}
  }
  return content || '[Boot Log] No boot output recorded yet. Start the server to stream boot logs.';
}

function clearBootLog(vm) {
  const dir = vmDir(vm);
  const bootLog = path.join(dir, 'boot.log');
  const qemuLog = path.join(dir, 'qemu.log');
  try {
    if (fs.existsSync(bootLog)) fs.writeFileSync(bootLog, '', 'utf8');
    if (fs.existsSync(qemuLog)) fs.writeFileSync(qemuLog, '', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function pidOf(vm) {
  const file = path.join(vmDir(vm), 'qemu.pid');
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!/^\d{1,10}$/.test(raw)) return null;
    const pid = Number(raw);
    if (pid > 0) return pid;
  } catch (_) {}
  return null;
}

function qemuProcess(vm) {
  const pid = pidOf(vm);
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    const executable = fs.realpathSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '');
    if (!path.basename(executable).startsWith(RUNNING_PREFIX)) return null;
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0');
    const pidfileIndex = argv.indexOf('-pidfile');
    const expectedPidfile = path.join(vmDir(vm), 'qemu.pid');
    if (pidfileIndex < 0 || argv[pidfileIndex + 1] !== expectedPidfile) return null;
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    if (!fields[19]) return null;
    return { pid, executable, start_time: fields[19], pidfile: expectedPidfile };
  } catch (_) { return null; }
}

function sameQemuProcess(vm, identity) {
  const current = qemuProcess(vm);
  return Boolean(current && identity && current.pid === identity.pid && current.start_time === identity.start_time && current.pidfile === identity.pidfile);
}

function isRemoteVm(vm) {
  return Boolean(vm && Number(vm.node_id) > 1);
}

function isContainerVm(vm) {
  return Boolean(vm) && isContainerKind(vm.kind);
}

function parsedAccess(vm) {
  let access = vm && vm.access;
  if (typeof access === 'string') {
    try { access = JSON.parse(access); } catch (_) { access = null; }
  }
  const source = access && typeof access === 'object' ? access : {};
  return {
    ssh: source.ssh !== undefined ? Boolean(source.ssh) : true,
    terminal: source.terminal !== undefined ? Boolean(source.terminal) : true,
    ports: source.ports !== undefined ? Boolean(source.ports) : true,
  };
}

function parsedLimits(vm) {
  let limits = vm && vm.limits;
  if (typeof limits === 'string') {
    try { limits = JSON.parse(limits); } catch (_) { limits = null; }
  }
  return limits && typeof limits === 'object' ? limits : null;
}

async function getRemoteNode(nodeId) {
  if (!nodeId || Number(nodeId) === 1) return null;
  return collections.nodes.findOne({ id: Number(nodeId) });
}

function isRunning(vm) {
  if (isContainerVm(vm)) return vm.status === 'running';
  if (isRemoteVm(vm)) return vm.status === 'running';
  return Boolean(qemuProcess(vm));
}

function statusOf(vm) {
  if (vm && vm.suspended) return 'suspended';
  if (isContainerVm(vm)) return vm.status === 'running' ? 'running' : (vm.status || 'stopped');
  if (isRemoteVm(vm)) return vm.status || 'stopped';
  return isRunning(vm) ? 'running' : 'stopped';
}

async function dbVms() {
  const vms = await collections.vms.find().toArray();
  if (!vms.length) return [];
  const userIds = [...new Set(vms.map((v) => v.owner_id))];
  const users = await collections.users.find({ id: { $in: userIds } }).toArray();
  const userMap = new Map(users.map((u) => [u.id, u]));
  return vms.map((v) => {
    const u = userMap.get(v.owner_id);
    return {
      ...v,
      owner_name: u ? (u.username || u.name) : 'Unknown',
      owner_username: u ? u.username : 'Unknown',
      owner_email: u ? u.email : '',
    };
  });
}

function serializeVm(row) {
  if (!row) return null;
  let forwards = [];
  try { forwards = JSON.parse(row.port_forwards || '[]'); } catch (_) {}
  const rawUuid = row.uuid || `vm-${String(row.id).padStart(8, '0')}`;
  const kind = isKnownKind(row.kind) ? row.kind : 'qemu-dedicated';
  const out = {
    ...row,
    uuid: rawUuid,
    uuidShort: rawUuid.slice(0, 8),
    kind,
    runtime: row.runtime || definitionFor(kind).runtime,
    image: row.image || '',
    access: parsedAccess(row),
    limits: parsedLimits(row),
    is_container: isContainerKind(kind),
    port_forwards: forwards,
    gui_mode: !!row.gui_mode,
    start_on_boot: !!row.start_on_boot,
    suspended: !!row.suspended,
    status: statusOf(row),
    remote: isRemoteVm(row),
    runtime_ref: row.runtime_ref || '',
    dir: isRemoteVm(row) ? (row.remote_dir || '') : vmDir(row),
  };
  delete out.agent_token;
  return out;
}

async function getVm(id) {
  if (!id) return null;
  const row = await collections.vms.findOne({ id: Number(id) });
  return serializeVm(row);
}

async function canAccess(user, vm, perm = null) {
  if (!vm || !user) return false;
  if (user.role === 'admin' || user.root_admin) return true;
  if (vm.owner_id === user.id) return true;
  const sub = await collections.subusers.findOne({ vm_id: Number(vm.id), user_id: Number(user.id) });
  if (!sub) return false;
  if (!perm) return true;
  let perms = [];
  try { perms = typeof sub.permissions === 'string' ? JSON.parse(sub.permissions) : (sub.permissions || []); } catch (_) {}
  return perms.includes(perm) || perms.includes('*');
}

async function setDbStatus(id, status) {
  await collections.vms.updateOne(
    { id: Number(id) },
    { $set: { status, updated_at: new Date().toISOString() } }
  );
}

function now() {
  return new Date().toISOString();
}

async function download(url, dest) {
  logger.info(`[vm] downloading ${url}`);
  return new Promise((resolve, reject) => {
    const tmp = dest + '.tmp';
    const child = spawn('wget', ['-q', '--show-progress', '-O', tmp, url], { stdio: 'inherit' });
    child.on('close', (code) => {
      if (code === 0) {
        fs.renameSync(tmp, dest);
        resolve(dest);
      } else {
        reject(new Error(`wget failed with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

function extractQcow2Archive(archivePath, outputPath, destinationDir) {
  const listing = spawnSync('tar', ['-tJf', archivePath], { encoding: 'utf8' });
  if (listing.status !== 0) {
    throw new Error(`Unable to inspect cloud image archive: ${listing.stderr || listing.stdout}`);
  }

  const member = listing.stdout.split(/\r?\n/).find((entry) => (
    entry.endsWith('.qcow2')
    && !path.isAbsolute(entry)
    && !entry.includes('/')
    && !entry.includes('\\')
    && entry !== '..'
  ));
  if (!member) throw new Error('Cloud image archive does not contain a safe QCOW2 disk image');

  const extracted = path.resolve(destinationDir, member);
  const root = path.resolve(destinationDir) + path.sep;
  if (!extracted.startsWith(root)) throw new Error('Cloud image archive contains an unsafe disk image path');

  const result = spawnSync('tar', ['-xJf', archivePath, '-C', destinationDir, '--', member], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Unable to extract cloud image archive: ${result.stderr || result.stdout}`);
  }
  if (!fs.existsSync(extracted) || !fs.lstatSync(extracted).isFile()) {
    throw new Error('Cloud image archive extraction did not produce a regular disk image');
  }
  fs.renameSync(extracted, outputPath);
}

function agentSeedPayload(vm) {
  const script = fs.readFileSync(path.join(config.root, 'scripts/vpanel-agent.py'), 'utf8');
  const unit = [
    '[Unit]',
    'Description=vPanel VM Agent',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart=/usr/local/bin/vpanel-agent',
    'Restart=on-failure',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n');
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  return [
    `echo '${b64(script)}' | base64 -d > /usr/local/bin/vpanel-agent && chmod 755 /usr/local/bin/vpanel-agent`,
    `echo '${vm.agent_token}' > /etc/vpanel-agent.token && chmod 600 /etc/vpanel-agent.token`,
    `printf '%s' '${b64(unit)}' | base64 -d > /etc/systemd/system/vpanel-agent.service`,
    'systemctl daemon-reload || true',
    'systemctl enable --now vpanel-agent 2>/dev/null || (nohup /usr/local/bin/vpanel-agent >/var/log/vpanel-agent.log 2>&1 &) || true',
  ];
}

function writeSeed(vm) {
  const dir = vmDir(vm);
  const passHash = spawnSync('openssl', ['passwd', '-6', vm.password], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(
    path.join(dir, 'user-data'),
    `#cloud-config
output:
  all: '| tee -a /dev/ttyS0 /dev/console'
hostname: ${vm.hostname || vm.name}
ssh_pwauth: true
disable_root: false
users:
  - name: ${vm.username}
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: false
    passwd: ${passHash}
chpasswd:
  list: |
    root:${vm.password}
    ${vm.username}:${vm.password}
  expire: false
package_update: true
write_files:
  - path: /etc/ssh/sshd_config.d/60-vpanel.conf
    owner: root:root
    permissions: '0644'
    content: |
      PermitRootLogin yes
      PasswordAuthentication yes
      KbdInteractiveAuthentication yes
runcmd:
  - sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config || true
  - sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config || true
  - sed -i 's/^KbdInteractiveAuthentication.*/KbdInteractiveAuthentication yes/' /etc/ssh/sshd_config || true
  - systemctl restart sshd 2>/dev/null || service ssh restart 2>/dev/null || true
${agentSeedPayload(vm).map((c) => '  - ' + c).join('\n')}
`
  );
  fs.writeFileSync(
    path.join(dir, 'meta-data'),
    `instance-id: iid-${vm.uuid || vm.name}\nlocal-hostname: ${vm.hostname || vm.name}\n`
  );
  const r = spawnSync('cloud-localds', [path.join(dir, 'seed.iso'), path.join(dir, 'user-data'), path.join(dir, 'meta-data')], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`cloud-localds failed: ${r.stderr || r.stdout}`);
  }
}

async function create({ user, data }) {
  const osList = getOsList();
  const osEntry = osList.find((o) => o[0] === data.os) || osList[0];
  const vmName = String(data.name || '').trim().replace(/\s+/g, '-');
  if (!vmName || !/^[a-zA-Z0-9_-]+$/.test(vmName)) {
    throw new Error('VM name can only contain letters, numbers, hyphens, underscores');
  }
  const exists = await collections.vms.findOne({ name: vmName, owner_id: user.id });
  if (exists) throw new Error(`VM "${vmName}" already exists`);

  const kind = data.kind ? String(data.kind).trim() : 'qemu-dedicated';
  if (!isKnownKind(kind)) {
    throw Object.assign(new Error(`Unknown deployment type "${kind}".`), { category: 'invalid_request' });
  }
  const kindDefinition = definitionFor(kind);
  const containerKind = isContainerKind(kind);
  const defaultImage = kindDefinition.runtime === 'docker' ? 'ubuntu:24.04' : 'images:ubuntu/24.04';
  const image = containerKind ? String(data.image || defaultImage).trim() : '';
  if (containerKind && !isValidImage(kind, image)) {
    throw Object.assign(new Error('Choose a valid container image reference.'), { category: 'invalid_request' });
  }
  if (containerKind && data.upload_image) {
    throw Object.assign(new Error('Container deployments pull an image by reference; disk-image uploads are only for QEMU VMs.'), { category: 'invalid_request' });
  }

  const nodeId = parseInt(data.node_id, 10) || 1;
  const remoteNode = await getRemoteNode(nodeId);
  if (nodeId !== 1 && !remoteNode) throw new Error('The selected node does not exist.');
  if (remoteNode && remoteNode.wings_enabled === 0) throw new Error(`Node "${remoteNode.name}" is not a Wings compute node.`);
  const isRemote = Boolean(remoteNode);
  if (isRemote && data.upload_image) {
    throw new Error('Uploading a disk image is only supported on the local node. Deploy from a cloud image on remote nodes.');
  }
  if (isRemote && !wingsGateway.isOnline(nodeId)) {
    throw new Error(`Node "${remoteNode.name}" is offline. Start the Wings service on that VPS before creating VMs there.`);
  }

  if (containerKind) {
    const available = isRemote
      ? runtimes.capabilities.normalizeIncoming(remoteNode.runtime_capabilities)
      : runtimes.capabilities.detectCached();
    runtimes.capabilities.assertKindAvailable(kind, available, {
      nodeName: isRemote ? (remoteNode.name || `node ${nodeId}`) : 'the panel host',
    });
  }

  const hostname = String(data.hostname || vmName).replace(/\s+/g, '-');
  const imageUser = containerKind
    ? ((imageEntry(kind, image) || {}).username || (kindDefinition.runtime === 'docker' ? 'root' : 'ubuntu'))
    : '';
  const username = String(data.username || imageUser || osEntry[4] || 'root').toLowerCase();
  const password = String(data.password || 'vpanel' + Math.random().toString(36).slice(2, 8));
  const diskSize = String(data.disk_size || settings.get('vm.default_disk') || '20G').toUpperCase();
  const memory = parseInt(data.memory || settings.get('vm.default_memory') || '2048', 10);
  const cpus = parseInt(data.cpus || settings.get('vm.default_cpus') || '2', 10);
  const sshPort = data.ssh_port ? parseInt(data.ssh_port, 10) : await allocPort();
  if (isNaN(sshPort) || sshPort < 23 || sshPort > 65535) throw new Error('Invalid SSH port');
  if (!isRemote && inUsePort(sshPort)) throw new Error(`Port ${sshPort} is already in use`);
  const vncPort = containerKind ? 0 : await allocVncPort();
  const agentPort = containerKind ? 0 : await allocAgentPort();
  const agentToken = genAgentToken();
  const guiMode = data.gui_mode === true || data.gui_mode === '1' || data.gui_mode === 'true';
  const forwards = normalizePortForwards(Array.isArray(data.port_forwards) ? data.port_forwards : []);
  const access = normalizeAccess(data.access && typeof data.access === 'object' ? data.access : {
    ssh: data.access_ssh, terminal: data.access_terminal, ports: data.access_ports,
  });
  const limits = {
    cpu_quota_percent: Math.round(cpus * 100),
    memory_max_mb: memory,
    pids_limit: 512,
  };

  if (process.env.CAPACITY_ENFORCEMENT !== '0') {
    await capacityService.assertCapacity({ nodeId, kind, cpus, memory, disk_size: diskSize });
  }

  const id = await getNextId('vms');
  const dir = path.join(VM_DIR, String(id));
  if (!isRemote && !containerKind) fs.mkdirSync(dir, { recursive: true });

  const vm = {
    id,
    uuid: uuidv4(),
    owner_id: user.id,
    name: vmName,
    kind,
    runtime: kindDefinition.runtime,
    image,
    access: JSON.stringify(access),
    limits: JSON.stringify(limits),
    runtime_ref: '',
    os_type: containerKind ? image : (osEntry[1] || ''),
    codename: osEntry[2] || '',
    img_url: osEntry[3] || '',
    hostname,
    username,
    password,
    disk_size: diskSize,
    memory,
    cpus,
    ssh_port: sshPort,
    vnc_port: vncPort,
    agent_port: agentPort,
    agent_token: agentToken,
    gui_mode: guiMode ? 1 : 0,
    port_forwards: JSON.stringify(forwards),
    img_file: containerKind ? '' : path.join(dir, 'disk.qcow2'),
    seed_file: containerKind ? '' : path.join(dir, 'seed.iso'),
    start_on_boot: data.start_on_boot ? 1 : 0,
    startup_command: data.startup_command || '',
    status: 'stopped',
    notes: data.notes || '',
    node_id: nodeId,
    node_name: remoteNode ? remoteNode.name : 'Local Cluster / Node 1',
    node_host: remoteNode ? (remoteNode.ssh_ip || remoteNode.fqdn || '') : '',
    remote_dir: isRemote ? `/var/lib/wings/vms/${id}` : '',
    created_at: now(),
    updated_at: now(),
  };

  if (isRemote) {
    await validateHostForwards(vm, forwards, { isPortAvailable: async () => true });
    await collections.vms.insertOne(vm);

    await setDbStatus(id, 'provisioning');
    try {
      const result = await wingsGateway.request(nodeId, 'vm_create', {
        id,
        uuid: vm.uuid,
        name: vmName,
        hostname,
        username,
        password,
        os_type: vm.os_type,
        img_url: vm.img_url,
        memory,
        cpus,
        disk_size: diskSize,
        ssh_port: sshPort,
        vnc_port: vncPort,
        agent_port: agentPort,
        port_forwards: forwards,
        gui_mode: guiMode ? 1 : 0,
        start_on_boot: vm.start_on_boot,
        kind,
        runtime: kindDefinition.runtime,
        image,
        access,
        limits,
      }, (containerKind ? 25 : 15) * 60 * 1000);

      await collections.vms.updateOne({ id }, {
        $set: {
          status: (result && result.status) || 'stopped',
          runtime_ref: (result && (result.runtime_ref || result.name)) || '',
          remote_dir: (result && result.dir) || vm.remote_dir,
          img_file: (result && result.disk_path) || null,
          seed_file: (result && result.seed_path) || null,
          updated_at: now(),
        },
      });
    } catch (error) {
      await collections.vms.updateOne({ id }, { $set: { status: 'failed', img_file: null, seed_file: null, updated_at: now() } }).catch(() => {});
      await logActivity({ user_id: user.id, vm_id: id, event: 'vm:create_failed', details: { name: vmName, node_id: nodeId, error: error.message } });
      throw new Error(`Node "${remoteNode.name}" could not provision this VM: ${error.message}`);
    }

    await logActivity({ user_id: user.id, vm_id: id, event: 'vm:create', details: { name: vmName, port: sshPort, node_id: nodeId } });
    return getVm(id);
  }

  await validateHostForwards(vm, forwards);
  await collections.vms.insertOne(vm);

  if (containerKind) {
    await setDbStatus(id, 'provisioning');
    try {
      const result = await runtimes.create(vm);
      await collections.vms.updateOne({ id }, {
        $set: {
          status: result.status || 'running',
          runtime_ref: result.runtime_ref || `vpanel-${id}`,
          updated_at: now(),
        },
      });
    } catch (error) {
      if (error.runtimeCleaned) {
        // No workload exists, so do not leave a phantom row consuming capacity.
        await collections.vms.deleteOne({ id }).catch(() => {});
      } else {
        await collections.vms.updateOne({ id }, { $set: { status: 'failed', updated_at: now() } }).catch(() => {});
      }
      await logActivity({ user_id: user.id, vm_id: id, event: 'vm:create_failed', details: { name: vmName, kind, error: error.message } });
      throw error;
    }
    await logActivity({ user_id: user.id, vm_id: id, event: 'vm:create', details: { name: vmName, kind, image, node_id: nodeId } });
    return getVm(id);
  }

  const img = vm.img_file;
  if (!fs.existsSync(img)) {
    if (data.upload_image && data.upload_image.originalname && data.upload_image.size) {
      fs.copyFileSync(data.upload_image.path, img);
      logger.info('[vm] using uploaded image');
      const info = spawnSync('qemu-img', ['info', '--output=json', img], { encoding: 'utf8' });
      let fmt = null;
      try { fmt = JSON.parse(info.stdout).format; } catch (_) {}
      if (fmt && fmt !== 'qcow2') {
        logger.info(`[vm] uploaded image format is ${fmt}; converting to qcow2`);
        const tmp = img + '.conv';
        const conv = spawnSync('qemu-img', ['convert', '-O', 'qcow2', img, tmp], { encoding: 'utf8' });
        if (conv.status !== 0) throw new Error('Failed to convert uploaded image: ' + (conv.stderr || ''));
        fs.unlinkSync(img);
        fs.renameSync(tmp, img);
      }
    } else {
      if (!hasBin('wget')) throw new Error('wget is required to download cloud images');
      const r = spawnSync('qemu-img', ['info', img], { encoding: 'utf8' });
      if (!fs.existsSync(img) || r.status !== 0) {
        logger.info(`[vm] downloading base image for ${osEntry[0]}`);
        if (vm.img_url.endsWith('.tar.xz')) {
          const archive = path.join(dir, 'cloud-image.tar.xz');
          await download(vm.img_url, archive);
          extractQcow2Archive(archive, img, dir);
          fs.unlinkSync(archive);
        } else {
          await download(vm.img_url, img);
        }
      }
    }
  }

  const resize = spawnSync('qemu-img', ['resize', img, diskSize], { encoding: 'utf8' });
  if (resize.status !== 0) {
    logger.warn('[vm] resize failed (image may be unformatted): ' + (resize.stderr || ''));
  }

  writeSeed(vm);
  await setDbStatus(id, 'stopped');
  await logActivity({ user_id: user.id, vm_id: id, event: 'vm:create', details: { name: vmName, port: sshPort } });

  return getVm(id);
}

async function startRemoteVm(vm, { user = null } = {}) {
  if (vm.status === 'running') return { ok: true, noop: true, state: 'running', message: 'already running' };
  if (vm.suspended) throw Object.assign(new Error('This VM is suspended and cannot be started.'), { category: 'vm_suspended' });
  await setDbStatus(vm.id, 'starting');
  try {
    await wingsGateway.request(vm.node_id, 'vm_start', { vm_id: Number(vm.id) });
    await setDbStatus(vm.id, 'running');
  } catch (error) {
    await setDbStatus(vm.id, 'stopped');
    throw Object.assign(new Error(`Wings node ${vm.node_id} could not start this VM: ${error.message}`), { category: 'vm_start_failed' });
  }
  await logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:start', details: { node_id: vm.node_id } });
  return { ok: true, state: 'running' };
}

async function stopRemoteVm(vm, { user = null, force = false } = {}) {
  if (vm.status !== 'running') {
    await setDbStatus(vm.id, 'stopped');
    return { ok: true, noop: true, state: 'stopped', message: 'not running' };
  }
  try {
    await wingsGateway.request(vm.node_id, 'vm_stop', { vm_id: Number(vm.id), force: Boolean(force) }, 90000);
  } catch (error) {
    throw Object.assign(new Error(`Wings node ${vm.node_id} could not stop this VM: ${error.message}`), { category: 'operation_uncertain' });
  }
  await setDbStatus(vm.id, 'stopped');
  await logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: force ? 'vm:kill' : 'vm:stop', details: { node_id: vm.node_id } });
  return { ok: true, state: 'stopped' };
}

function containerTarget(vm) {
  return vm.runtime_ref || `vpanel-${Number(vm.id)}`;
}

function containerActualRunning(vm) {
  if (isRemoteVm(vm)) return vm.status === 'running';
  try {
    return runtimes.status({ ...vm, runtime_ref: containerTarget(vm) }) === 'running';
  } catch (_) {
    return vm.status === 'running';
  }
}

async function startContainerVm(vm, { user = null } = {}) {
  if (isRemoteVm(vm)) return startRemoteVm(vm, { user });
  if (containerActualRunning(vm)) {
    if (vm.status !== 'running') await setDbStatus(vm.id, 'running');
    return { ok: true, noop: true, state: 'running', message: 'already running' };
  }
  if (vm.suspended) throw Object.assign(new Error('This deployment is suspended and cannot be started.'), { category: 'vm_suspended' });
  await setDbStatus(vm.id, 'starting');
  try {
    await runtimes.start({ ...vm, runtime_ref: containerTarget(vm) });
  } catch (error) {
    await setDbStatus(vm.id, 'stopped').catch(() => {});
    throw Object.assign(new Error(`Could not start this deployment: ${error.message}`), { category: error.category || 'runtime_start_failed' });
  }
  await setDbStatus(vm.id, 'running');
  await logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:start', details: { kind: vm.kind } });
  return { ok: true, state: 'running' };
}

async function stopContainerVm(vm, { user = null, force = false } = {}) {
  if (isRemoteVm(vm)) return stopRemoteVm(vm, { user, force });
  if (!containerActualRunning(vm)) {
    await setDbStatus(vm.id, 'stopped');
    return { ok: true, noop: true, state: 'stopped', message: 'not running' };
  }
  try {
    await runtimes.stop({ ...vm, runtime_ref: containerTarget(vm) }, { force });
  } catch (error) {
    throw Object.assign(
      new Error('The runtime stop could not be confirmed; inspect the deployment before retrying.'),
      { category: 'operation_uncertain' },
    );
  }
  await setDbStatus(vm.id, 'stopped');
  await logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: force ? 'vm:kill' : 'vm:stop', details: { kind: vm.kind } });
  return { ok: true, state: 'stopped' };
}

async function startUnlocked(vm, { user = null } = {}) {
  if (isContainerVm(vm)) return startContainerVm(vm, { user });
  if (isRemoteVm(vm)) return startRemoteVm(vm, { user });
  if (isRunning(vm)) return { ok: true, noop: true, state: 'running', message: 'already running' };
  if (vm.suspended) throw Object.assign(new Error('This VM is suspended and cannot be started.'), { category: 'vm_suspended' });
  if (!vm.img_file || !fs.existsSync(vm.img_file)) throw Object.assign(new Error('VM disk image is unavailable.'), { category: 'vm_image_unavailable' });
  if (!fs.existsSync(vm.seed_file)) {
    writeSeed(vm);
  }
  await ensureVncPort(vm);
  await ensureAgentPort(vm);
  const forwards = await validateHostForwards(vm, vm.port_forwards);
  if (JSON.stringify(forwards) !== JSON.stringify(parseForwards(vm.port_forwards))) {
    vm.port_forwards = forwards;
    await collections.vms.updateOne(
      { id: Number(vm.id) },
      { $set: { port_forwards: JSON.stringify(forwards), updated_at: now() } }
    );
    try {
      fs.appendFileSync(path.join(vmDir(vm), 'boot.log'),
        `\r\n[vPanel] Host port conflicts were automatically remapped: ${forwards.map((forward) => `${forward.host}:${forward.guest}`).join(', ')}\r\n`,
        'utf8');
    } catch (_) {}
  }
  const dir = vmDir(vm);
  const bootLogPath = path.join(dir, 'boot.log');
  const sessionHeader = `\r\n=== [vPanel] Starting VM "${vm.name}" at ${new Date().toISOString()} ===\r\n\r\n`;
  try {
    fs.appendFileSync(bootLogPath, sessionHeader, 'utf8');
  } catch (_) {}
  const qemuLogPath = path.join(dir, 'qemu.log');
  const logFile = fs.openSync(qemuLogPath, 'a');
  const qemuLogOffset = fs.fstatSync(logFile).size;
  const args = buildQemuArgs(vm);
  // Hard CPU/RAM caps require a foreground QEMU inside a transient systemd scope;
  // -daemonize would detach the process from the scope and silently drop the limits.
  const useCgroups = runtimes.qemuLimits.systemdAvailable();
  if (useCgroups) {
    const daemonizeIndex = args.indexOf('-daemonize');
    if (daemonizeIndex >= 0) args.splice(daemonizeIndex, 1);
  }
  const launch = useCgroups
    ? runtimes.qemuLimits.wrap(vm, ['qemu-system-x86_64', ...args])
    : { command: 'qemu-system-x86_64', args, wrapped: false };
  logger.info(`[vm] starting VM ${Number(vm.id)} with QEMU${launch.wrapped ? ' (hard cgroup limits active)' : ''}`);
  if (!launch.wrapped) {
    logger.warn('[vm] systemd cgroups are unavailable on this host; QEMU is starting without a hard CPU/memory ceiling');
  }
  let spawnError = null;
  let exited = false;
  const child = spawn(launch.command, launch.args, { stdio: ['ignore', logFile, logFile] });
  const closeLog = () => { try { fs.closeSync(logFile); } catch (_) {} };
  child.once('error', (error) => { spawnError = error; closeLog(); });
  child.once('exit', () => { exited = true; closeLog(); setDbStatus(vm.id, 'stopped').catch(() => {}); });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (spawnError) {
      await setDbStatus(vm.id, 'stopped').catch(() => {});
      throw Object.assign(new Error('QEMU could not start this VM.'), { category: 'vm_start_failed' });
    }
    if (isRunning(vm)) {
      await setDbStatus(vm.id, 'running');
      if (!isRunning(vm)) {
        await setDbStatus(vm.id, 'stopped').catch(() => {});
        throw Object.assign(new Error('QEMU exited before the VM start could be confirmed.'), { category: 'vm_start_failed' });
      }
      await logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:start' });
      return { ok: true, state: 'running' };
    }
    if (exited) throw Object.assign(new Error(qemuStartFailure(vm, qemuLogOffset)), { category: 'vm_start_failed' });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (isRunning(vm)) {
    await setDbStatus(vm.id, 'running');
    if (!isRunning(vm)) {
      await setDbStatus(vm.id, 'stopped').catch(() => {});
      throw Object.assign(new Error('QEMU exited before the VM start could be confirmed.'), { category: 'vm_start_failed' });
    }
    return { ok: true, state: 'running' };
  }
  throw Object.assign(new Error('QEMU start timed out; the final VM state is uncertain. Inspect the VM before retrying.'), { category: 'operation_uncertain' });
}

async function stopUnlocked(vm, { user = null, force = false } = {}) {
  if (isContainerVm(vm)) return stopContainerVm(vm, { user, force });
  if (isRemoteVm(vm)) return stopRemoteVm(vm, { user, force });
  const identity = qemuProcess(vm);
  if (!identity) {
    await setDbStatus(vm.id, 'stopped');
    return { ok: true, noop: true, state: 'stopped', message: 'not running' };
  }
  try {
    process.kill(identity.pid, force ? 'SIGKILL' : 'SIGTERM');
    if (!force) {
      const end = Date.now() + 5000;
      while (Date.now() < end && sameQemuProcess(vm, identity)) await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (sameQemuProcess(vm, identity)) process.kill(identity.pid, 'SIGKILL');
  } catch (e) {
    if (e.code !== 'ESRCH') throw Object.assign(new Error('QEMU stop could not be confirmed; inspect the VM before retrying.'), { category: 'operation_uncertain' });
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && sameQemuProcess(vm, identity)) await new Promise((resolve) => setTimeout(resolve, 150));
  if (sameQemuProcess(vm, identity)) throw Object.assign(new Error('QEMU is still running after the stop request; inspect the VM before retrying.'), { category: 'operation_uncertain' });
  try { fs.unlinkSync(path.join(vmDir(vm), 'qemu.pid')); } catch (_) {}
  await setDbStatus(vm.id, 'stopped');
  await logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: force ? 'vm:kill' : 'vm:stop' });
  return { ok: true, state: 'stopped' };
}

async function start(vm, options = {}) {
  return withVmOperation({ vmId: vm.id, actorId: options.user?.id, operationId: options.operationId, action: 'start', validate: options.validate, execute: () => startUnlocked(vm, options) });
}

async function stop(vm, options = {}) {
  return withVmOperation({ vmId: vm.id, actorId: options.user?.id, operationId: options.operationId, action: 'stop', validate: options.validate, execute: () => stopUnlocked(vm, options) });
}

async function restart(vm, user, options = {}) {
  return withVmOperation({
    vmId: vm.id, actorId: user?.id, operationId: options.operationId, action: 'restart', validate: options.validate,
    execute: async () => {
      const stopped = await stopUnlocked(vm, { user });
      if (stopped.state !== 'stopped') throw Object.assign(new Error('VM stop could not be verified; restart was cancelled.'), { category: 'operation_uncertain' });
      await new Promise((resolve) => setTimeout(resolve, 500));
      return startUnlocked(vm, { user });
    },
  });
}

async function removeUnlocked(vm, user) {
  if (isRemoteVm(vm)) {
    if (!wingsGateway.isOnline(vm.node_id)) {
      throw new Error(`Node ${vm.node_id} is offline. Reconnect Wings before deleting this VM so its disk is not orphaned.`);
    }
    await wingsGateway.request(vm.node_id, 'vm_delete', { vm_id: Number(vm.id) }, 120000);
    await collections.backups.deleteMany({ vm_id: Number(vm.id) });
    await collections.schedules.deleteMany({ vm_id: Number(vm.id) });
    await collections.subusers.deleteMany({ vm_id: Number(vm.id) });
    await collections.activity_logs.deleteMany({ vm_id: Number(vm.id) });
    await collections.vms.deleteOne({ id: Number(vm.id) });
    await logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:delete', details: { name: vm.name, node_id: vm.node_id } });
    return { ok: true };
  }

  if (isRunning(vm)) await stopUnlocked(vm, { user, force: true });
  if (isContainerVm(vm)) {
    try {
      await runtimes.remove({ ...vm, runtime_ref: containerTarget(vm) });
    } catch (error) {
      logger.warn('[vm] runtime cleanup error: ' + error.message);
    }
  } else {
    try {
      await fs.promises.rm(vmDir(vm), { recursive: true, force: true });
    } catch (e) {
      logger.warn('[vm] cleanup error: ' + e.message);
    }
  }
  await collections.backups.deleteMany({ vm_id: Number(vm.id) });
  await collections.schedules.deleteMany({ vm_id: Number(vm.id) });
  await collections.subusers.deleteMany({ vm_id: Number(vm.id) });
  await collections.activity_logs.deleteMany({ vm_id: Number(vm.id) });
  await collections.vms.deleteOne({ id: Number(vm.id) });
  await logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:delete', details: { name: vm.name } });
  return { ok: true };
}

async function remove(vm, user) {
  return withVmOperation({ vmId: vm.id, actorId: user?.id, action: 'delete', execute: () => removeUnlocked(vm, user) });
}

async function update(vm, data, user) {
  return withVmOperation({ vmId: vm.id, actorId: user?.id, action: 'update', execute: async () => updateUnlocked(vm, data, user) });
}

async function updateUnlocked(vm, data, user) {
  const fields = [
    'name', 'hostname', 'username', 'password', 'memory', 'cpus', 'disk_size',
    'gui_mode', 'port_forwards', 'start_on_boot', 'startup_command', 'notes',
    'owner_id', 'description', 'external_id', 'exp_date', 'threads', 'swap',
    'suspended', 'node_id', 'node_name'
  ];
  const $set = {};
  if (data.port_forwards !== undefined) {
    $set.port_forwards = JSON.stringify(await validateHostForwards(vm, data.port_forwards));
  }
  for (const f of fields) {
    if (data[f] !== undefined) {
      if (f === 'port_forwards') continue;
      if (f === 'gui_mode' || f === 'start_on_boot') $set[f] = data[f] ? 1 : 0;
      else if (f === 'owner_id') $set[f] = parseInt(data[f], 10);
      else $set[f] = data[f];
    }
  }
  if (isContainerVm(vm) && (data.cpus !== undefined || data.memory !== undefined)) {
    if (isRemoteVm(vm)) throw new Error('Resize this deployment on the node that hosts it.');
    const driver = runtimes.driverForKind(vm.kind);
    if (!driver || typeof driver.updateLimits !== 'function') {
      throw new Error('This runtime cannot change resources in place; create a new deployment instead.');
    }
    // Apply the runtime limit first so a failed runtime update never leaves the
    // database promising resources the workload does not have.
    await driver.updateLimits({ ...vm, ...data, runtime_ref: containerTarget(vm) });
  }
  if (Object.keys($set).length) {
    $set.updated_at = now();
    await collections.vms.updateOne({ id: Number(vm.id) }, { $set });
  }
  const needSeed = !isRemoteVm(vm) && !isContainerVm(vm) && ['hostname', 'username', 'password'].some((f) => data[f] !== undefined);
  if (needSeed) writeSeed(vm);
  await logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:update', details: data });
  return getVm(vm.id);
}

async function transferOwner(vm, newOwnerId, actor) {
  return withVmOperation({ vmId: vm.id, actorId: actor?.id, action: 'transfer_owner', execute: async () => {
    const targetUser = await collections.users.findOne({ id: Number(newOwnerId) });
    if (!targetUser) throw new Error('Target user not found');
    const currentVm = await getVm(vm.id);
    if (!currentVm) throw new Error('VM not found');
    await collections.vms.updateOne({ id: Number(vm.id) }, { $set: { owner_id: targetUser.id, updated_at: now() } });
    await logActivity({ user_id: actor ? actor.id : null, vm_id: vm.id, event: 'vm:transfer_owner', details: { from: currentVm.owner_id, to: targetUser.id, target_username: targetUser.username } });
    return getVm(vm.id);
  } });
}

async function resizeDiskUnlocked(vm, newSize, user) {
  if (isContainerVm(vm)) throw new Error('Disk resizing is not supported for container deployments.');
  if (isRunning(vm)) throw new Error('Cannot resize disk while VM is running. Stop the VM first.');
  if (!/^[0-9]+[GM]$/i.test(newSize)) throw new Error('Disk size must be like 50G or 512M');
  await runBoundedProcess('qemu-img', ['resize', vm.img_file, newSize], 120000);
  await collections.vms.updateOne({ id: Number(vm.id) }, { $set: { disk_size: newSize.toUpperCase(), updated_at: now() } });
  await logActivity({ user_id: user ? user.id : null, vm_id: vm.id, event: 'vm:resize', details: { newSize } });
  return getVm(vm.id);
}

async function resizeDisk(vm, newSize, user) {
  return withVmOperation({ vmId: vm.id, actorId: user?.id, action: 'resize', execute: () => resizeDiskUnlocked(vm, newSize, user) });
}

async function withVmOperationLock(vm, { user = null, action, execute } = {}) {
  return withVmOperation({ vmId: vm.id, actorId: user?.id, action, execute });
}

async function restoreDiskUnderVmLock(vm, { user = null, restore } = {}) {
  if (typeof restore !== 'function') throw new TypeError('A backup restore operation is required.');
  const outcome = await withVmOperation({
    vmId: vm.id, actorId: user?.id, action: 'backup_restore',
    execute: async () => {
      if (isRunning(vm)) await stopUnlocked(vm, { user, force: true });
      const result = await restore();
      return { ok: true, state: 'stopped', result };
    },
  });
  return outcome.result;
}

function usage() {
  const runtimesUsage = runtimes.localAvailability();
  return {
    qemu: hasBin('qemu-system-x86_64'),
    cloudLocalds: hasBin('cloud-localds'),
    wget: hasBin('wget'),
    kvm: hasBin('qemu-kvm') || hasBin('/usr/libexec/qemu-kvm'),
    docker: runtimesUsage.runtimes.docker.available,
    lxc: runtimesUsage.runtimes.lxc.available,
    incus: runtimesUsage.runtimes.incus.available,
  };
}

function uptimeSeconds(vm) {
  const pid = pidOf(vm);
  if (!pid) return 0;
  try {
    const out = execSync(`ps -o etimes= -p ${pid}`, { encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024 }).trim();
    return parseInt(out, 10) || 0;
  } catch (_) { return 0; }
}

function memUsage(vm) {
  const pid = pidOf(vm);
  if (!pid) return 0;
  try {
    const out = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024 }).trim();
    return (parseInt(out, 10) || 0) * 1024;
  } catch (_) { return 0; }
}

function totalDiskUsage() {
  try {
    const out = execSync(`du -sb ${VM_DIR}`, { encoding: 'utf8' });
    return parseInt(out.split('\t')[0], 10) || 0;
  } catch (_) { return 0; }
}

async function syncContainerStates() {
  const kinds = runtimes.definitions.KIND_ORDER.filter((kind) => isContainerKind(kind));
  const rows = await collections.vms.find({ kind: { $in: kinds } }).toArray();
  let changed = 0;
  for (const row of rows) {
    if (isRemoteVm(row)) continue;
    if (row.status === 'failed' || row.status === 'provisioning') continue;
    let actual;
    try {
      actual = runtimes.status({ ...row, runtime_ref: containerTarget(row) }) === 'running' ? 'running' : 'stopped';
    } catch (_) {
      continue;
    }
    if (row.status !== actual) {
      await collections.vms.updateOne({ id: Number(row.id) }, { $set: { status: actual, updated_at: now() } });
      changed += 1;
    }
  }
  return changed;
}

async function startOnBootAll() {
  const rawVms = await collections.vms.find({ start_on_boot: 1 }).toArray();
  const vms = rawVms.map(serializeVm);
  for (const vm of vms) {
    try { await start(vm); } catch (e) { logger.error('[vm] autostart failed ' + vm.name + ': ' + e.message); }
  }
}

function cpuUsage(vm) {
  const pid = pidOf(vm);
  if (!pid) return 0;
  try {
    const out = execSync(`ps -o %cpu= -p ${pid}`, { encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024 }).trim();
    return Math.round((parseFloat(out) || 0) * 10) / 10;
  } catch (_) { return 0; }
}

function diskActualUsage(vm) {
  try {
    if (vm.img_file && fs.existsSync(vm.img_file)) {
      return fs.statSync(vm.img_file).size;
    }
  } catch (_) {}
  return 0;
}

function containerLiveStats(vm) {
  const running = isRunning(vm);
  let observed = { cpu_percent: 0, memory_bytes: 0 };
  if (running && !isRemoteVm(vm)) {
    try { observed = runtimes.stats({ ...vm, runtime_ref: containerTarget(vm) }) || observed; } catch (_) {}
  } else if (running) {
    const cached = wingsGateway.statsCache.get(Number(vm.node_id));
    const active = cached && cached.stats && cached.stats.vms && Array.isArray(cached.stats.vms.active_top_vms)
      ? cached.stats.vms.active_top_vms.find((entry) => Number(entry.id) === Number(vm.id))
      : null;
    if (active) observed = { cpu_percent: Number(active.cpu_percent) || 0, memory_bytes: (Number(active.memory_mb) || 0) * 1024 * 1024 };
  }
  const usedBytes = Number(observed.memory_bytes) || 0;
  const totalMemBytes = (parseInt(vm.memory, 10) || 1024) * 1024 * 1024;
  const memPct = totalMemBytes > 0 ? Math.min(100, Math.round((usedBytes / totalMemBytes) * 100)) : 0;
  return {
    id: vm.id,
    name: vm.name,
    kind: vm.kind,
    runtime: definitionFor(vm.kind).runtime,
    status: running ? 'running' : 'stopped',
    running,
    pid: null,
    uptime: 0,
    cpu: { percent: Number(observed.cpu_percent) || 0, cpus: vm.cpus || 1 },
    memory: {
      used_bytes: usedBytes,
      used_mb: Math.round(usedBytes / 1024 / 1024),
      total_mb: vm.memory,
      percent: memPct,
    },
    disk: {
      allocated: vm.disk_size,
      actual_bytes: 0,
      actual_mb: 0,
      percent: 0,
    },
    ports: { ssh: vm.ssh_port, vnc: null, agent: null },
    updated_at: new Date().toISOString(),
  };
}

function liveStats(vm) {
  if (isContainerVm(vm)) return containerLiveStats(vm);
  const running = isRunning(vm);
  const pid = running ? pidOf(vm) : null;
  const uptime = running ? uptimeSeconds(vm) : 0;
  const memUsedBytes = running ? memUsage(vm) : 0;
  const cpuPct = running ? cpuUsage(vm) : 0;
  const totalMemBytes = (parseInt(vm.memory, 10) || 1024) * 1024 * 1024;
  const memPct = totalMemBytes > 0 ? Math.min(100, Math.round((memUsedBytes / totalMemBytes) * 100)) : 0;
  const diskBytes = diskActualUsage(vm);
  let totalDiskBytes = 20 * 1024 * 1024 * 1024;
  if (vm.disk_size) {
    const m = String(vm.disk_size).trim().match(/^(\d+)([GMK]?)$/i);
    if (m) {
      const num = parseInt(m[1], 10);
      const unit = (m[2] || 'G').toUpperCase();
      if (unit === 'G') totalDiskBytes = num * 1024 * 1024 * 1024;
      else if (unit === 'M') totalDiskBytes = num * 1024 * 1024;
      else if (unit === 'K') totalDiskBytes = num * 1024;
    }
  }
  const diskPct = totalDiskBytes > 0 ? Math.min(100, Math.round((diskBytes / totalDiskBytes) * 100)) : 0;

  return {
    id: vm.id,
    name: vm.name,
    status: running ? 'running' : 'stopped',
    running,
    pid,
    uptime,
    cpu: {
      percent: cpuPct,
      cpus: vm.cpus || 1,
    },
    memory: {
      used_bytes: memUsedBytes,
      used_mb: Math.round(memUsedBytes / 1024 / 1024),
      total_mb: vm.memory,
      percent: memPct,
    },
    disk: {
      allocated: vm.disk_size,
      actual_bytes: diskBytes,
      actual_mb: Math.round(diskBytes / 1024 / 1024),
      percent: diskPct,
    },
    ports: {
      ssh: vm.ssh_port,
      vnc: vm.vnc_port,
      agent: vm.agent_port,
    },
    updated_at: new Date().toISOString(),
  };
}

module.exports = {
  VM_DIR, vmDir, dbVms, getVm, create, start, stop, restart, remove, update,
  resizeDisk, isRunning, statusOf, serializeVm, canAccess, allocPort, allocVncPort, allocAgentPort, isContainerVm, containerTarget,
  parseForwards, normalizePortForwards, validateHostForwards, checkHostPortAvailable, explainQemuStartFailure, qemuStartFailure, buildQemuArgs, usage, uptimeSeconds, memUsage, cpuUsage, diskActualUsage, liveStats, totalDiskUsage, startOnBootAll, syncContainerStates, getOsList, getBootLog, clearBootLog, hasKvm, transferOwner, withVmOperationLock, restoreDiskUnderVmLock, runBoundedProcess,
};
