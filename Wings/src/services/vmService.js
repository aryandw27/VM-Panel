'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
  getVmDir,
  getImagesDir,
  getSshUser,
  getNodeId,
  getVpsAddress,
} = require('../lib/config');
const logger = require('../lib/logger');
const client = require('../websocket/client');

const QEMU_BIN = 'qemu-system-x86_64';
const CACHE_TTL_MS = 60000;

let cpuSample = null;
let netSample = null;
let qemuVersionCache = { at: 0, version: 'QEMU' };

function fail(message) {
  return new Error(message);
}

function run(command, args, { timeout = 120000 } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout });
  if (result.error) throw fail(`${command} could not be executed: ${result.error.message}`);
  if (result.status !== 0) {
    throw fail(`${command} failed: ${(result.stderr || result.stdout || '').trim() || 'exit code ' + result.status}`);
  }
  return result.stdout;
}

function which(binary) {
  return spawnSync('which', [binary], { stdio: 'ignore' }).status === 0;
}

function hasKvm() {
  if (process.env.NO_KVM === '1' || process.env.NOKVM === '1') return false;
  try {
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

class VMService {
  constructor() {
    this.vmDir = getVmDir();
    this.imagesDir = getImagesDir();
    this.ensureDirectories();
  }

  ensureDirectories() {
    for (const dir of [this.vmDir, this.imagesDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  getVmPath(vmId) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(vmId))) throw fail('Invalid VM identifier');
    return path.join(this.vmDir, String(vmId));
  }

  getStatePath(vmId) {
    return path.join(this.getVmPath(vmId), 'state.json');
  }

  getDiskPath(vmId) {
    return path.join(this.getVmPath(vmId), 'disk.qcow2');
  }

  getSeedPath(vmId) {
    return path.join(this.getVmPath(vmId), 'seed.iso');
  }

  getPidFile(vmId) {
    return path.join(this.getVmPath(vmId), 'qemu.pid');
  }

  loadState(vmId) {
    const statePath = this.getStatePath(vmId);
    if (!fs.existsSync(statePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (error) {
      logger.warn(`Corrupt state file for VM ${vmId}`, { error: error.message });
      return null;
    }
  }

  saveState(vm) {
    const statePath = this.getStatePath(vm.id);
    fs.writeFileSync(statePath, JSON.stringify(vm, null, 2));
    return vm;
  }

  listVms() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.vmDir, { withFileTypes: true });
    } catch (_) {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.loadState(entry.name))
      .filter(Boolean);
  }

  pidOf(vmId) {
    try {
      const raw = fs.readFileSync(this.getPidFile(vmId), 'utf8').trim();
      if (!/^\d{1,10}$/.test(raw)) return null;
      return Number(raw);
    } catch (_) {
      return null;
    }
  }

  isRunning(vmId) {
    const pid = this.pidOf(vmId);
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return fs.existsSync(`/proc/${pid}`);
    } catch (_) {
      return false;
    }
  }

  statusOf(vm) {
    return this.isRunning(vm.id) ? 'running' : 'stopped';
  }

  ensureBaseImage(imgUrl) {
    if (!imgUrl) throw fail('No cloud image URL was supplied for this VM');
    fs.mkdirSync(this.imagesDir, { recursive: true });

    const hash = crypto.createHash('sha1').update(imgUrl).digest('hex').slice(0, 20);
    const cached = path.join(this.imagesDir, `${hash}.qcow2`);
    if (fs.existsSync(cached)) return cached;

    if (!which('wget')) throw fail('wget is required to download cloud images on this node');

    const isArchive = /\.tar\.xz($|\?)/i.test(imgUrl);
    const downloadPath = path.join(this.imagesDir, `${hash}${isArchive ? '.tar.xz' : '.qcow2'}.part`);
    const finalDownload = `${downloadPath}.done`;

    logger.info(`Downloading base image ${imgUrl}`);
    run('wget', ['-q', '--tries=3', '--timeout=120', '-O', downloadPath, imgUrl], { timeout: 30 * 60 * 1000 });
    fs.renameSync(downloadPath, finalDownload);

    if (isArchive) {
      const extractDir = fs.mkdtempSync(path.join(this.imagesDir, 'extract-'));
      try {
        run('tar', ['-xJf', finalDownload, '-C', extractDir], { timeout: 10 * 60 * 1000 });
        const member = fs.readdirSync(extractDir).find((name) => name.endsWith('.qcow2') && !name.includes('/'));
        if (!member) throw fail('The cloud image archive does not contain a QCOW2 disk');
        fs.renameSync(path.join(extractDir, member), cached);
      } finally {
        try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}
        try { fs.unlinkSync(finalDownload); } catch (_) {}
      }
    } else {
      fs.renameSync(finalDownload, cached);
    }

    return cached;
  }

  writeSeed(vm) {
    const dir = this.getVmPath(vm.id);
    const username = String(vm.username || getSshUser()).toLowerCase();
    const password = String(vm.password || crypto.randomBytes(6).toString('hex'));

    let passwordHash = '';
    const hashResult = spawnSync('openssl', ['passwd', '-6', password], { encoding: 'utf8' });
    if (hashResult.status === 0) passwordHash = String(hashResult.stdout).trim();

    const userData = [
      '#cloud-config',
      "output:",
      "  all: '| tee -a /dev/ttyS0 /dev/console'",
      `hostname: ${vm.hostname || vm.name}`,
      'ssh_pwauth: true',
      'disable_root: false',
      'users:',
      `  - name: ${username}`,
      '    sudo: ALL=(ALL) NOPASSWD:ALL',
      '    shell: /bin/bash',
      '    lock_passwd: false',
      ...(passwordHash ? [`    passwd: ${passwordHash}`] : []),
      'chpasswd:',
      '  list: |',
      `    root:${password}`,
      `    ${username}:${password}`,
      '  expire: false',
      'write_files:',
      '  - path: /etc/ssh/sshd_config.d/60-wings.conf',
      '    owner: root:root',
      "    permissions: '0644'",
      '    content: |',
      '      PermitRootLogin yes',
      '      PasswordAuthentication yes',
      '      KbdInteractiveAuthentication yes',
      'runcmd:',
      '  - systemctl restart sshd 2>/dev/null || service ssh restart 2>/dev/null || true',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(dir, 'user-data'), userData);
    fs.writeFileSync(path.join(dir, 'meta-data'), `instance-id: iid-${vm.uuid || vm.id}\nlocal-hostname: ${vm.hostname || vm.name}\n`);
    run('cloud-localds', [path.join(dir, 'seed.iso'), path.join(dir, 'user-data'), path.join(dir, 'meta-data')]);
  }

  qemuArgs(vm) {
    const dir = this.getVmPath(vm.id);
    const kvm = hasKvm();
    const forwards = Array.isArray(vm.port_forwards) ? vm.port_forwards : [];
    const hostForwards = [
      `hostfwd=tcp::${vm.ssh_port}-:22`,
      ...forwards
        .filter((forward) => Number(forward.host) > 0 && Number(forward.guest) > 0)
        .map((forward) => `hostfwd=tcp::${Number(forward.host)}-:${Number(forward.guest)}`),
    ];

    const args = [
      '-m', String(vm.memory || 2048),
      '-smp', String(vm.cpus || 2),
      '-cpu', kvm ? 'host' : 'qemu64',
      '-machine', `type=pc,accel=${kvm ? 'kvm:tcg' : 'tcg'}`,
      '-drive', `file=${this.getDiskPath(vm.id)},format=qcow2,if=virtio`,
      ...(fs.existsSync(this.getSeedPath(vm.id)) ? ['-drive', `file=${this.getSeedPath(vm.id)},format=raw,if=virtio`] : []),
      '-boot', 'order=c',
      '-device', 'virtio-net-pci,netdev=n0',
      '-netdev', `user,id=n0,${hostForwards.join(',')}`,
      '-object', 'rng-random,filename=/dev/urandom,id=rng0',
      '-device', 'virtio-rng-pci,rng=rng0',
      '-rtc', 'base=utc,clock=host',
      '-device', 'virtio-balloon-pci',
      '-display', 'none',
      '-serial', `file:${path.join(dir, 'boot.log')}`,
      '-pidfile', this.getPidFile(vm.id),
      '-daemonize',
    ];

    if (vm.vnc_port) {
      args.push('-vnc', `127.0.0.1:${Number(vm.vnc_port) - 5900}`);
    }

    return args;
  }

  createVm(payload) {
    const vmId = String(payload.id || '').trim();
    if (!vmId) throw fail('The panel did not supply a VM id');
    const vmPath = this.getVmPath(vmId);
    if (fs.existsSync(vmPath)) throw fail(`VM ${vmId} already exists on this node`);

    const memory = parseInt(payload.memory, 10) || 2048;
    const cpus = parseInt(payload.cpus, 10) || 2;
    const diskSize = String(payload.disk_size || '20G').toUpperCase();

    fs.mkdirSync(vmPath, { recursive: true });
    logger.info(`Creating VM ${vmId}`, { memory, cpus, diskSize, node: getNodeId() });

    try {
      const baseImage = this.ensureBaseImage(payload.img_url);
      fs.copyFileSync(baseImage, this.getDiskPath(vmId));
      run('qemu-img', ['resize', this.getDiskPath(vmId), diskSize]);

      const vm = {
        id: vmId,
        uuid: payload.uuid || `vm-${vmId}`,
        name: payload.name || `vm-${vmId}`,
        hostname: payload.hostname || payload.name || `vm-${vmId}`,
        username: payload.username || getSshUser(),
        password: payload.password || '',
        os_type: payload.os_type || '',
        img_url: payload.img_url || '',
        memory,
        cpus,
        disk_size: diskSize,
        ssh_port: parseInt(payload.ssh_port, 10) || 2222,
        vnc_port: parseInt(payload.vnc_port, 10) || 0,
        agent_port: parseInt(payload.agent_port, 10) || 0,
        port_forwards: Array.isArray(payload.port_forwards) ? payload.port_forwards : [],
        gui_mode: payload.gui_mode ? 1 : 0,
        start_on_boot: payload.start_on_boot ? 1 : 0,
        status: 'stopped',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      this.writeSeed(vm);
      this.saveState(vm);
      client.sendEvent('vm_created', { vm_id: vmId });

      return {
        id: vmId,
        dir: vmPath,
        disk_path: this.getDiskPath(vmId),
        seed_path: this.getSeedPath(vmId),
        status: 'stopped',
      };
    } catch (error) {
      fs.rmSync(vmPath, { recursive: true, force: true });
      throw error;
    }
  }

  startVm(payload) {
    const vmId = String(payload.vm_id || '').trim();
    const vm = this.loadState(vmId);
    if (!vm) throw fail(`VM ${vmId} does not exist on this node`);
    if (this.isRunning(vmId)) return { id: vmId, status: 'running', noop: true };
    if (!fs.existsSync(this.getDiskPath(vmId))) throw fail(`VM ${vmId} has no disk image`);

    try {
      fs.rmSync(this.getPidFile(vmId), { force: true });
    } catch (_) {}

    logger.info(`Starting VM ${vmId}`);
    run(QEMU_BIN, this.qemuArgs(vm), { timeout: 60000 });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !this.isRunning(vmId)) {
      spawnSync('sleep', ['0.2']);
    }
    if (!this.isRunning(vmId)) {
      let bootLog = '';
      try { bootLog = fs.readFileSync(path.join(this.getVmPath(vmId), 'boot.log'), 'utf8').slice(-4000); } catch (_) {}
      throw fail(`QEMU exited before VM ${vmId} reached running state.${bootLog ? ' Boot log: ' + bootLog.trim().split('\n').slice(-6).join(' | ') : ''}`);
    }

    vm.status = 'running';
    vm.updated_at = new Date().toISOString();
    this.saveState(vm);
    client.sendEvent('vm_started', { vm_id: vmId });
    return { id: vmId, status: 'running' };
  }

  stopVm(payload) {
    const vmId = String(payload.vm_id || '').trim();
    const vm = this.loadState(vmId);
    if (!vm) throw fail(`VM ${vmId} does not exist on this node`);

    const pid = this.pidOf(vmId);
    if (!pid || !this.isRunning(vmId)) {
      vm.status = 'stopped';
      vm.updated_at = new Date().toISOString();
      this.saveState(vm);
      try { fs.rmSync(this.getPidFile(vmId), { force: true }); } catch (_) {}
      return { id: vmId, status: 'stopped', noop: true };
    }

    try {
      process.kill(pid, payload.force ? 'SIGKILL' : 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }

    if (!payload.force) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && this.isRunning(vmId)) spawnSync('sleep', ['0.2']);
    }
    if (this.isRunning(vmId)) {
      try { process.kill(pid, 'SIGKILL'); } catch (_) {}
      spawnSync('sleep', ['1']);
    }

    vm.status = 'stopped';
    vm.updated_at = new Date().toISOString();
    try { fs.rmSync(this.getPidFile(vmId), { force: true }); } catch (_) {}

    if (this.isRunning(vmId)) throw fail(`VM ${vmId} is still running after the stop request`);
    this.saveState(vm);
    client.sendEvent('vm_stopped', { vm_id: vmId });
    return { id: vmId, status: 'stopped' };
  }

  deleteVm(payload) {
    const vmId = String(payload.vm_id || '').trim();
    const vmPath = this.getVmPath(vmId);
    if (this.isRunning(vmId)) this.stopVm({ vm_id: vmId, force: true });
    fs.rmSync(vmPath, { recursive: true, force: true });
    client.sendEvent('vm_deleted', { vm_id: vmId });
    return { id: vmId, deleted: true };
  }

  vmStats(payload) {
    const vmId = String(payload.vm_id || '').trim();
    const vm = this.loadState(vmId);
    if (!vm) throw fail(`VM ${vmId} does not exist on this node`);

    const pid = this.pidOf(vmId);
    let cpuPercent = 0;
    let memoryMb = 0;
    if (pid && this.isRunning(vmId)) {
      const out = spawnSync('ps', ['-o', '%cpu=,rss=', '-p', String(pid)], { encoding: 'utf8' });
      const [cpu, rss] = String(out.stdout || '').trim().split(/\s+/);
      cpuPercent = parseFloat(cpu) || 0;
      memoryMb = Math.round((parseInt(rss, 10) || 0) / 1024);
    }

    return {
      id: vmId,
      name: vm.name,
      status: this.isRunning(vmId) ? 'running' : 'stopped',
      cpu: cpuPercent,
      mem: memoryMb,
      memory_mb: memoryMb,
      memory_alloc: vm.memory,
      disk_size: vm.disk_size,
    };
  }

  cpuStats() {
    const cpus = os.cpus();
    let totalAll = 0;
    let idleAll = 0;
    const perCore = [];

    const current = cpus.map((cpu) => {
      let total = 0;
      for (const type in cpu.times) total += cpu.times[type];
      return { idle: cpu.times.idle, total };
    });

    if (cpuSample && cpuSample.length === current.length) {
      for (let i = 0; i < current.length; i += 1) {
        const totalDiff = current[i].total - cpuSample[i].total;
        const idleDiff = current[i].idle - cpuSample[i].idle;
        perCore.push(totalDiff > 0 ? Math.max(0, Math.min(100, Math.round(100 - (100 * idleDiff) / totalDiff))) : 0);
        totalAll += totalDiff;
        idleAll += idleDiff;
      }
    } else {
      for (let i = 0; i < current.length; i += 1) perCore.push(0);
    }

    cpuSample = current;
    const percent = totalAll > 0 ? Math.max(0, Math.min(100, Math.round(100 - (100 * idleAll) / totalAll))) : 0;
    return { percent, perCore };
  }

  networkStats() {
    let rxBytes = 0;
    let txBytes = 0;
    try {
      const lines = fs.readFileSync('/proc/net/dev', 'utf8').trim().split('\n');
      for (let i = 2; i < lines.length; i += 1) {
        const parts = lines[i].trim().split(/\s+/);
        const iface = parts[0].replace(':', '');
        if (iface === 'lo') continue;
        rxBytes += parseInt(parts[1], 10) || 0;
        txBytes += parseInt(parts[9], 10) || 0;
      }
    } catch (_) {}

    const now = Date.now();
    let rxKbps = 0;
    let txKbps = 0;
    if (netSample) {
      const seconds = (now - netSample.time) / 1000;
      if (seconds > 0) {
        rxKbps = Math.max(0, Math.round(((rxBytes - netSample.rxBytes) / 1024) / seconds));
        txKbps = Math.max(0, Math.round(((txBytes - netSample.txBytes) / 1024) / seconds));
      }
    }
    netSample = { time: now, rxBytes, txBytes };
    return { rx_bytes: rxBytes, tx_bytes: txBytes, rx_kbps: rxKbps, tx_kbps: txKbps };
  }

  diskStats() {
    const target = this.vmDir;
    try {
      const stat = fs.statfsSync(target);
      const total = Number(stat.bsize) * Number(stat.blocks);
      const free = Number(stat.bsize) * Number(stat.bfree);
      const used = Math.max(0, total - free);
      return {
        total_bytes: total,
        used_bytes: used,
        free_bytes: free,
        total_gb: (total / 1024 ** 3).toFixed(1),
        used_gb: (used / 1024 ** 3).toFixed(1),
        free_gb: (free / 1024 ** 3).toFixed(1),
        percent: total > 0 ? Math.round((used / total) * 100) : 0,
      };
    } catch (_) {
      try {
        const parts = String(run('df', ['-B1', target])).trim().split('\n')[1].split(/\s+/);
        const total = parseInt(parts[1], 10) || 0;
        const used = parseInt(parts[2], 10) || 0;
        const free = parseInt(parts[3], 10) || 0;
        return {
          total_bytes: total,
          used_bytes: used,
          free_bytes: free,
          total_gb: (total / 1024 ** 3).toFixed(1),
          used_gb: (used / 1024 ** 3).toFixed(1),
          free_gb: (free / 1024 ** 3).toFixed(1),
          percent: total > 0 ? Math.round((used / total) * 100) : 0,
        };
      } catch (_) {
        return { total_bytes: 0, used_bytes: 0, free_bytes: 0, total_gb: '0', used_gb: '0', free_gb: '0', percent: 0 };
      }
    }
  }

  swapStats() {
    try {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const total = parseInt((meminfo.match(/SwapTotal:\s+(\d+)\s+kB/) || [])[1], 10) || 0;
      const free = parseInt((meminfo.match(/SwapFree:\s+(\d+)\s+kB/) || [])[1], 10) || 0;
      return {
        total_mb: Math.round(total / 1024),
        used_mb: Math.round((total - free) / 1024),
        free_mb: Math.round(free / 1024),
        percent: total > 0 ? Math.round(((total - free) / total) * 100) : 0,
      };
    } catch (_) {
      return { total_mb: 0, used_mb: 0, free_mb: 0, percent: 0 };
    }
  }

  qemuVersion() {
    if (Date.now() - qemuVersionCache.at < CACHE_TTL_MS) return qemuVersionCache.version;
    try {
      const version = String(run(QEMU_BIN, ['--version'])).trim().split('\n')[0];
      qemuVersionCache = { at: Date.now(), version };
    } catch (_) {
      qemuVersionCache = { at: Date.now(), version: 'Not installed' };
    }
    return qemuVersionCache.version;
  }

  nodeStats() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cpu = this.cpuStats();
    const vms = this.listVms();
    const running = vms.filter((vm) => this.isRunning(vm.id));

    const allocatedMemory = vms.reduce((sum, vm) => sum + (parseInt(vm.memory, 10) || 0), 0);
    const allocatedCpus = vms.reduce((sum, vm) => sum + (parseInt(vm.cpus, 10) || 0), 0);
    const activeTop = running
      .map((vm) => {
        const stats = this.vmStats({ vm_id: vm.id });
        return {
          id: vm.id,
          name: vm.name,
          cpu_percent: stats.cpu,
          memory_mb: stats.memory_mb,
          memory_alloc: vm.memory,
          disk_size: vm.disk_size,
        };
      })
      .sort((a, b) => b.cpu_percent - a.cpu_percent);

    const load = os.loadavg();
    return {
      hostname: os.hostname(),
      ip: getVpsAddress(),
      uptime_seconds: Math.floor(os.uptime()),
      process_uptime: Math.floor(process.uptime()),
      os: { type: os.type(), release: os.release(), arch: os.arch(), platform: os.platform() },
      cpu: {
        model: cpus[0] ? cpus[0].model : 'x86_64 Processor',
        cores_count: cpus.length,
        percent: cpu.percent,
        per_core: cpu.perCore,
        load_avg: [load[0].toFixed(2), load[1].toFixed(2), load[2].toFixed(2)],
      },
      memory: {
        total_mb: Math.round(totalMem / 1024 / 1024),
        used_mb: Math.round(usedMem / 1024 / 1024),
        free_mb: Math.round(freeMem / 1024 / 1024),
        percent: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0,
      },
      swap: this.swapStats(),
      disk: this.diskStats(),
      network: this.networkStats(),
      hypervisor: {
        qemu_installed: which(QEMU_BIN),
        qemu_version: this.qemuVersion(),
        kvm_support: hasKvm(),
        cloud_init: which('cloud-localds'),
      },
      vms: {
        total: vms.length,
        running: running.length,
        stopped: vms.length - running.length,
        allocated_memory_mb: allocatedMemory,
        allocated_cpus: allocatedCpus,
        active_top_vms: activeTop,
      },
      history: { labels: [], cpu: [], memory: [], net_rx: [], net_tx: [] },
      version: '1.0.0',
      node_id: getNodeId(),
    };
  }

  registerHandlers() {
    client.onCommand('vm_create', (payload) => this.createVm(payload));
    client.onCommand('vm_start', (payload) => this.startVm(payload));
    client.onCommand('vm_stop', (payload) => this.stopVm(payload));
    client.onCommand('vm_delete', (payload) => this.deleteVm(payload));
    client.onCommand('vm_stats', (payload) => this.vmStats(payload));
    client.onCommand('node_stats', () => this.nodeStats());
    client.onCommand('node_info', () => ({ node_id: getNodeId(), vms: this.listVms() }));
    logger.info('Registered Wings command handlers');
  }
}

module.exports = new VMService();
