const test = require('node:test');
const assert = require('node:assert/strict');
const { OPS_TOOL_DEFINITIONS, createOpsToolRunner, validateOpsArguments, defaultOpsPermissions } = require('../src/services/aiOpsTools');

test('operations catalogue is read-only and enabled by default', () => {
  assert.deepEqual(OPS_TOOL_DEFINITIONS.map((t) => t.name).sort(), ['get_incident', 'get_schedule', 'list_incidents', 'list_schedules']);
  for (const tool of OPS_TOOL_DEFINITIONS) {
    assert.equal(tool.risk, 'read_only', tool.name);
    assert.equal(tool.approval_required, false, tool.name);
  }
  assert.deepEqual(Object.values(defaultOpsPermissions()), [true, true, true, true]);
  assert.throws(() => validateOpsArguments('nope', {}), /unavailable/);
  assert.throws(() => validateOpsArguments('get_schedule', {}), /required/);
  assert.throws(() => validateOpsArguments('get_schedule', { schedule_id: 0 }), /invalid/);
});

function opsFixture({ schedules = [], incidents = new Map(), permissions = null } = {}) {
  const calls = [];
  const collections = {
    vms: { find() { return { project() { return this; }, limit() { return this; }, async toArray() { return [{ id: 7 }, { id: 8 }]; } }; } },
    subusers: { find() { return { project() { return this; }, limit() { return this; }, async toArray() { return []; } }; } },
    schedules: {
      find(filter) {
        calls.push(['schedules.find', JSON.stringify(filter)]);
        const rows = schedules.filter((r) => (filter.vm_id === undefined || (filter.vm_id.$in ? filter.vm_id.$in.includes(r.vm_id) : r.vm_id === filter.vm_id)));
        return { sort() { return this; }, limit() { return this; }, async toArray() { return structuredClone(rows); } };
      },
      async findOne(filter) {
        const row = schedules.find((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
        return row ? structuredClone(row) : null;
      },
    },
  };
  const incidentService = {
    async listIncidents(user, opts) {
      calls.push(['incidents.list', user.id]);
      if (Number(user.id) !== 9) return { incidents: [], total: 0 };
      return { incidents: [...incidents.values()], total: incidents.size };
    },
    async getIncident(user, id) {
      calls.push(['incidents.get', id]);
      const row = incidents.get(Number(id));
      if (!row || row.owner_id !== Number(user.id)) throw Object.assign(new Error('Incident not found.'), { category: 'incident_not_found' });
      return structuredClone(row);
    },
  };
  const tools = { list_schedules: true, get_schedule: true, list_incidents: true, get_incident: true, ...(permissions || {}) };
  const runOpsTool = createOpsToolRunner({
    vmService: {}, collections, incidentService,
    getPermissions: async () => ({ ...tools }),
    auditStart: async () => {},
    auditFinish: async () => {},
  });
  return { runOpsTool, calls };
}

test('schedules are scoped to owned VMs and errors redacted', async () => {
  const f = opsFixture({
    schedules: [
      { id: 1, vm_id: 7, name: 'nightly', action: 'backup', enabled: true, cron: 'daily', last_error: 'password=hunter2 failed' },
      { id: 2, vm_id: 99, name: 'other', action: 'stop', enabled: true, cron: 'daily' },
    ],
  });
  const listed = await f.runOpsTool({ id: 9 }, 'list_schedules', {}, () => {});
  assert.deepEqual(listed.schedules.map((s) => s.id), [1]);
  assert.ok(!listed.schedules[0].last_error.includes('hunter2'));
  const one = await f.runOpsTool({ id: 9 }, 'get_schedule', { schedule_id: 1 }, () => {});
  assert.equal(one.name, 'nightly');
  await assert.rejects(f.runOpsTool({ id: 9 }, 'get_schedule', { schedule_id: 2 }, () => {}), /not found/);
});

test('incidents are owner-isolated and deny cross-user reads', async () => {
  const incidents = new Map([[5, { id: 5, owner_id: 9, resource_type: 'vm', resource_id: 7, category: 'unexpected_stop', severity: 'high', status: 'detected', recovery_attempts: [] }]]);
  const f = opsFixture({ incidents });
  const listed = await f.runOpsTool({ id: 9 }, 'list_incidents', {}, () => {});
  assert.equal(listed.total, 1);
  const one = await f.runOpsTool({ id: 9 }, 'get_incident', { incident_id: 5 }, () => {});
  assert.equal(one.category, 'unexpected_stop');
  await assert.rejects(f.runOpsTool({ id: 10 }, 'get_incident', { incident_id: 5 }, () => {}), /not found/);
  const empty = await f.runOpsTool({ id: 10 }, 'list_incidents', {}, () => {});
  assert.equal(empty.total, 0);
});

test('disabled ops tools and unknown names fail closed', async () => {
  const f = opsFixture({ permissions: { list_schedules: false } });
  await assert.rejects(f.runOpsTool({ id: 9 }, 'list_schedules', {}, () => {}), /disabled/);
  await assert.rejects(f.runOpsTool({ id: 9 }, 'restart_minecraft', {}, () => {}), /unavailable/);
  await assert.rejects(f.runOpsTool(null, 'list_schedules', {}, () => {}), /Authentication/);
});
