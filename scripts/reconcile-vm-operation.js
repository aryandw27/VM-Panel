#!/usr/bin/env node


const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const config = require('../src/lib/config');
const { collections, ensureConnected, closeDb } = require('../src/lib/db');

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--confirm-quiescent') { result.confirm = true; continue; }
    if (!['--vm-id', '--operation-id'].includes(argv[i]) || !argv[i + 1]) throw new Error('Usage: reconcile-vm-operation.js --vm-id <id> --operation-id <uuid> --confirm-quiescent');
    result[argv[i].slice(2)] = argv[++i];
  }
  const vmId = Number(result['vm-id']);
  if (!Number.isSafeInteger(vmId) || vmId < 1 || !/^[0-9a-f-]{36}$/i.test(result['operation-id'] || '') || !result.confirm) {
    throw new Error('A VM ID, operation UUID, and --confirm-quiescent are required.');
  }
  return { vmId, operationId: result['operation-id'] };
}

function requirePanelStopped() {
  try {
    const status = execFileSync('systemctl', ['is-active', 'panel.service'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    throw new Error(`Refusing reconciliation: panel.service is ${status}. Stop the panel service first.`);
  } catch (error) {
    if (error.message.startsWith('Refusing reconciliation:')) throw error;
    if (error.status === 3 || error.status === 4) return;
    throw new Error('Cannot verify panel.service is stopped; reconciliation refused.');
  }
}

function findRelatedProcesses(vmId, { procRoot = '/proc', vmRoot = config.vmDir, backupRoot = config.uploads.backup } = {}) {
  const vmPath = path.resolve(vmRoot, String(vmId));
  const backupPath = path.resolve(backupRoot, String(vmId));
  let entries;
  try { entries = fs.readdirSync(procRoot); } catch (_) { throw new Error('Cannot inspect host processes; reconciliation refused.'); }
  const matches = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const exe = path.basename(fs.realpathSync(path.join(procRoot, entry, 'exe'))).replace(/ \(deleted\)$/, '');
      const cmdline = fs.readFileSync(path.join(procRoot, entry, 'cmdline'), 'utf8').split('\0').filter(Boolean);
      const relevantBinary = exe.startsWith('qemu-system') || exe === 'qemu-img';
      const relevantPath = cmdline.some((arg) => arg === vmPath || arg.startsWith(`${vmPath}${path.sep}`) || arg === backupPath || arg.startsWith(`${backupPath}${path.sep}`));
      if (relevantBinary && relevantPath) matches.push({ pid: Number(entry), executable: exe });
    } catch (_) {  }
  }
  return matches;
}

async function reconcile({ vmId, operationId }) {
  const osAccount = os.userInfo().username;
  requirePanelStopped();
  const related = findRelatedProcesses(vmId);
  if (related.length) throw new Error('Related QEMU or qemu-img processes are still present; quarantine retained.');
  await ensureConnected();
  const actor = await collections.users.findOne({ username: osAccount });
  if (!actor || actor.role !== 'admin') throw new Error('Run as an OS account whose matching panel account has administrator role.');
  const [operation, lock] = await Promise.all([
    collections.vm_operations.findOne({ operation_id: operationId, vm_id: vmId, status: 'uncertain' }),
    collections.vm_operation_locks.findOne({ vm_id: vmId, operation_id: operationId, status: 'uncertain' }),
  ]);
  if (!operation || !lock) throw new Error('No matching uncertain operation and quarantine lock were found.');
  const vmPath = path.resolve(config.vmDir, String(vmId));
  const pidPath = path.join(vmPath, 'qemu.pid');
  let pidfileState = 'absent';
  try {
    const pid = fs.readFileSync(pidPath, 'utf8').trim();
    if (!/^\d{1,10}$/.test(pid)) pidfileState = 'invalid';
    else {
      try {
        const exe = path.basename(fs.realpathSync(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, '');
        const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        const index = argv.indexOf('-pidfile');
        pidfileState = exe.startsWith('qemu-system') && argv[index + 1] === pidPath ? 'vm-process-present' : 'reused-or-stale';
      } catch (error) { pidfileState = error.code === 'ENOENT' || error.code === 'ESRCH' ? 'stale' : 'unverified'; }
    }
  } catch (error) { if (error.code !== 'ENOENT') pidfileState = 'unverified'; }
  if (pidfileState === 'vm-process-present' || pidfileState === 'unverified') throw new Error('The VM PID file cannot be proven inactive; quarantine retained.');

  const timestamp = new Date();
  const auditId = crypto.randomUUID();
  await collections.audit_events.insertOne({
    id: auditId,
    event: 'vm:operation_reconciled',
    user_id: Number(actor.id),
    vm_id: vmId,
    timestamp: timestamp.toISOString(),
    payload: {
      operation_id: operationId,
      original_action: operation.action,
      prior_status: 'uncertain',
      decision: 'quarantine_cleared_after_manual_host_check',
      evidence: { panel_service: 'inactive', related_qemu_processes: 0, pidfile_state: pidfileState },
    },
  });
  const released = await collections.vm_operation_locks.updateOne(
    { vm_id: vmId, operation_id: operationId, status: 'uncertain' },
    { $set: { status: 'reconciled', previous_operation_id: operationId, lease_expires_at: new Date(0), reconciled_at: timestamp, reconciled_by: Number(actor.id), reconciliation_audit_id: auditId }, $unset: { operation_id: '', actor_id: '', action: '' } },
  );
  if (!released.matchedCount) throw new Error('Quarantine changed concurrently. No lock was cleared.');
  await collections.vm_operations.updateOne(
    { operation_id: operationId, vm_id: vmId, status: 'uncertain' },
    { $set: { reconciled_at: timestamp, reconciled_by: Number(actor.id), reconciliation_audit_id: auditId, updated_at: timestamp.toISOString() } },
  );
  return { vmId, operationId, action: operation.action, auditId, pidfileState };
}

if (require.main === module) {
  (async () => {
    try {
      const result = await reconcile(parseArgs(process.argv.slice(2)));
      console.log(JSON.stringify({ reconciled: true, ...result }));
    } catch (error) {
      console.error(error.message || 'Reconciliation refused.');
      process.exitCode = 1;
    } finally { await closeDb().catch(() => {}); }
  })();
}

module.exports = { parseArgs, findRelatedProcesses, requirePanelStopped, reconcile };
