'use strict';

const fs = require('fs');
const { commandExists } = require('./util');

const SLICE = process.env.VPANEL_VM_SLICE || 'vpanel-vms.slice';

function systemdAvailable() {
  if (process.platform !== 'linux') return false;
  if (process.env.VPANEL_DISABLE_CGROUPS === '1') return false;
  // Binaries can exist inside a container image without systemd as PID 1, and
  // CPUQuota/MemoryMax need the unified cgroup hierarchy.
  if (!fs.existsSync('/run/systemd/system')) return false;
  if (!fs.existsSync('/sys/fs/cgroup/cgroup.controllers')) return false;
  return commandExists('systemd-run') && commandExists('systemctl');
}

function scopeFor(vm) {
  return `vpanel-vm-${Number(vm.id)}`;
}

/**
 * Wraps a foreground QEMU invocation in a transient systemd scope with a hard
 * CPU and memory ceiling. `-daemonize` must NOT be used with this wrapper: the
 * daemon detaches from the scope and the limits disappear with it.
 */
function wrap(vm, argv) {
  if (!systemdAvailable() || !Array.isArray(argv) || !argv.length) {
    return { command: argv[0], args: argv.slice(1), wrapped: false };
  }
  const cpus = Math.max(1, Number(vm.cpus) || 1);
  const memory = Math.max(128, Number(vm.memory) || 512);
  const args = [
    '--scope',
    '--quiet',
    `--slice=${SLICE}`,
    '--unit', scopeFor(vm),
    '-p', `CPUQuota=${Math.round(cpus * 100)}%`,
    '-p', `MemoryMax=${Math.round(memory * 1.1 + 128)}M`,
    '-p', 'MemorySwapMax=0',
    '--',
    ...argv,
  ];
  return { command: 'systemd-run', args, wrapped: true };
}

function describe(vm) {
  return {
    enforced: systemdAvailable(),
    cpu_quota_percent: Math.round((Number(vm.cpus) || 1) * 100),
    memory_max_mb: Number(vm.memory) || 512,
    scope: scopeFor(vm),
  };
}

function killScope(vm) {
  if (!systemdAvailable()) return false;
  const { run } = require('./util');
  const result = run('systemctl', ['stop', `${scopeFor(vm)}.scope`], { timeout: 15000 });
  return !result.error && result.code === 0;
}

module.exports = { systemdAvailable, wrap, describe, killScope, scopeFor, SLICE };
