const crypto = require('crypto');

const LIFECYCLE = new Set(['start_vm', 'stop_vm', 'restart_vm']);



const FILE_OPERATIONS = new Set(['write_file', 'create_directory', 'rename_file', 'delete_file']);
const TTL_MS = 10 * 60 * 1000;
const STALE_APPROVAL_MS = 2 * 60 * 1000;

function createAiApprovalService({ collections, vmService, ensureConnected, getPermissions, lifecycleEnabled = () => false, fileOpsEnabled = () => true, executeFileOperation = null, audit = async () => {}, now = () => new Date() }) {
  const operationEnabled = (operation) => (FILE_OPERATIONS.has(operation) ? fileOpsEnabled() : lifecycleEnabled());
  async function ownedVm(user, id) {
    const vm = await vmService.getVm(Number(id));
    if (!vm || !(await vmService.canAccess(user, vm, '*'))) throw Object.assign(new Error('VM not found or lifecycle access denied.'), { category: 'vm_access_denied' });
    return vm;
  }

  function state(vm) { return vmService.isRunning(vm) ? 'running' : 'stopped'; }

  async function event(record, action, status, extra = {}) {
    const at = now().toISOString();
    await audit({
      id: crypto.randomUUID(), event: `ai:approval_${action}`, user_id: record.user_id, vm_id: record.vm_id,
      timestamp: at,
      payload: { approval_id: record.approval_id, operation_id: record.operation_id, operation: record.operation, status, ...extra },
    });
  }

  async function propose({ user, vmId, operation, conversationId, parameters = null, explanation = null, impact = null, onProgress = () => {} }) {
    const userId = Number(user?.id);
    if (!Number.isSafeInteger(userId) || userId < 1) throw Object.assign(new Error('Authentication is required.'), { category: 'not_authenticated' });
    const isFileOp = FILE_OPERATIONS.has(operation);
    if (!LIFECYCLE.has(operation) && !isFileOp) throw Object.assign(new Error('This lifecycle operation is unavailable.'), { category: 'unknown_tool' });
    if (!operationEnabled(operation)) throw Object.assign(new Error(isFileOp ? 'File operations are disabled by the administrator.' : 'AI VM lifecycle actions are disabled by the administrator.'), { category: isFileOp ? 'file_ops_disabled' : 'lifecycle_globally_disabled' });
    await ensureConnected();
    const permissions = await getPermissions(userId);
    if (permissions?.[operation] !== true) throw Object.assign(new Error(isFileOp ? 'This file tool is disabled in your AI settings.' : 'This lifecycle tool is disabled in your AI settings.'), { category: 'tool_disabled' });
    const vm = await ownedVm(user, vmId);
    if (vm.suspended) throw Object.assign(new Error('This VM is suspended and cannot be controlled.'), { category: 'vm_suspended' });
    if (!isFileOp) {
      const current = state(vm);
      if ((operation === 'start_vm' && current === 'running') || (operation === 'stop_vm' && current === 'stopped') || (operation === 'restart_vm' && current === 'stopped')) {
        const result = { vm_id: vm.id, vm_name: String(vm.name || `VM ${vm.id}`).slice(0, 120), operation, state: current, noop: true, message: `No action taken: VM is already ${current}.` };
        onProgress({ type: 'tool_complete', name: operation, target: vm.id, status: 'no_op' });
        return result;
      }
    }
    const resolvedExplanation = explanation || (operation === 'start_vm'
      ? 'Start this QEMU virtual machine.'
      : operation === 'stop_vm'
        ? 'Stop this VM. Running applications and unsaved work may be interrupted.'
        : 'Restart this VM. Running applications and unsaved work may be interrupted.');
    const resolvedImpact = impact || resolvedExplanation;
    const targetSuffix = isFileOp && parameters && typeof parameters.path === 'string' ? `:${parameters.path}` : '';
    const key = `${userId}:${String(conversationId)}:${Number(vm.id)}:${operation}${targetSuffix}`;
    const existing = await collections.ai_approvals.findOne({ active_key: key, status: { $in: ['pending', 'approved'] } });
    if (existing) {
      onProgress({ type: 'approval_required', ...publicApproval(existing) });
      return { approval_required: true, ...publicApproval(existing) };
    }
    const created = now();
    const record = {
      approval_id: crypto.randomUUID(), operation_id: crypto.randomUUID(), active_key: key,
      user_id: userId, conversation_id: String(conversationId), vm_id: Number(vm.id), vm_name: String(vm.name || `VM ${vm.id}`).slice(0, 120),
      operation, parameters: isFileOp ? { vm_id: Number(vm.id), ...(parameters || {}) } : { vm_id: Number(vm.id) }, explanation: resolvedExplanation, impact: resolvedImpact,
      status: 'pending', created_at: created, expires_at: new Date(created.getTime() + TTL_MS),
    };
    try { await collections.ai_approvals.insertOne(record); }
    catch (error) {
      if (error.code !== 11000) throw error;
      const raced = await collections.ai_approvals.findOne({ active_key: key, status: { $in: ['pending', 'approved'] } });
      if (!raced) throw Object.assign(new Error('An approval request could not be created safely.'), { category: 'approval_unavailable' });
      onProgress({ type: 'approval_required', ...publicApproval(raced) });
      return { approval_required: true, ...publicApproval(raced) };
    }
    await event(record, 'created', 'pending');
    const response = publicApproval(record);
    onProgress({ type: 'approval_required', ...response });
    return { approval_required: true, ...response };
  }

  async function list(user, conversationId) {
    await ensureConnected();
    const userId = Number(user?.id);
    const rows = await collections.ai_approvals.find({ user_id: userId, conversation_id: String(conversationId) }).sort({ created_at: -1 }).limit(20).toArray();
    const current = now();
    for (const row of rows) {
      if (row.status === 'pending' && Date.parse(row.expires_at) <= current.getTime()) {
        await collections.ai_approvals.updateOne({ approval_id: row.approval_id, user_id: Number(userId), status: 'pending' }, { $set: { status: 'expired', updated_at: current.toISOString() }, $unset: { active_key: '' } });
        await event(row, 'expired', 'expired');
        row.status = 'expired';
      } else if (row.status === 'approved' && current.getTime() - Date.parse(row.decided_at) > STALE_APPROVAL_MS) {
        let observed = 'unavailable';
        try { observed = state(await ownedVm(user, row.vm_id)); } catch (_) {}
        const result = { category: 'operation_uncertain', message: 'The approval was claimed, but its final result was not recorded. Inspect VM state before requesting another action.', observed_state: observed };
        await collections.ai_approvals.updateOne({ approval_id: row.approval_id, user_id: userId, status: 'approved' }, { $set: { status: 'uncertain', result, finished_at: current.toISOString(), updated_at: current.toISOString() }, $unset: { active_key: '' } });
        await event(row, 'reconciled', 'uncertain', { observed_state: observed });
        row.status = 'uncertain'; row.result = result;
      }
    }
    return rows.map(publicApproval);
  }

  async function decide(user, approvalId, decision) {
    const userId = Number(user?.id);
    if (!Number.isSafeInteger(userId) || userId < 1) throw Object.assign(new Error('Authentication is required.'), { category: 'not_authenticated' });
    if (!['approve', 'reject'].includes(decision)) throw Object.assign(new Error('Invalid approval decision.'), { category: 'approval_invalid' });
    await ensureConnected();
    const at = now();
    const current = await collections.ai_approvals.findOne({ approval_id: String(approvalId), user_id: userId });
    if (!current) throw Object.assign(new Error('Approval request not found.'), { category: 'approval_not_found' });
    
    
    const decidedIsFileOp = FILE_OPERATIONS.has(current.operation);
    if (decision === 'approve' && !operationEnabled(decidedIsFileOp ? 'write_file' : 'start_vm')) throw Object.assign(new Error(decidedIsFileOp ? 'File operations are disabled by the administrator. This approval cannot execute.' : 'AI VM lifecycle actions are disabled by the administrator. This approval cannot execute.'), { category: decidedIsFileOp ? 'file_ops_disabled' : 'lifecycle_globally_disabled' });
    if (current.status !== 'pending') throw Object.assign(new Error(`This approval is already ${current.status} and cannot be reused.`), { category: 'approval_replayed' });
    const conversation = await collections.ai_conversations.findOne({ id: current.conversation_id, user_id: userId });
    if (!conversation) {
      await collections.ai_approvals.updateOne({ approval_id: current.approval_id, user_id: userId, status: 'pending' }, { $set: { status: 'cancelled', updated_at: at.toISOString() }, $unset: { active_key: '' } });
      await event(current, 'cancelled', 'cancelled');
      throw Object.assign(new Error('This conversation has been removed. The pending operation was cancelled.'), { category: 'approval_cancelled' });
    }
    if (Date.parse(current.expires_at) <= at.getTime()) {
      await collections.ai_approvals.updateOne({ approval_id: current.approval_id, user_id: userId, status: 'pending' }, { $set: { status: 'expired', updated_at: at.toISOString() }, $unset: { active_key: '' } });
      await event({ ...current, user_id: userId }, 'expired', 'expired');
      throw Object.assign(new Error('This approval has expired. Ask the assistant to create a new request.'), { category: 'approval_expired' });
    }
    const next = decision === 'approve' ? 'approved' : 'rejected';
    const claimedResult = await collections.ai_approvals.findOneAndUpdate(
      { approval_id: current.approval_id, user_id: userId, status: 'pending', expires_at: { $gt: at } },
      { $set: { status: next, decided_at: at, decided_by: userId, updated_at: at.toISOString() }, ...(decision === 'reject' ? { $unset: { active_key: '' } } : {}) },
      { returnDocument: 'after' },
    );
    const claimed = claimedResult?.value || claimedResult;
    if (!claimed || claimed.status !== next) throw Object.assign(new Error('This approval was already handled or expired.'), { category: 'approval_replayed' });
    await event(claimed, decision, next);
    if (decision === 'reject') return publicApproval(claimed);

    try {
      const claimedIsFileOp = FILE_OPERATIONS.has(claimed.operation);
      if ((!LIFECYCLE.has(claimed.operation) && !claimedIsFileOp) || Number(claimed.parameters?.vm_id) !== Number(claimed.vm_id)) throw Object.assign(new Error('Approval parameters failed validation.'), { category: 'approval_invalid' });
      if (claimedIsFileOp && (typeof claimed.parameters?.path !== 'string' || !claimed.parameters.path)) throw Object.assign(new Error('Approval parameters failed validation.'), { category: 'approval_invalid' });
      const permissions = await getPermissions(userId);
      if (permissions?.[claimed.operation] !== true) throw Object.assign(new Error(claimedIsFileOp ? 'This file tool is no longer enabled.' : 'This lifecycle tool is no longer enabled.'), { category: 'tool_disabled' });
      const vm = await ownedVm(user, claimed.vm_id);
      if (vm.suspended) throw Object.assign(new Error('This VM is suspended and cannot be controlled.'), { category: 'vm_suspended' });
      if (claimedIsFileOp) {
        if (typeof executeFileOperation !== 'function') throw Object.assign(new Error('File operations are unavailable until the file executor is configured.'), { category: 'approval_unavailable' });
        const fileResult = await executeFileOperation({ user, vm, record: claimed });
        if (!fileResult?.ok) throw Object.assign(new Error(fileResult?.message || 'The file operation did not complete.'), { category: fileResult?.category || 'file_operation_failed' });
        const fres = { state: fileResult.state || 'completed', operation_id: claimed.operation_id, noop: Boolean(fileResult.noop), message: fileResult.message || 'File operation completed and was verified.' };
        await collections.ai_approvals.updateOne({ approval_id: claimed.approval_id, status: 'approved' }, { $set: { status: 'executed', result: fres, finished_at: now().toISOString() }, $unset: { active_key: '' } });
        await event(claimed, 'executed', 'executed', { result_category: fileResult.noop ? 'no_op' : 'success' });
        return publicApproval({ ...claimed, status: 'executed', result: fres });
      }
      const observedBefore = state(vm);
      const invalidState = (claimed.operation === 'start_vm' && observedBefore !== 'stopped')
        || (claimed.operation === 'stop_vm' && observedBefore !== 'running')
        || (claimed.operation === 'restart_vm' && observedBefore !== 'running');
      if (invalidState) {
        const noop = { ...claimed, status: 'executed', result: { state: observedBefore, noop: true, message: `No action taken: VM is already ${observedBefore}.` } };
        await collections.ai_approvals.updateOne({ approval_id: claimed.approval_id, status: 'approved' }, { $set: { status: 'executed', result: noop.result, finished_at: now().toISOString() }, $unset: { active_key: '' } });
        await event(claimed, 'executed', 'executed', { result_category: 'no_op' });
        return publicApproval(noop);
      }
      const validateBeforeExecution = async () => {
        const currentPermissions = await getPermissions(userId);
        if (currentPermissions?.[claimed.operation] !== true) throw Object.assign(new Error('This lifecycle tool is no longer enabled.'), { category: 'tool_disabled' });
        const latestVm = await ownedVm(user, claimed.vm_id);
        if (latestVm.suspended || state(latestVm) !== observedBefore) throw Object.assign(new Error('VM ownership or state changed while the operation was being approved. Request a fresh approval.'), { category: 'approval_stale' });
      };
      let serviceResult;
      if (claimed.operation === 'start_vm') serviceResult = await vmService.start(vm, { user, operationId: claimed.operation_id, validate: validateBeforeExecution });
      else if (claimed.operation === 'stop_vm') serviceResult = await vmService.stop(vm, { user, operationId: claimed.operation_id, validate: validateBeforeExecution });
      else serviceResult = await vmService.restart(vm, user, { operationId: claimed.operation_id, validate: validateBeforeExecution });
      const currentState = state(await ownedVm(user, claimed.vm_id));
      const desired = claimed.operation === 'stop_vm' ? 'stopped' : 'running';
      if (!serviceResult?.ok || currentState !== desired) throw Object.assign(new Error('The VM service did not confirm the requested final state.'), { category: 'operation_uncertain' });
      const result = { state: currentState, operation_id: claimed.operation_id, noop: Boolean(serviceResult.noop), message: serviceResult.noop ? 'No state change was needed.' : `${claimed.operation.replace('_vm', '')} completed and VM state was verified.` };
      await collections.ai_approvals.updateOne({ approval_id: claimed.approval_id, status: 'approved' }, { $set: { status: 'executed', result, finished_at: now().toISOString() }, $unset: { active_key: '' } });
      await event(claimed, 'executed', 'executed', { result_category: serviceResult.noop ? 'no_op' : 'success', final_state: currentState });
      return publicApproval({ ...claimed, status: 'executed', result });
    } catch (error) {
      const uncertain = error.category === 'operation_uncertain';
      const final = uncertain ? 'uncertain' : 'failed';
      let observedState = 'unavailable';
      try { observedState = state(await ownedVm(user, claimed.vm_id)); } catch (_) {}
      const messages = {
        operation_uncertain: 'The operation result is uncertain. Inspect the VM state before requesting another action.',
        vm_operation_busy: 'Another operation is in progress for this VM. No new action was started.',
        approval_stale: 'VM ownership or state changed before execution. No action was taken; request a new approval.',
        tool_disabled: 'This lifecycle tool is no longer enabled. No action was taken.',
        vm_suspended: 'This VM is suspended and cannot be controlled.',
        vm_start_failed: 'QEMU did not confirm that the VM started. Check its status and boot logs.',
        vm_image_unavailable: 'The VM disk image is unavailable. No start was confirmed.',
      };
      const safeError = { category: error.category || 'operation_failed', message: messages[error.category] || (FILE_OPERATIONS.has(claimed.operation) ? 'The file operation failed. Inspect the VM files before retrying.' : 'The VM operation failed. Inspect the VM and its logs before retrying.'), observed_state: observedState };
      await collections.ai_approvals.updateOne({ approval_id: claimed.approval_id, status: 'approved' }, { $set: { status: final, result: safeError, finished_at: now().toISOString() }, $unset: { active_key: '' } });
      await event(claimed, final, final, { result_category: safeError.category });
      return publicApproval({ ...claimed, status: final, result: safeError });
    }
  }

  return { propose, list, decide };
}

function publicApproval(row) {
  return {
    approval_id: row.approval_id,
    vm_id: row.vm_id,
    vm_name: row.vm_name,
    operation: row.operation,
    explanation: row.explanation,
    impact: row.impact,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    result: row.result || null,
  };
}

module.exports = { createAiApprovalService, publicApproval, LIFECYCLE, FILE_OPERATIONS, TTL_MS, STALE_APPROVAL_MS };
