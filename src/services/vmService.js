const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn, execSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('../lib/config');
const { collections, getNextId, settings, ensureConnected } = require('../lib/db');
const logger = require('../lib/logger');
const { logActivity } = require('./activityService');
const { createVmOperationCoordinator } = require('./vmOperationCoordinator');

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
  for (const part of String(str).split(',')) {
    const m = part.trim().match(/^(\d+):(\d+)$/);
    if (m) out.push({ host: parseInt(m[1], 10), guest: parseInt(m[2], 10) });
  }
  return out;
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

  const args = [
    '-m', String(vm.memory),
    '-smp', String(vm.cpus),
    '-cpu', cpuType,
    '-machine', `type=pc,accel=${accelMode}`,
    '-drive', `file=${img},format=qcow2,if=virtio`,
    '-drive', `file=${seed},format=raw,if=virtio`,
    '-boot', 'order=c',
    '-device', 'virtio-net-pci,netdev=n0',
    '-netdev', `user,id=n0,hostfwd=tcp::${vm.ssh_port}-:22${vm.agent_port ? `,hostfwd=tcp::${vm.agent_port}-:9090` : ''}`,
    '-object', 'rng-random,filename=/dev/urandom,id=rng0',
    '-device', 'virtio-rng-pci,rng=rng0',
    '-rtc', 'base=utc,clock=host',
    '-device', 'virtio-balloon-pci',
  ];

  let ni = 1;
  for (const f of fwds) {
    args.push('-device', `virtio-net-pci,netdev=n${ni}`);
    args.push('-netdev', `user,id=n${ni},hostfwd=tcp::${f.host}-:${f.guest}`);
    ni++;
  }

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

function isRunning(vm) {
  return Boolean(qemuProcess(vm));
}

function statusOf(vm) {
  if (vm && vm.suspended) return 'suspended';
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
  const out = {
    ...row,
    uuid: rawUuid,
    uuidShort: rawUuid.slice(0, 8),
    port_forwards: forwards,
    gui_mode: !!row.gui_mode,
    start_on_boot: !!row.start_on_boot,
    suspended: !!row.suspended,
    status: statusOf(row),
    dir: vmDir(row),
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

  const hostname = String(data.hostname || vmName).replace(/\s+/g, '-');
  const username = String(data.username || osEntry[4] || 'root').toLowerCase();
  const password = String(data.password || 'vpanel' + Math.random().toString(36).slice(2, 8));
  const diskSize = String(data.disk_size || settings.get('vm.default_disk') || '20G').toUpperCase();
  const memory = parseInt(data.memory || settings.get('vm.default_memory') || '2048', 10);
  const cpus = parseInt(data.cpus || settings.get('vm.default_cpus') || '2', 10);
  const sshPort = data.ssh_port ? parseInt(data.ssh_port, 10) : await allocPort();
  if (isNaN(sshPort) || sshPort < 23 || sshPort > 65535) throw new Error('Invalid SSH port');
  if (inUsePort(sshPort)) throw new Error(`Port ${sshPort} is already in use`);
  const vncPort = await allocVncPort();
  const agentPort = await allocAgentPort();
  const agentToken = genAgentToken();
  const guiMode = data.gui_mode === true || data.gui_mode === '1' || data.gui_mode === 'true';
  const forwards = Array.isArray(data.port_forwards) ? data.port_forwards : [];

  const id = await getNextId('vms');
  const dir = path.join(VM_DIR, String(id));
  fs.mkdirSync(dir, { recursive: true });

  const vm = {
    id,
    uuid: uuidv4(),
    owner_id: user.id,
    name: vmName,
    os_type: osEntry[1] || '',
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
    img_file: path.join(dir, 'disk.qcow2'),
    seed_file: path.join(dir, 'seed.iso'),
    start_on_boot: data.start_on_boot ? 1 : 0,
    startup_command: data.startup_command || '',
    status: 'stopped',
    notes: data.notes || '',
    created_at: now(),
    updated_at: now(),
  };

  await collections.vms.insertOne(vm);

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
        await download(vm.img_url, img);
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

async function startUnlocked(vm, { user = null } = {}) {
  if (isRunning(vm)) return { ok: true, noop: true, state: 'running', message: 'already running' };
  if (vm.suspended) throw Object.assign(new Error('This VM is suspended and cannot be started.'), { category: 'vm_suspended' });
  if (!vm.img_file || !fs.existsSync(vm.img_file)) throw Object.assign(new Error('VM disk image is unavailable.'), { category: 'vm_image_unavailable' });
  if (!fs.existsSync(vm.seed_file)) {
    writeSeed(vm);
  }
  await ensureVncPort(vm);
  await ensureAgentPort(vm);
  const dir = vmDir(vm);
  const bootLogPath = path.join(dir, 'boot.log');
  const sessionHeader = `\r\n=== [vPanel] Starting VM "${vm.name}" at ${new Date().toISOString()} ===\r\n\r\n`;
  try {
    fs.appendFileSync(bootLogPath, sessionHeader, 'utf8');
  } catch (_) {}
  const logFile = fs.openSync(path.join(dir, 'qemu.log'), 'a');
  const args = buildQemuArgs(vm);
  logger.info(`[vm] starting VM ${Number(vm.id)} with QEMU`);
  let spawnError = null;
  let exited = false;
  const child = spawn('qemu-system-x86_64', args, { stdio: ['ignore', logFile, logFile] });
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
    if (exited) throw Object.assign(new Error('QEMU exited before the VM reached running state.'), { category: 'vm_start_failed' });
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
  if (isRunning(vm)) await stopUnlocked(vm, { user, force: true });
  try {
    await fs.promises.rm(vmDir(vm), { recursive: true, force: true });
  } catch (e) {
    logger.warn('[vm] cleanup error: ' + e.message);
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
  for (const f of fields) {
    if (data[f] !== undefined) {
      if (f === 'port_forwards' && Array.isArray(data[f])) $set[f] = JSON.stringify(data[f]);
      else if (f === 'gui_mode' || f === 'start_on_boot') $set[f] = data[f] ? 1 : 0;
      else if (f === 'owner_id') $set[f] = parseInt(data[f], 10);
      else $set[f] = data[f];
    }
  }
  if (Object.keys($set).length) {
    $set.updated_at = now();
    await collections.vms.updateOne({ id: Number(vm.id) }, { $set });
  }
  const needSeed = ['hostname', 'username', 'password'].some((f) => data[f] !== undefined);
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
  return {
    qemu: hasBin('qemu-system-x86_64'),
    cloudLocalds: hasBin('cloud-localds'),
    wget: hasBin('wget'),
    kvm: hasBin('qemu-kvm') || hasBin('/usr/libexec/qemu-kvm'),
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

function liveStats(vm) {
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
  resizeDisk, isRunning, statusOf, serializeVm, canAccess, allocPort, allocVncPort, allocAgentPort,
  parseForwards, usage, uptimeSeconds, memUsage, cpuUsage, diskActualUsage, liveStats, totalDiskUsage, startOnBootAll, getOsList, getBootLog, clearBootLog, hasKvm, transferOwner, withVmOperationLock, restoreDiskUnderVmLock, runBoundedProcess,
};
