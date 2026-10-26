'use strict';

const { run, runOrThrow, normalizeForwards, normalizeAccess, dockerSizeToBytes, percentFromDocker, lastLines } = require('./util');
const { sshProvisionScript } = require('./provision');

const RUNTIME = 'docker';

function nameFor(vm) {
  return `vpanel-${Number(vm.id)}`;
}

function inspect(name) {
  const result = run('docker', ['inspect', '--format', '{{.State.Status}}', name], { timeout: 15000 });
  if (result.error || result.code !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

function available() {
  const result = run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 6000 });
  return !result.error && result.code === 0;
}

function buildPortArgs(vm) {
  const access = normalizeAccess(vm.access);
  const args = [];
  if (access.ssh && vm.ssh_port) args.push('-p', `0.0.0.0:${Number(vm.ssh_port)}:22`);
  if (access.ports) {
    for (const forward of normalizeForwards(vm.port_forwards)) {
      if (forward.host === Number(vm.ssh_port)) continue;
      args.push('-p', `0.0.0.0:${forward.host}:${forward.guest}`);
    }
  }
  return args;
}

function buildRunArgs(vm) {
  const name = nameFor(vm);
  const image = String(vm.image || 'ubuntu:24.04');
  const cpus = Number(vm.cpus) || 1;
  const memory = Number(vm.memory) || 512;
  return [
    'run', '-d',
    '--name', name,
    '--hostname', String(vm.hostname || vm.name || name).slice(0, 63),
    '--label', `vpanel.vm_id=${Number(vm.id)}`,
    '--label', 'vpanel.managed=true',
    '--cpus', String(cpus),
    '--memory', `${memory}m`,
    '--memory-swap', `${memory}m`,
    '--pids-limit', '512',
    '--restart', 'unless-stopped',
    ...buildPortArgs(vm),
    image,
    // Start sshd again on every container start; provisioning installs it after
    // the first boot and the package does not always enable it in this image.
    '/bin/sh', '-c', 'mkdir -p /run/sshd; if [ -x /usr/sbin/sshd ]; then /usr/sbin/sshd; fi; trap "exit 0" TERM INT; while :; do sleep 3600; done',
  ];
}

function create(vm) {
  const name = nameFor(vm);
  const access = normalizeAccess(vm.access);
  const args = buildRunArgs(vm);
  const started = run('docker', args, { timeout: 300000 });
  if (started.error) throw new Error(`Docker could not be executed: ${started.error.message}`);
  if (started.code !== 0) {
    const detail = (started.stderr || started.stdout || '').trim();
    throw Object.assign(
      new Error(`Docker could not start the container: ${detail || `exit code ${started.code}`}`),
      { category: /port is already allocated|address already in use/i.test(detail) ? 'port_in_use' : 'runtime_create_failed' },
    );
  }

  if (!inspect(name)) {
    throw new Error('Docker reported success but the container is not present.');
  }

  if (access.ssh) {
    const provisioned = run('docker', ['exec', '-i', name, 'sh', '-s'], {
      timeout: 300000,
      input: sshProvisionScript({ username: vm.username, password: vm.password }),
    });
    if (provisioned.code !== 0) {
      run('docker', ['rm', '-f', name], { timeout: 60000 });
      const detail = (provisioned.stderr || provisioned.stdout || '').trim();
      throw Object.assign(
        new Error(`Container created but SSH setup failed: ${detail || `exit code ${provisioned.code}`}. Pick an image with a shell and a package manager.`),
        { category: 'ssh_provision_failed', runtimeCleaned: true },
      );
    }
  }

  return { runtime_ref: name, status: 'running' };
}

function start(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  runOrThrow('docker', ['start', name], { timeout: 90000 });
  return { runtime_ref: name, status: 'running' };
}

function stop(vm, { force = false } = {}) {
  const name = vm.runtime_ref || nameFor(vm);
  if (force) runOrThrow('docker', ['kill', name], { timeout: 60000 });
  else runOrThrow('docker', ['stop', '-t', '10', name], { timeout: 90000 });
  return { runtime_ref: name, status: 'stopped' };
}

function restart(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  runOrThrow('docker', ['restart', '-t', '10', name], { timeout: 120000 });
  return { runtime_ref: name, status: 'running' };
}

function remove(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  run('docker', ['rm', '-f', name], { timeout: 90000 });
  return { runtime_ref: name, status: 'deleted' };
}

function updateLimits(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  const cpus = Number(vm.cpus) || 1;
  const memory = Number(vm.memory) || 512;
  runOrThrow('docker', ['update', '--cpus', String(cpus), '--memory', `${memory}m`, '--memory-swap', `${memory}m`, name], { timeout: 30000 });
  return { runtime_ref: name, cpus, memory };
}

function status(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  const state = inspect(name);
  if (!state) return 'stopped';
  return state === 'running' ? 'running' : 'stopped';
}

const statsCache = new Map();
const STATS_TTL_MS = 4000;

function stats(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  const cached = statsCache.get(name);
  if (cached && Date.now() - cached.at < STATS_TTL_MS) return cached.value;
  const value = readStats(vm, name);
  statsCache.set(name, { at: Date.now(), value });
  return value;
}

function readStats(vm, name) {
  if (status(vm) !== 'running') {
    return { status: 'stopped', cpu_percent: 0, memory_bytes: 0, memory_alloc_mb: Number(vm.memory) || 0 };
  }
  const result = run('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}', name], { timeout: 20000 });
  if (result.error || result.code !== 0) {
    return { status: 'running', cpu_percent: 0, memory_bytes: 0, memory_alloc_mb: Number(vm.memory) || 0 };
  }
  const [cpu, memoryUsage, memoryPercent] = String(result.stdout || '').trim().split('|');
  const usedPart = String(memoryUsage || '').split('/')[0].trim();
  return {
    status: 'running',
    cpu_percent: percentFromDocker(cpu),
    memory_bytes: dockerSizeToBytes(usedPart),
    memory_percent: percentFromDocker(memoryPercent),
    memory_alloc_mb: Number(vm.memory) || 0,
  };
}

function logs(vm, lines = 200) {
  const name = vm.runtime_ref || nameFor(vm);
  const result = run('docker', ['logs', '--tail', String(Math.max(1, Math.min(1000, lines))), name], { timeout: 20000 });
  return lastLines(`${result.stdout || ''}${result.stderr || ''}`, lines);
}

// Commands are executed through `script` so the CLI gets a real TTY and the
// existing xterm console can bridge stdin/stdout.
function terminalArgv(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  return ['docker', 'exec', '-it', name, '/bin/sh'];
}

function findByName(vmId) {
  const name = `vpanel-${Number(vmId)}`;
  return inspect(name) ? name : null;
}

module.exports = {
  id: 'docker',
  RUNTIME,
  nameFor,
  available,
  create,
  buildRunArgs,
  start,
  stop,
  restart,
  remove,
  updateLimits,
  status,
  stats,
  logs,
  terminalArgv,
  findByName,
};
