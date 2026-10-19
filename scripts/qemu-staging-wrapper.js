#!/usr/bin/env node


const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const root = process.env.VM_DIR;
if (!root || !path.isAbsolute(root)) {
  process.stderr.write('VM_DIR must be an absolute staging path.\n');
  process.exit(2);
}
const args = process.argv.slice(2).filter((arg) => arg !== '-daemonize');
const executable = path.join(root, 'qemu-system-x86_64');
let hostVisibleExecutable;
try {
  hostVisibleExecutable = fs.realpathSync(executable);
  if (path.basename(hostVisibleExecutable) !== 'qemu-system-x86_64' || !hostVisibleExecutable.startsWith(`${root}${path.sep}`)) throw new Error('invalid staged executable');
} catch (_) {
  process.stderr.write('A host-visible staging QEMU executable is required for strict process verification.\n');
  process.exit(2);
}
const stagingRoot = path.resolve(root, '..');
const firmwareHostDir = path.join(stagingRoot, 'firmware');
let firmwareContainerDir = null;
try {
  const fst = fs.statSync(firmwareHostDir);
  if (fst && fst.isDirectory()) {
    firmwareContainerDir = '/opt/vpanel-staging-firmware';
  }
} catch (_) {}
const dockerArgs = [
  'run', '--rm', '--pid=host', '--network=none',
  '--user', `${process.getuid()}:${process.getgid()}`,
  '--volume', `${root}:${root}`,
  '--env', 'QEMU_MODULE_DIR=/usr/lib/x86_64-linux-gnu/qemu',
];
if (firmwareContainerDir) {
  dockerArgs.push('--volume', `${firmwareHostDir}:${firmwareContainerDir}:ro`);
}



try {
  const st = fs.statSync('/dev/kvm');
  if (st) {
    dockerArgs.push('--device', '/dev/kvm');
    try {
      const kvmGid = Number(fs.statSync('/dev/kvm').gid);
      if (Number.isSafeInteger(kvmGid)) dockerArgs.push('--group-add', String(kvmGid));
    } catch (_) {}
  }
} catch (_) {}
const firmwareFlag = firmwareContainerDir ? ['-L', firmwareContainerDir] : [];
const result = spawnSync('docker', [
  ...dockerArgs,
  '--entrypoint', hostVisibleExecutable,
  'vpanel-qemu-staging:local', ...firmwareFlag, ...args,
], { stdio: 'inherit' });
if (result.error) {
  process.stderr.write('The isolated QEMU test runtime could not start.\n');
  process.exit(127);
}
process.exit(Number.isInteger(result.status) ? result.status : 1);
