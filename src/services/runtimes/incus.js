'use strict';

const { run, runOrThrow, normalizeForwards, normalizeAccess, lastLines, waitFor } = require('./util');
const { sshProvisionScript, cloudInitUserData } = require('./provision');

const RUNTIME = 'incus';

function nameFor(vm) {
  return `vpanel-${Number(vm.id)}`;
}

function isVm(vm) {
  return String(vm.kind || '') === 'incus-vm';
}

function available() {
  const result = run('incus', ['info'], { timeout: 6000 });
  return !result.error && result.code === 0;
}

function listInstance(name) {
  const result = run('incus', ['list', name, '--format', 'json'], { timeout: 20000 });
  if (result.error || result.code !== 0) return null;
  try {
    const rows = JSON.parse(result.stdout || '[]');
    if (!Array.isArray(rows)) return null;
    return rows.find((row) => row && row.name === name) || null;
  } catch (_) {
    return null;
  }
}

function instanceAddress(name) {
  const entry = listInstance(name);
  const networks = entry && entry.state && entry.state.network;
  if (!networks || typeof networks !== 'object') return null;
  for (const iface of Object.values(networks)) {
    const addresses = iface && Array.isArray(iface.addresses) ? iface.addresses : [];
    for (const address of addresses) {
      if (address && address.family === 'inet' && address.scope === 'global' && address.address) {
        return address.address;
      }
    }
  }
  return null;
}

function waitReady(name, vm, timeoutMs = vm ? 240000 : 180000) {
  return waitFor(() => {
    const result = run('incus', ['exec', name, '--', '/bin/true'], { timeout: 15000 });
    return !result.error && result.code === 0;
  }, { timeoutMs, intervalMs: 3000 });
}

function addProxy(name, device, hostPort, guestPort, guestHost) {
  const args = [
    'config', 'device', 'add', name, device, 'proxy',
    `listen=tcp:0.0.0.0:${Number(hostPort)}`,
    `connect=tcp:${guestHost || '127.0.0.1'}:${Number(guestPort)}`,
  ];
  const added = run('incus', args, { timeout: 30000 });
  if (added.code !== 0) {
    run('incus', ['config', 'device', 'remove', name, device], { timeout: 15000 });
    runOrThrow('incus', args, { timeout: 30000 });
  }
}

function create(vm) {
  const name = nameFor(vm);
  const image = String(vm.image || 'images:ubuntu/24.04');
  const access = normalizeAccess(vm.access);
  const virtualMachine = isVm(vm);
  const cpus = Number(vm.cpus) || 1;
  const memory = Number(vm.memory) || 512;

  const args = ['launch', image, name];
  if (virtualMachine) args.push('--vm');
  args.push(
    '-c', `limits.cpu=${cpus}`,
    '-c', `limits.memory=${memory}MiB`,
  );
  if (!virtualMachine) args.push('-c', 'limits.processes=512');
  if (virtualMachine && access.ssh) {
    args.push('-c', `cloud-init.user-data=${cloudInitUserData({
      hostname: vm.hostname || vm.name,
      username: vm.username,
      password: vm.password,
    })}`);
  }

  const launch = run('incus', args, { timeout: 900000 });
  if (launch.error) throw new Error(`Incus could not be executed: ${launch.error.message}`);
  if (launch.code !== 0) {
    const detail = (launch.stderr || launch.stdout || '').trim();
    throw Object.assign(
      new Error(`Incus could not create the instance: ${detail || `exit code ${launch.code}`}`),
      { category: 'runtime_create_failed' },
    );
  }

  try {
    if (virtualMachine) {
      // The guest agent and cloud-init need time; keep the record usable even if
      // the agent is still starting, because the VM is already consuming resources.
      waitReady(name, true);
    } else {
      if (!waitReady(name, false)) throw new Error('The container did not become ready for exec within 3 minutes.');
      if (access.ssh) {
        const provisioned = run('incus', ['exec', name, '--', 'sh', '-s'], {
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
    }

    if (virtualMachine && access.ssh) {
      // The proxy device for a VM must target the guest's address, which is not
      // assigned the instant launch returns.
      waitFor(() => Boolean(instanceAddress(name)), { timeoutMs: 120000, intervalMs: 3000 });
    }

    if (access.ssh && vm.ssh_port) {
      const guestHost = virtualMachine ? (instanceAddress(name) || null) : '127.0.0.1';
      if (guestHost) addProxy(name, 'vpanel-ssh', vm.ssh_port, 22, guestHost);
    }
    if (access.ports) {
      const guestHost = virtualMachine ? (instanceAddress(name) || null) : '127.0.0.1';
      if (guestHost) {
        let index = 0;
        for (const forward of normalizeForwards(vm.port_forwards)) {
          if (forward.host === Number(vm.ssh_port)) continue;
          addProxy(name, `vpanel-port-${index++}`, forward.host, forward.guest, guestHost);
        }
      }
    }
  } catch (error) {
    if (!virtualMachine) run('incus', ['delete', name, '--force'], { timeout: 180000 });
    throw Object.assign(error, { runtimeCleaned: !virtualMachine });
  }

  return { runtime_ref: name, status: 'running' };
}

function start(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  if (status(vm) === 'running') return { runtime_ref: name, status: 'running', noop: true };
  runOrThrow('incus', ['start', name], { timeout: 300000 });
  return { runtime_ref: name, status: 'running' };
}

function stop(vm, { force = false } = {}) {
  const name = vm.runtime_ref || nameFor(vm);
  if (status(vm) !== 'running') return { runtime_ref: name, status: 'stopped', noop: true };
  runOrThrow('incus', force ? ['stop', name, '--force'] : ['stop', name], { timeout: 300000 });
  return { runtime_ref: name, status: 'stopped' };
}

function restart(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  runOrThrow('incus', ['restart', name], { timeout: 300000 });
  return { runtime_ref: name, status: 'running' };
}

function remove(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  run('incus', ['delete', name, '--force'], { timeout: 300000 });
  return { runtime_ref: name, status: 'deleted' };
}

function updateLimits(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  runOrThrow('incus', ['config', 'set', name, 'limits.cpu', String(Number(vm.cpus) || 1)], { timeout: 20000 });
  runOrThrow('incus', ['config', 'set', name, 'limits.memory', `${Number(vm.memory) || 512}MiB`], { timeout: 20000 });
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
  const result = run('incus', ['info', name, '--show-log'], { timeout: 20000 });
  return lastLines(`${result.stdout || ''}${result.stderr || ''}`, lines);
}

function terminalArgv(vm) {
  const name = vm.runtime_ref || nameFor(vm);
  return ['incus', 'exec', '-t', name, '--', '/bin/sh'];
}

function findByName(vmId) {
  const name = `vpanel-${Number(vmId)}`;
  return listInstance(name) ? name : null;
}

module.exports = {
  id: 'incus',
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
  instanceAddress,
};
