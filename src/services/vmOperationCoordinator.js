const crypto = require('crypto');

const LEASE_MS = 60_000;
const HEARTBEAT_MS = 10_000;
const UNCERTAIN_LEASE = new Date('9999-12-31T23:59:59.999Z');

function createVmOperationCoordinator({ collections, ensureConnected, inspectState, now = () => new Date(), leaseMs = LEASE_MS, heartbeatMs = HEARTBEAT_MS }) {
  async function updateOperation(id, values) {
    await collections.vm_operations.updateOne({ operation_id: id }, { $set: values });
  }

  async function quarantine(vmId, operationId, reason, observed = 'unavailable') {
    const at = now().toISOString();
    await collections.vm_operation_locks.updateOne(
      { vm_id: vmId, operation_id: operationId },
      { $set: { status: 'uncertain', lease_expires_at: UNCERTAIN_LEASE, updated_at: at } },
    );
    await updateOperation(operationId, {
      status: 'uncertain', result_category: reason, observed_state: observed, updated_at: at,
    });
  }

  return async function run({ vmId, actorId = null, operationId = crypto.randomUUID(), action, validate, execute }) {
    const id = Number(vmId);
    if (!Number.isSafeInteger(id) || id < 1 || !['start', 'stop', 'restart', 'delete', 'resize', 'backup_restore', 'backup_create', 'update', 'transfer_owner'].includes(action) || typeof execute !== 'function') {
      throw Object.assign(new Error('Invalid VM operation.'), { category: 'operation_invalid' });
    }
    await ensureConnected();
    const startAt = now();
    const record = { operation_id: operationId, vm_id: id, actor_id: actorId === null ? null : Number(actorId), action, status: 'queued', created_at: startAt, updated_at: startAt.toISOString() };
    await collections.vm_operations.insertOne(record);

    let previous;
    try {
      const oldLock = await collections.vm_operation_locks.findOne({ vm_id: id });
      const oldOperationId = oldLock?.operation_id || null;
      if (oldOperationId && (oldLock.status === 'uncertain' || !oldLock.lease_expires_at || oldLock.lease_expires_at <= startAt)) {
        const prior = await collections.vm_operations.findOne({ operation_id: oldOperationId });
        if (oldLock.status === 'uncertain' || !prior || ['queued', 'running', 'uncertain'].includes(prior.status)) {
          let observed = 'unavailable';
          try { observed = await inspectState(id); } catch (_) {}
          const reason = oldLock.status === 'uncertain' ? 'prior_operation_uncertain' : 'expired_operation_requires_manual_reconciliation';
          await quarantine(id, oldOperationId, reason, observed);
          await updateOperation(operationId, { status: 'rejected', result_category: reason, observed_state: observed, updated_at: now().toISOString() });
          throw Object.assign(new Error('A previous operation for this VM has an uncertain outcome. Inspect the VM and verify no related process is active before an administrator clears the operation lock.'), { category: 'vm_operation_uncertain' });
        }
      }
      const result = await collections.vm_operation_locks.findOneAndUpdate(
        {
          vm_id: id,
          status: { $ne: 'uncertain' },
          ...(oldOperationId ? { operation_id: oldOperationId } : { operation_id: { $exists: false } }),
          $or: [{ lease_expires_at: { $lte: startAt } }, { lease_expires_at: { $exists: false } }],
        },
        { $set: { vm_id: id, operation_id: operationId, actor_id: record.actor_id, action, status: 'running', lease_expires_at: new Date(startAt.getTime() + leaseMs), updated_at: startAt.toISOString() } },
        { upsert: true, returnDocument: 'after' },
      );
      const lock = result?.value || result;
      if (!lock || lock.operation_id !== operationId) throw Object.assign(new Error('Another operation for this VM is already active.'), { category: 'vm_operation_busy' });
      previous = oldOperationId || oldLock?.previous_operation_id || null;
    } catch (error) {
      if (error.category === 'vm_operation_uncertain') throw error;
      if (error.category === 'vm_operation_busy' || error.code === 11000) {
        await updateOperation(operationId, { status: 'rejected', result_category: 'vm_operation_busy', updated_at: now().toISOString() }).catch(() => {});
        throw Object.assign(new Error('Another operation for this VM is already active. Try again after it finishes.'), { category: 'vm_operation_busy' });
      }
      await updateOperation(operationId, { status: 'failed', result_category: 'operation_lock_unavailable', updated_at: now().toISOString() }).catch(() => {});
      throw Object.assign(new Error('VM operation lock could not be acquired safely.'), { category: 'operation_lock_unavailable' });
    }

    let leaseLost = false;
    let quarantined = false;
    const heartbeat = setInterval(() => {
      collections.vm_operation_locks.updateOne(
        { vm_id: id, operation_id: operationId },
        { $set: { lease_expires_at: new Date(now().getTime() + leaseMs), updated_at: now().toISOString() } },
      ).then((result) => { if (!result.matchedCount) leaseLost = true; }).catch(() => { leaseLost = true; });
    }, heartbeatMs);
    heartbeat.unref?.();
    try {
      if (previous && previous !== operationId) {
        const prior = await collections.vm_operations.findOne({ operation_id: previous });
        if (prior && ['queued', 'running'].includes(prior.status)) {
          let observed = 'unavailable';
          try { observed = await inspectState(id); } catch (_) {}
          await updateOperation(previous, { status: 'uncertain', result_category: 'lease_expired', observed_state: observed, updated_at: now().toISOString() });
        }
      }
      await updateOperation(operationId, { status: 'running', started_at: now().toISOString(), updated_at: now().toISOString() });
      if (typeof validate === 'function') await validate();
      const result = await execute();
      if (leaseLost) throw Object.assign(new Error('The VM operation lock was lost; inspect VM state before retrying.'), { category: 'operation_uncertain' });
      await updateOperation(operationId, { status: 'completed', result: result?.state || null, result_category: result?.noop ? 'no_op' : 'success', finished_at: now().toISOString(), updated_at: now().toISOString() });
      await collections.vm_operation_locks.updateOne({ vm_id: id, operation_id: operationId }, { $set: { status: 'completed' } });
      return result;
    } catch (error) {
      const uncertain = leaseLost || error.category === 'operation_uncertain';
      if (uncertain) {
        quarantined = true;
        let observed = 'unavailable';
        try { observed = await inspectState(id); } catch (_) {}
        await quarantine(id, operationId, 'operation_uncertain', observed).catch(() => {});
      } else {
        await updateOperation(operationId, { status: 'failed', result_category: error.category || 'operation_failed', finished_at: now().toISOString(), updated_at: now().toISOString() }).catch(() => {});
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      if (!quarantined) {
        await collections.vm_operation_locks.updateOne(
          { vm_id: id, operation_id: operationId },
          { $set: { previous_operation_id: operationId, status: 'released', lease_expires_at: now(), updated_at: now().toISOString() }, $unset: { operation_id: '', actor_id: '', action: '' } },
        ).catch(() => {});
      }
    }
  };
}

module.exports = { createVmOperationCoordinator, LEASE_MS, HEARTBEAT_MS, UNCERTAIN_LEASE };
