'use strict';

const { run, runOrThrow, normalizeForwards, normalizeAccess, lastLines, waitFor } = require('./util');
const { sshProvisionScript } = require('./provision');

const RUNTIME = 'lxc';

function nameFor(vm) {
  return `vpanel-${Number(vm.id)}`;
}

function available() {
  const result = run('lxc', ['info'], { timeout: 6000 });
  return !result.error && result.code === 0;
}

function listInstance(name) {
  const result = run('lxc', ['list', name, '--format', 'json'], { timeout: 20000 });
  if (result.error || result.code !== 0) return null;
  try {
    const rows = JSON.parse(result.stdout || '[]');
    if (!Array.isArray(rows)) return null;
    return rows.find((row) => row && row.name === name) || null;
  } catch (_) {
    return null;
  }
}

function waitReady(name, timeoutMs = 180000) {
  return waitFor(() => {
    const result = run('lxc', ['exec', name, '--', '/bin/true'], { timeout: 15000 });
    return !result.error && result.code === 0;
  }, { timeoutMs, intervalMs: 2000 });
}

function addProxy(name, device, hostPort, guestPort, { guestHost = '127.0.0.1' } = {}) {
  const config = [
    'config', 'device', 'add', name, device, 'proxy',
    `listen=tcp:0.0.0.0:${Number(hostPort)}`,
    `connect=tcp:${guestHost}:${Number(guestPort)}`,
  ];
  const added = run('lxc', config, { timeout: 30000 });
  if (added.code !== 0) {
    // Replace a stale device left by a previous attempt instead of failing the create.
    run('lxc', ['config', 'device', 'remove', name, device], { timeout: 15000 });
    runOrThrow('lxc', config, { timeout: 30000 });
  }
}

function applyLimits(name, vm) {
  runOrThrow('lxc', ['config', 'set', name, 'limits.cpu', String(Number(vm.cpus) || 1)], { timeout: 15000 });
  runOrThrow('lxc', ['config', 'set', name, 'limits.memory', `${Number(vm.memory) || 512}MB`], { timeout: 15000 });
  runOrThrow('lxc', ['config', 'set', name, 'limits.processes', '512'], { timeout: 15000 });
}

function create(vm) {
  const name = nameFor(vm);
  const image = String(vm.image || 'images:ubuntu/24.04');
  const access = normalizeAccess(vm.access);

  const launch = run('lxc', ['launch', image, name], { timeout: 600000 });
  if (launch.error) throw new Error(`LXC could not be executed: ${launch.error.message}`);
  if (launch.code !== 0) {
    const detail = (launch.stderr || launch.stdout || '').trim();
    throw Object.assign(
      new Error(`LXC could not create the container: ${detail || `exit code ${launch.code}`}`),
      { category: 'runtime_create_failed' },
    );
  }

  try {
    applyLimits(name, vm);
    if (!waitReady(name)) throw new Error('The container did not become ready for exec within 3 minutes.');

    if (access.ssh) {
      const provisioned = run('lxc', ['exec', name, '--', 'sh', '-s'], {
        timeout: 300000,
        input: sshProvisionScript({ username: vm.username, password: vm.password }),
      });
      if (provisioned.code !== 0) {
        const detail = (provisioned.stderr || provisioned.stdout || '').trim();
        throw Object.assign(
          new Error(`Container created but SSH setup failed: ${detail || `exit code ${provisioned.code}`}`),
          { category: 'ssh_provision_failed' },
        );
      }
    }

    if (access.ssh && vm.ssh_port) addProxy(name, 'vpanel-ssh', vm.ssh_port, 22);
    if (access.ports) {
      let index = 0;
      for (const forward of normalizeForwards(vm.port_forwards)) {
        if (forward.host === Number(vm.ssh_port)) continue;
        addProxy(name, `vpanel-port-${index++}`, forward.host, forward.guest);
      }
    }
  } catch (error) {
    run('lxc', ['delete', name, '--force'], { timeout: 120000 });
    throw Object.assign(error, { runtimeCleaned: true });
  }

  return { runtime_ref: name, status: 'running' };
}

function start(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  if (status(vm) === 'running') return { runtime_ref: name, status: 'running', noop: true };
  runOrThrow('lxc', ['start', name], { timeout: 180000 });
  return { runtime_ref: name, status: 'running' };
}

function stop(vm, { force = false } = {}) {
  const name = vm.runtime_ref || nameFor(vm);
  if (status(vm) !== 'running') return { runtime_ref: name, status: 'stopped', noop: true };
  runOrThrow('lxc', force ? ['stop', name, '--force'] : ['stop', name], { timeout: 180000 });
  return { runtime_ref: name, status: 'stopped' };
}

function restart(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  runOrThrow('lxc', ['restart', name], { timeout: 240000 });
  return { runtime_ref: name, status: 'running' };
}

function remove(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  run('lxc', ['delete', name, '--force'], { timeout: 180000 });
  return { runtime_ref: name, status: 'deleted' };
}

function updateLimits(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  applyLimits(name, vm);
  return { runtime_ref: name, cpus: Number(vm.cpus) || 1, memory: Number(vm.memory) || 512 };
}

function status(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  const entry = listInstance(name);
  if (!entry) return 'stopped';
  const state = String(entry.status || '').toUpperCase();
  if (state === 'RUNNING') return 'running';
  return 'stopped';
}

const cpuSamples = new Map();

function stats(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  const entry = listInstance(name);
  if (!entry || String(entry.status || '').toUpperCase() !== 'RUNNING') {
    return { status: 'stopped', cpu_percent: 0, memory_bytes: 0, memory_alloc_mb: Number(vm.memory) || 0 };
  }

  const state = entry.state || {};
  const memoryBytes = Number(state.memory && state.memory.usage) || 0;
  const cpuTotalNs = Number(state.cpu && state.cpu.usage) || 0;
  const now = Date.now();
  const previous = cpuSamples.get(name);
  cpuSamples.set(name, { at: now, cpu: cpuTotalNs });

  let cpuPercent = 0;
  if (previous && now > previous.at && cpuTotalNs >= previous.cpu) {
    const elapsedNs = (now - previous.at) * 1e6;
    cpuPercent = Math.min(100, Math.round(((cpuTotalNs - previous.cpu) / elapsedNs) * 100));
  }

  return {
    status: 'running',
    cpu_percent: cpuPercent,
    memory_bytes: memoryBytes,
    memory_alloc_mb: Number(vm.memory) || 0,
  };
}

function logs(vm, lines = 200) {
  const name = vm.runtime_ref || nameFor(vm);
  const result = run('lxc', ['info', name, '--show-log'], { timeout: 20000 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return lastLines(output, lines);
}

function terminalArgv(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  return ['lxc', 'exec', '-t', name, '--', '/bin/sh'];
}

function findByName(vmId) {
  const name = `vpanel-${Number(vmId)}`;
  return listInstance(name) ? name : null;
}

module.exports = {
  id: 'lxc',
  RUNTIME,
  nameFor,
  available,
  create,
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
