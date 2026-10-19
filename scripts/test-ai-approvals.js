const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiApprovalService } = require('../src/services/aiApprovalService');

function makeFixture({ lifecycleEnabled = true } = {}) {
  let clock = new Date('2026-01-01T00:00:00Z');
  const docs = new Map();
  const audit = [];
  const vm = { id: 22, owner_id: 5, name: 'Production', suspended: false };
  const state = new Map([[22, 'running']]);
  const permissions = { start_vm: true, stop_vm: true, restart_vm: true };
  let globalEnabled = lifecycleEnabled;
  const calls = [];
  let beforeValidate = null;
  const match = (row, filter) => Object.entries(filter).every(([key, value]) => {
    if (key === 'status' && value?.$in) return value.$in.includes(row.status);
    if (key === 'expires_at' && value?.$gt) return row.expires_at > value.$gt;
    return row[key] === value;
  });
  const collections = {
    ai_conversations: { async findOne(filter) { return filter.user_id === 5 ? { id: filter.id, user_id: 5 } : null; } },
    ai_approvals: {
      async findOne(filter) { return structuredClone([...docs.values()].find((row) => match(row, filter)) || null); },
      async insertOne(row) {
        if (docs.has(row.approval_id) || [...docs.values()].some((item) => row.active_key && item.active_key === row.active_key)) throw Object.assign(new Error('duplicate'), { code: 11000 });
        docs.set(row.approval_id, structuredClone(row));
      },
      find(filter) { return { sort() { return this; }, limit() { return this; }, async toArray() { return structuredClone([...docs.values()].filter((row) => match(row, filter))); } }; },
      async updateOne(filter, update) {
        const row = [...docs.values()].find((item) => match(item, filter));
        if (!row) return { matchedCount: 0 };
        Object.assign(row, structuredClone(update.$set || {}));
        for (const key of Object.keys(update.$unset || {})) delete row[key];
        return { matchedCount: 1 };
      },
      async findOneAndUpdate(filter, update) {
        const row = [...docs.values()].find((item) => match(item, filter));
        if (!row) return null;
        Object.assign(row, structuredClone(update.$set || {}));
        for (const key of Object.keys(update.$unset || {})) delete row[key];
        return structuredClone(row);
      },
    },
  };
  const vmService = {
    async getVm(id) { return Number(id) === vm.id ? { ...vm } : null; },
    async canAccess(user, target, permission) { return target.owner_id === Number(user.id) || user.role === 'admin' || (permission === '*' && user.full_vm_access === true); },
    isRunning(target) { return state.get(target.id) === 'running'; },
    async start(target, options) { calls.push('start'); await beforeValidate?.(); await options.validate?.(); state.set(target.id, 'running'); return { ok: true, state: 'running' }; },
    async stop(target, options) { calls.push('stop'); await beforeValidate?.(); await options.validate?.(); state.set(target.id, 'stopped'); return { ok: true, state: 'stopped' }; },
    async restart(target, user, options) { calls.push('restart'); await beforeValidate?.(); await options.validate?.(); state.set(target.id, 'running'); return { ok: true, state: 'running' }; },
  };
  const service = createAiApprovalService({ collections, vmService, ensureConnected: async () => {}, getPermissions: async () => ({ ...permissions }), lifecycleEnabled: () => globalEnabled, audit: async (row) => audit.push(row), now: () => clock });
  return { service, docs, audit, state, permissions, calls, vmService, vm, setNow: (date) => { clock = new Date(date); }, setBeforeValidate: (fn) => { beforeValidate = fn; }, setGlobalEnabled: (value) => { globalEnabled = value; } };
}

test('proposal is pending only; explicit approval executes the exact action once', async () => {
  const f = makeFixture();
  const progress = [];
  const proposal = await f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'restart_vm', conversationId: 'thread-a', onProgress: (event) => progress.push(event) });
  assert.equal(proposal.approval_required, true);
  assert.equal(f.calls.length, 0);
  assert.equal(progress[0].type, 'approval_required');
  const stored = f.docs.get(proposal.approval_id);
  assert.equal(stored.status, 'pending');
  assert.equal(stored.parameters.vm_id, 22);
  const result = await f.service.decide({ id: 5 }, proposal.approval_id, 'approve');
  assert.equal(result.status, 'executed');
  assert.deepEqual(f.calls, ['restart']);
  await assert.rejects(f.service.decide({ id: 5 }, proposal.approval_id, 'approve'), { category: 'approval_replayed' });
  assert.deepEqual(f.audit.map((row) => row.event), ['ai:approval_created', 'ai:approval_approve', 'ai:approval_executed']);
});

test('repeated lifecycle proposal reuses the current pending approval', async () => {
  const f = makeFixture();
  const args = { user: { id: 5 }, vmId: 22, operation: 'stop_vm', conversationId: 'thread-dedupe' };
  const first = await f.service.propose(args);
  const second = await f.service.propose(args);
  assert.equal(second.approval_id, first.approval_id);
  assert.equal(f.docs.size, 1);
  assert.equal(f.calls.length, 0);
});

test('reject is final and another user cannot see or decide the approval', async () => {
  const f = makeFixture();
  const proposal = await f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'stop_vm', conversationId: 'thread-b' });
  await assert.rejects(f.service.decide({ id: 6 }, proposal.approval_id, 'approve'), { category: 'approval_not_found' });
  const rejected = await f.service.decide({ id: 5 }, proposal.approval_id, 'reject');
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.service.decide({ id: 5 }, proposal.approval_id, 'approve'), { category: 'approval_replayed' });
});

test('subusers without full VM access cannot create lifecycle approvals', async () => {
  const f = makeFixture();
  await assert.rejects(f.service.propose({ user: { id: 6 }, vmId: 22, operation: 'stop_vm', conversationId: 'thread-sub' }), { category: 'vm_access_denied' });
  assert.equal(f.docs.size, 0);
});

test('expired approvals cannot execute', async () => {
  const f = makeFixture();
  const proposal = await f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'stop_vm', conversationId: 'thread-c' });
  f.setNow('2026-01-01T00:11:00Z');
  await assert.rejects(f.service.decide({ id: 5 }, proposal.approval_id, 'approve'), { category: 'approval_expired' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.docs.get(proposal.approval_id).status, 'expired');
});

test('forged VM and disabled tools are rejected before an approval is created', async () => {
  const f = makeFixture();
  await assert.rejects(f.service.propose({ user: { id: 5 }, vmId: 999, operation: 'start_vm', conversationId: 'thread-d' }), { category: 'vm_access_denied' });
  f.permissions.stop_vm = false;
  await assert.rejects(f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'stop_vm', conversationId: 'thread-d' }), { category: 'tool_disabled' });
  assert.equal(f.docs.size, 0);
});

test('global lifecycle kill switch blocks proposals without changing read-only tools', async () => {
  const f = makeFixture({ lifecycleEnabled: false });
  await assert.rejects(f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'stop_vm', conversationId: 'thread-global-off' }), { category: 'lifecycle_globally_disabled' });
  assert.equal(f.docs.size, 0);
  assert.equal(f.calls.length, 0);
});

test('global switch is checked again at approval time and leaves request non-executable', async () => {
  const f = makeFixture({ lifecycleEnabled: true });
  const proposal = await f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'stop_vm', conversationId: 'thread-global-changed' });
  f.setGlobalEnabled(false);
  await assert.rejects(f.service.decide({ id: 5 }, proposal.approval_id, 'approve'), { category: 'lifecycle_globally_disabled' });
  assert.equal(f.docs.get(proposal.approval_id).status, 'pending');
  assert.equal(f.calls.length, 0);
});

test('permissions and VM state are revalidated after approval, including under the operation lock', async () => {
  const f = makeFixture();
  f.state.set(22, 'stopped');
  const proposal = await f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'start_vm', conversationId: 'thread-e' });
  f.setBeforeValidate(() => { f.state.set(22, 'running'); });
  const final = await f.service.decide({ id: 5 }, proposal.approval_id, 'approve');
  assert.equal(final.status, 'failed');
  assert.equal(final.result.category, 'approval_stale');
  assert.equal(f.calls.length, 1);
  assert.equal(f.state.get(22), 'running');
});

test('an operation already in its desired state is reported as a no-op', async () => {
  const f = makeFixture();
  f.state.set(22, 'stopped');
  const proposal = await f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'start_vm', conversationId: 'thread-f' });
  f.state.set(22, 'running');
  const final = await f.service.decide({ id: 5 }, proposal.approval_id, 'approve');
  assert.equal(final.status, 'executed');
  assert.equal(final.result.noop, true);
  assert.equal(f.calls.length, 0);
});

test('a disabled tool after proposal cannot be executed by direct approval API use', async () => {
  const f = makeFixture();
  const proposal = await f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'stop_vm', conversationId: 'thread-g' });
  f.permissions.stop_vm = false;
  const result = await f.service.decide({ id: 5 }, proposal.approval_id, 'approve');
  assert.equal(result.status, 'failed');
  assert.equal(result.result.category, 'tool_disabled');
  assert.equal(f.calls.length, 0);
});

test('approval parameters cannot be substituted after the request was created', async () => {
  const f = makeFixture();
  const proposal = await f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'stop_vm', conversationId: 'thread-params' });
  f.docs.get(proposal.approval_id).parameters.vm_id = 999;
  const result = await f.service.decide({ id: 5 }, proposal.approval_id, 'approve');
  assert.equal(result.status, 'failed');
  assert.equal(result.result.category, 'approval_invalid');
  assert.deepEqual(f.calls, []);
});

test('VM ownership is checked again after approval and denial does not call QEMU', async () => {
  const f = makeFixture();
  const proposal = await f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'stop_vm', conversationId: 'thread-owner-change' });
  f.vm.owner_id = 77;
  const result = await f.service.decide({ id: 5 }, proposal.approval_id, 'approve');
  assert.equal(result.status, 'failed');
  assert.equal(result.result.category, 'vm_access_denied');
  assert.deepEqual(f.calls, []);
});

test('uncertain service outcome is returned as uncertain with observed state, not success', async () => {
  const f = makeFixture();
  const proposal = await f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'stop_vm', conversationId: 'thread-uncertain' });
  f.vmService.stop = async () => { throw Object.assign(new Error('internal detail must not leak'), { category: 'operation_uncertain' }); };
  const result = await f.service.decide({ id: 5 }, proposal.approval_id, 'approve');
  assert.equal(result.status, 'uncertain');
  assert.equal(result.result.observed_state, 'running');
  assert.equal(result.result.message.includes('internal detail'), false);
});

test('simultaneous approve clicks execute at most once', async () => {
  const f = makeFixture();
  const proposal = await f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'stop_vm', conversationId: 'thread-race' });
  const outcomes = await Promise.allSettled([
    f.service.decide({ id: 5 }, proposal.approval_id, 'approve'),
    f.service.decide({ id: 5 }, proposal.approval_id, 'approve'),
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.deepEqual(f.calls, ['stop']);
});

test('stale approved request is reconciled and becomes uncertain instead of being replayed', async () => {
  const f = makeFixture();
  const proposal = await f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'stop_vm', conversationId: 'thread-stale' });
  const row = f.docs.get(proposal.approval_id);
  row.status = 'approved';
  row.decided_at = new Date('2025-12-31T23:55:00Z');
  const listed = await f.service.list({ id: 5 }, 'thread-stale');
  assert.equal(listed[0].status, 'uncertain');
  assert.equal(listed[0].result.observed_state, 'running');
  assert.equal(f.calls.length, 0);
});
