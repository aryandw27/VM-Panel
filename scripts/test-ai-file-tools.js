const test = require('node:test');
const assert = require('node:assert/strict');
const { FILE_TOOL_DEFINITIONS, FILE_OPERATIONS, createFileToolRunner, validateFileArguments, sanitizeGuestPath, defaultFilePermissions, redactFileText } = require('../src/services/aiFileTools');
const { redactVmLog } = require('../src/services/aiVmTools');

test('file catalogue exposes reads without approval and gates every modification', () => {
  assert.deepEqual([...FILE_OPERATIONS].sort(), ['create_directory', 'delete_file', 'list_files', 'read_file', 'rename_file', 'search_files', 'write_file']);
  for (const tool of FILE_TOOL_DEFINITIONS) {
    if (tool.risk === 'read_only') assert.equal(tool.approval_required, false, tool.name);
    else assert.equal(tool.approval_required, true, tool.name);
  }
  const defaults = defaultFilePermissions();
  assert.equal(defaults.list_files, true);
  assert.equal(defaults.read_file, true);
  assert.equal(defaults.search_files, true);
  assert.equal(defaults.write_file, false);
  assert.equal(defaults.create_directory, false);
  assert.equal(defaults.rename_file, false);
  assert.equal(defaults.delete_file, false);
});

test('guest paths are normalized and confined', () => {
  assert.equal(sanitizeGuestPath('/var/log/app.log'), '/var/log/app.log');
  assert.equal(sanitizeGuestPath('docs/readme.md'), '/docs/readme.md');
  assert.equal(sanitizeGuestPath('a/../../etc/passwd'), '/etc/passwd');
  assert.equal(sanitizeGuestPath('/'), '/');
  assert.throws(() => sanitizeGuestPath(''), /invalid path/);
  assert.throws(() => sanitizeGuestPath('   '), /invalid path/);
  assert.throws(() => sanitizeGuestPath(null), /invalid path/);
  assert.throws(() => sanitizeGuestPath('/x\0y'), /invalid path/);
  assert.throws(() => sanitizeGuestPath(`/${'a'.repeat(600)}`), /invalid path/);
});

test('file arguments are validated strictly', () => {
  assert.throws(() => validateFileArguments('nope', {}), /unavailable/);
  assert.throws(() => validateFileArguments('read_file', { vm_id: 1 }), /required/);
  assert.throws(() => validateFileArguments('read_file', { vm_id: 1, path: '/a', extra: 1 }), /invalid/);
  assert.throws(() => validateFileArguments('read_file', { vm_id: -2, path: '/a' }), /invalid/);
  assert.throws(() => validateFileArguments('delete_file', { vm_id: 1, path: '/a', recursive: 'yes' }), /invalid/);
  assert.deepEqual(validateFileArguments('read_file', { vm_id: 3, path: '/a.log' }), { vm_id: 3, path: '/a.log' });
});

test('file text redacts secrets before reaching the model', () => {
  const dirty = 'password=SuperSecret1\ntoken abc123\n{"api_key":"sk-live-1234567890"}\n-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c\nplain line';
  const clean = redactFileText(redactVmLog, dirty);
  assert.ok(!clean.includes('SuperSecret1'), 'password redacted');
  assert.ok(!clean.includes('sk-live-1234567890'), 'api key redacted');
  assert.ok(!clean.includes('MIIB'), 'private key redacted');
  assert.ok(!clean.includes('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'), 'jwt redacted');
  assert.ok(clean.includes('plain line'), 'ordinary text preserved');
});

function fileFixture({ permissions } = {}) {
  const calls = [];
  const agentService = {
    async listDir(vm, dir) {
      calls.push(['listDir', dir]);
      if (dir === '/missing') throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      return [{ name: 'app.log', type: 'file', size: 12 }, { name: 'docs', type: 'dir' }];
    },
    async readFile(vm, file) {
      calls.push(['readFile', file]);
      if (file === '/secret.txt') return 'password=hunter2\nok';
      if (file === '/binary.bin') return 'ab\x00cd';
      return 'hello world';
    },
    async writeFile() { calls.push(['writeFile']); },
    async mkdir() { calls.push(['mkdir']); },
    async rename() { calls.push(['rename']); },
    async rm() { calls.push(['rm']); },
  };
  const vmService = {
    async getVm(id) { return Number(id) === 7 ? { id: 7, owner_id: 9 } : null; },
    async canAccess(user) { return Number(user.id) === 9; },
  };
  const tools = { list_files: true, read_file: true, search_files: true, write_file: true, create_directory: true, rename_file: true, delete_file: true, ...(permissions || {}) };
  const audits = [];
  const runFileTool = createFileToolRunner({
    agentService, vmService, collections: {},
    getPermissions: async () => ({ ...tools }),
    auditStart: async (r) => audits.push(['start', r.payload.tool_name]),
    auditFinish: async () => audits.push(['finish']),
    proposeFileOperation: async ({ operation, parameters }) => ({ approval_required: true, operation, parameters }),
    redactSecrets: (text) => redactVmLog(String(text ?? '')),
  });
  return { runFileTool, calls, audits };
}

test('reads are ownership-checked, bounded, and secret-scrubbed', async () => {
  const f = fileFixture();
  const user = { id: 9 };
  const listed = await f.runFileTool(user, 'list_files', { vm_id: 7, path: '/' }, () => {});
  assert.equal(listed.entries.length, 2);
  const read = await f.runFileTool(user, 'read_file', { vm_id: 7, path: '/secret.txt' }, () => {});
  assert.ok(!read.content.includes('hunter2'));
  await assert.rejects(f.runFileTool(user, 'read_file', { vm_id: 7, path: '/binary.bin' }, () => {}), /Binary/);
  await assert.rejects(f.runFileTool({ id: 10 }, 'list_files', { vm_id: 7, path: '/' }, () => {}), /denied/);
  const found = await f.runFileTool(user, 'search_files', { vm_id: 7, path: '/', query: 'app' }, () => {});
  assert.deepEqual(found.matches, ['app.log']);
  assert.match(found.note, /Filename search only/);
});

test('modifications only ever propose approvals, never execute inline', async () => {
  const f = fileFixture();
  const user = { id: 9 };
  for (const [name, args] of [
    ['write_file', { vm_id: 7, path: '/a.txt', content: 'hi' }],
    ['create_directory', { vm_id: 7, path: '/new' }],
    ['rename_file', { vm_id: 7, path: '/a', destination: '/b' }],
    ['delete_file', { vm_id: 7, path: '/a', recursive: false }],
  ]) {
    const out = await f.runFileTool(user, name, args, () => {});
    assert.equal(out.approval_required, true, name);
  }
  assert.ok(!f.calls.some(([c]) => ['writeFile', 'mkdir', 'rename', 'rm'].includes(c)), 'no modifying agent call ran');
});

test('disabled tools and audit failures fail closed', async () => {
  const f = fileFixture({ permissions: { read_file: false } });
  await assert.rejects(f.runFileTool({ id: 9 }, 'read_file', { vm_id: 7, path: '/a' }, () => {}), /disabled/);
  await assert.rejects(f.runFileTool({ id: 9 }, 'nope', {}, () => {}), /unavailable/);
  await assert.rejects(f.runFileTool(null, 'list_files', { vm_id: 7, path: '/' }, () => {}), /Authentication/);
});
