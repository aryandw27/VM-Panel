const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiApprovalService, FILE_OPERATIONS } = require('../src/services/aiApprovalService');

function makeFixture({ lifecycleEnabled = false, fileOpsEnabled = true, executor = null } = {}) {
  let clock = new Date('2026-01-01T00:00:00Z');
  const docs = new Map();
  const audit = [];
  const executed = [];
  const vm = { id: 22, owner_id: 5, name: 'Production', suspended: false };
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
    async canAccess(user) { return Number(user.id) === 5; },
    isRunning: () => false,
    async start() { throw new Error('must not run in file tests'); },
  };
  const permissions = { write_file: true, create_directory: true, rename_file: true, delete_file: true, start_vm: true };
  const service = createAiApprovalService({
    collections, vmService, ensureConnected: async () => {}, getPermissions: async () => ({ ...permissions }),
    lifecycleEnabled: () => lifecycleEnabled, fileOpsEnabled: () => fileOpsEnabled,
    executeFileOperation: executor || (async ({ record }) => { executed.push(record.operation); return { ok: true, state: 'written', message: 'done' }; }),
    audit: async (row) => audit.push(row), now: () => clock,
  });
  return { service, docs, audit, executed, permissions, setNow: (d) => { clock = new Date(d); } };
}

test('file operations are a distinct approval set outside the lifecycle switch', () => {
  assert.deepEqual([...FILE_OPERATIONS].sort(), ['create_directory', 'delete_file', 'rename_file', 'write_file']);
});

test('write proposal stores exact parameters and executes once on approval', async () => {
  const f = makeFixture();
  const proposal = await f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'write_file', conversationId: 't', parameters: { vm_id: 22, path: '/app/a.txt', content: 'hi' }, explanation: 'Write a.', impact: 'Replaces a.' });
  assert.equal(proposal.approval_required, true);
  assert.equal(proposal.operation, 'write_file');
  assert.match(proposal.impact, /Replaces/);
  const decided = await f.service.decide({ id: 5 }, proposal.approval_id, 'approve');
  assert.equal(decided.status, 'executed');
  assert.deepEqual(f.executed, ['write_file']);
  await assert.rejects(f.service.decide({ id: 5 }, proposal.approval_id, 'approve'), /already executed/);
});

test('file approvals work while the lifecycle switch stays off', async () => {
  const f = makeFixture({ lifecycleEnabled: false });
  const proposal = await f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'delete_file', conversationId: 't', parameters: { vm_id: 22, path: '/tmp/x' }, explanation: 'e', impact: 'i' });
  const decided = await f.service.decide({ id: 5 }, proposal.approval_id, 'approve');
  assert.equal(decided.status, 'executed');
  await assert.rejects(f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'stop_vm', conversationId: 't' }), /disabled by the administrator/);
});

test('tampered parameters and disabled tools fail closed', async () => {
  const f = makeFixture();
  const proposal = await f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'write_file', conversationId: 't', parameters: { vm_id: 22, path: '/a', content: 'x' }, explanation: 'e', impact: 'i' });
  const stored = f.docs.get(proposal.approval_id);
  stored.parameters.vm_id = 23;
  const tampered = await f.service.decide({ id: 5 }, proposal.approval_id, 'approve');
  assert.equal(tampered.status, 'failed');
  assert.deepEqual(f.executed, []);

  const g = makeFixture();
  g.permissions.write_file = false;
  await assert.rejects(g.service.propose({ user: { id: 5 }, vmId: 22, operation: 'write_file', conversationId: 't', parameters: { vm_id: 22, path: '/a', content: 'x' }, explanation: 'e', impact: 'i' }), /disabled in your AI settings/);
});

test('guest root deletion is refused and uncertain verification quarantines', async () => {
  const f = makeFixture({ executor: async () => { throw Object.assign(new Error('nope'), { category: 'operation_uncertain' }); } });
  const proposal = await f.service.propose({ user: { id: 5 }, vmId: 22, operation: 'delete_file', conversationId: 't', parameters: { vm_id: 22, path: '/gone' }, explanation: 'e', impact: 'i' });
  
  
  const decided = await f.service.decide({ id: 5 }, proposal.approval_id, 'approve');
  assert.equal(decided.status, 'uncertain');
});
