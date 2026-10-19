const crypto = require('crypto');
const path = require('path');













const TOOL_TIMEOUT_MS = 8000;
const MAX_OUTPUT_BYTES = 12 * 1024;
const MAX_READ_BYTES = 64 * 1024;
const MAX_WRITE_BYTES = 256 * 1024;
const MAX_PATH_LENGTH = 512;
const MAX_LIST_ENTRIES = 200;

const pathProperty = (description) => ({ type: 'string', minLength: 1, maxLength: MAX_PATH_LENGTH, description });

const FILE_TOOL_DEFINITIONS = [
  { name: 'list_files', category: 'file_operations', risk: 'read_only', required_permission: 'vm_access', approval_required: false, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'List files and directories inside one accessible VM guest filesystem at the given directory path. Read-only; needs no approval.', input_schema: { type: 'object', properties: { vm_id: { type: 'integer', minimum: 1, description: 'Accessible VM identifier.' }, path: pathProperty('Guest directory path to list.') }, required: ['vm_id', 'path'], additionalProperties: false } },
  { name: 'read_file', category: 'file_operations', risk: 'read_only', required_permission: 'vm_access', approval_required: false, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'Read a text file from one accessible VM guest filesystem. Output is bounded and secrets are redacted. Binary files are refused. Read-only; needs no approval.', input_schema: { type: 'object', properties: { vm_id: { type: 'integer', minimum: 1, description: 'Accessible VM identifier.' }, path: pathProperty('Guest file path to read.'), max_bytes: { type: 'integer', minimum: 1, maximum: MAX_READ_BYTES, description: 'Maximum bytes to return.' } }, required: ['vm_id', 'path'], additionalProperties: false } },
  { name: 'search_files', category: 'file_operations', risk: 'read_only', required_permission: 'vm_access', approval_required: false, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'Search file and directory names (not file contents) for a substring inside one guest directory listing. Content search across guest files is unsupported. Read-only; needs no approval.', input_schema: { type: 'object', properties: { vm_id: { type: 'integer', minimum: 1, description: 'Accessible VM identifier.' }, path: pathProperty('Guest directory path to search inside.'), query: { type: 'string', minLength: 1, maxLength: 100, description: 'Case-insensitive filename substring.' } }, required: ['vm_id', 'path', 'query'], additionalProperties: false } },
  { name: 'write_file', category: 'file_operations', risk: 'state_change', required_permission: 'vm_access', approval_required: true, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'Propose writing (creating or replacing) a text file on one accessible VM guest filesystem. This creates a pending approval; nothing is written until the authenticated user explicitly approves it.', input_schema: { type: 'object', properties: { vm_id: { type: 'integer', minimum: 1, description: 'Accessible VM identifier.' }, path: pathProperty('Guest file path to write.'), content: { type: 'string', minLength: 1, maxLength: MAX_WRITE_BYTES, description: 'Exact text content to write.' } }, required: ['vm_id', 'path', 'content'], additionalProperties: false } },
  { name: 'create_directory', category: 'file_operations', risk: 'state_change', required_permission: 'vm_access', approval_required: true, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'Propose creating a directory on one accessible VM guest filesystem. This creates a pending approval; nothing is created until the authenticated user explicitly approves it.', input_schema: { type: 'object', properties: { vm_id: { type: 'integer', minimum: 1, description: 'Accessible VM identifier.' }, path: pathProperty('Guest directory path to create.') }, required: ['vm_id', 'path'], additionalProperties: false } },
  { name: 'rename_file', category: 'file_operations', risk: 'state_change', required_permission: 'vm_access', approval_required: true, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'Propose renaming or moving a file on one accessible VM guest filesystem. This creates a pending approval; nothing changes until the authenticated user explicitly approves it.', input_schema: { type: 'object', properties: { vm_id: { type: 'integer', minimum: 1, description: 'Accessible VM identifier.' }, path: pathProperty('Current guest path.'), destination: pathProperty('New guest path.') }, required: ['vm_id', 'path', 'destination'], additionalProperties: false } },
  { name: 'delete_file', category: 'file_operations', risk: 'disruptive', required_permission: 'vm_access', approval_required: true, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'Propose deleting a file or directory on one accessible VM guest filesystem. Deletion is permanent and cannot be undone. This creates a pending approval; nothing is deleted until the authenticated user explicitly approves it.', input_schema: { type: 'object', properties: { vm_id: { type: 'integer', minimum: 1, description: 'Accessible VM identifier.' }, path: pathProperty('Guest path to delete.'), recursive: { type: 'boolean', description: 'Required true to delete a directory and its contents.' } }, required: ['vm_id', 'path'], additionalProperties: false } },
];
const FILE_DEFINITIONS_BY_NAME = new Map(FILE_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
const FILE_OPERATIONS = new Set(FILE_TOOL_DEFINITIONS.map((tool) => tool.name));

function fileToolError(category, message) {
  return Object.assign(new Error(message), { category });
}




function sanitizeGuestPath(raw) {
  if (typeof raw !== 'string') throw fileToolError('invalid_tool_arguments', 'The tool request contained an invalid path.');
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_PATH_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw fileToolError('invalid_tool_arguments', 'The tool request contained an invalid path.');
  }
  const posix = trimmed.replace(/\\/g, '/');
  const normalized = path.posix.normalize(posix.startsWith('/') ? posix : `/${posix}`);
  if (normalized === '/..' || normalized.startsWith('/../')) {
    throw fileToolError('invalid_tool_arguments', 'The requested path escapes the accessible directory.');
  }
  if (normalized === '/' || normalized === '/.') return '/';
  return normalized;
}

function validateFileArguments(name, input) {
  const definition = FILE_DEFINITIONS_BY_NAME.get(name);
  if (!definition) throw fileToolError('unknown_tool', 'This assistant tool is unavailable.');
  const args = input == null ? {} : input;
  if (typeof args !== 'object' || Array.isArray(args)) throw fileToolError('invalid_tool_arguments', 'The tool request contained invalid arguments.');
  const properties = definition.input_schema.properties;
  if (Object.keys(args).some((key) => !Object.hasOwn(properties, key))) throw fileToolError('invalid_tool_arguments', 'The tool request contained invalid arguments.');
  for (const key of definition.input_schema.required || []) {
    if (!Object.hasOwn(args, key)) throw fileToolError('invalid_tool_arguments', 'The tool request was missing a required argument.');
  }
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key];
    if (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < (rule.minimum || 0) || value > (rule.maximum || Number.MAX_SAFE_INTEGER))) {
      throw fileToolError('invalid_tool_arguments', 'The tool request contained an invalid number.');
    }
    if (rule.type === 'string' && (typeof value !== 'string' || value.trim().length < (rule.minLength || 0) || value.length > (rule.maxLength || 1000) || /[\u0000-\u001f]/.test(value))) {
      throw fileToolError('invalid_tool_arguments', 'The tool request contained invalid text.');
    }
    if (rule.type === 'boolean' && typeof value !== 'boolean') throw fileToolError('invalid_tool_arguments', 'The tool request contained an invalid flag.');
  }
  return args;
}

function defaultFilePermissions() {
  return Object.fromEntries(FILE_TOOL_DEFINITIONS.map((tool) => [tool.name, tool.risk === 'read_only']));
}

function timed(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(fileToolError('tool_timeout', 'File inspection timed out. Try again later.')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function safeName(value, max = 160) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}



function redactFileText(redactVmLog, value) {
  return redactVmLog(String(value ?? ''));
}

function summarizeEntries(entries) {
  const rows = (Array.isArray(entries) ? entries : []).slice(0, MAX_LIST_ENTRIES).map((entry) => ({
    name: safeName(entry?.name ?? entry?.path ?? ''),
    type: entry?.type || (entry?.is_dir ? 'dir' : 'file'),
    size_bytes: Number.isFinite(Number(entry?.size)) ? Number(entry.size) : null,
  })).filter((row) => row.name);
  return { entries: rows, truncated: Array.isArray(entries) && entries.length > MAX_LIST_ENTRIES };
}

function createFileToolRunner({ agentService, vmService, collections, getPermissions, auditStart, auditFinish, proposeFileOperation, redactSecrets, onAuditFailure = () => {}, now = () => new Date() }) {
  if (!agentService || !vmService || !collections || typeof getPermissions !== 'function' || typeof auditStart !== 'function' || typeof auditFinish !== 'function' || typeof proposeFileOperation !== 'function' || typeof redactSecrets !== 'function') {
    throw new TypeError('File tool dependencies are required.');
  }

  async function getAuthorizedVm(user, id) {
    let vm;
    try {
      vm = await vmService.getVm(Number(id));
      if (!vm || !(await vmService.canAccess(user, vm))) throw fileToolError('vm_access_denied', 'VM not found or access denied.');
      return vm;
    } catch (error) {
      if (error.category === 'vm_access_denied') throw error;
      throw fileToolError('vm_unavailable', 'VM information could not be retrieved.');
    }
  }

  async function guarded(operation, vm, fn) {
    try {
      return await fn();
    } catch (error) {
      if (error && error.category) throw error;
      throw fileToolError('file_operation_failed', `The file ${operation} did not complete. Check that the VM agent is reachable and the path exists.`);
    }
  }

  async function execute(user, name, args, onProgress, context) {
    const vm = await getAuthorizedVm(user, args.vm_id);
    const modifying = name === 'write_file' || name === 'create_directory' || name === 'rename_file' || name === 'delete_file';
    onProgress({ type: 'tool_running', name, target: vm.id, approval_required: modifying });
    if (modifying) {
      return proposeFileOperation({ user, vmId: vm.id, operation: name, parameters: args, conversationId: context?.conversationId, onProgress });
    }

    if (name === 'list_files') {
      const dir = sanitizeGuestPath(args.path);
      const entries = await guarded('listing', vm, () => agentService.listDir(vm, dir));
      return { vm_id: vm.id, path: dir, ...summarizeEntries(entries) };
    }

    if (name === 'read_file') {
      const file = sanitizeGuestPath(args.path);
      if (file === '/') throw fileToolError('invalid_tool_arguments', 'Reading a directory is not supported; list it instead.');
      const limit = args.max_bytes || MAX_READ_BYTES;
      const content = await guarded('read', vm, () => agentService.readFile(vm, file));
      const text = String(content ?? '');
      if (/[\u0000-\u0008\u000e-\u001f]/.test(text.slice(0, 4096))) throw fileToolError('file_not_readable', 'Binary files cannot be displayed. Download the file from the File Manager instead.');
      const slice = text.slice(0, limit);
      return { vm_id: vm.id, path: file, content: redactSecrets(slice), truncated: text.length > limit, bytes_returned: Buffer.byteLength(slice, 'utf8') };
    }

    if (name === 'search_files') {
      const dir = sanitizeGuestPath(args.path);
      const needle = String(args.query).toLocaleLowerCase();
      const entries = await guarded('listing', vm, () => agentService.listDir(vm, dir));
      const matches = (Array.isArray(entries) ? entries : [])
        .map((entry) => safeName(entry?.name ?? entry?.path ?? ''))
        .filter((entryName) => entryName.toLocaleLowerCase().includes(needle))
        .slice(0, 50);
      return { vm_id: vm.id, path: dir, query: String(args.query).slice(0, 100), matches, note: 'Filename search only; file contents are never searched by this tool.' };
    }

    throw fileToolError('unknown_tool', 'This assistant tool is unavailable.');
  }

  return async function runFileTool(user, name, input, onProgress = () => {}, context = {}) {
    const userId = Number(user?.id);
    if (!Number.isSafeInteger(userId) || userId < 1) throw fileToolError('not_authenticated', 'Authentication is required.');
    const known = FILE_DEFINITIONS_BY_NAME.has(name);
    const correlationId = crypto.randomUUID();
    const targetId = Number.isSafeInteger(input?.vm_id) ? Number(input.vm_id) : null;
    let permissions;
    try { permissions = await getPermissions(userId); }
    catch (_) { throw fileToolError('permissions_unavailable', 'Assistant permissions could not be verified.'); }
    const enabled = known && permissions?.[name] === true;
    const toolDefinition = known ? FILE_DEFINITIONS_BY_NAME.get(name) : null;
    const startedAt = now().toISOString();
    try { await auditStart({ id: correlationId, event: 'ai:tool_execution', user_id: userId, vm_id: targetId, timestamp: startedAt, payload: { tool_name: known ? name : 'unknown', tool_enabled: enabled, risk: toolDefinition?.risk || 'unknown', approval_required: toolDefinition?.approval_required === true, approval_status: toolDefinition?.approval_required ? 'awaiting_user' : 'not_required', correlation_id: correlationId, status: 'started' } }); }
    catch (_) { throw fileToolError('audit_unavailable', 'The tool could not run because its audit record could not be created.'); }

    const finish = async (status, category, details = {}) => {
      const finishedAt = now();
      try {
        await auditFinish(correlationId, {
          'payload.status': status,
          'payload.result_category': category,
          'payload.finished_at': finishedAt.toISOString(),
          'payload.elapsed_ms': Math.max(0, finishedAt.getTime() - Date.parse(startedAt)),
          ...details,
        });
      } catch (_) { onAuditFailure(correlationId); }
    };

    try {
      if (!known) throw fileToolError('unknown_tool', 'This assistant tool is unavailable.');
      if (!enabled) throw fileToolError('tool_disabled', 'This assistant tool is disabled in your AI settings.');
      const args = validateFileArguments(name, input);
      const definition = FILE_DEFINITIONS_BY_NAME.get(name);
      const result = await timed(execute(user, name, args, onProgress, context), definition.timeout_ms);
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > definition.max_output_bytes) throw fileToolError('tool_output_limit', 'File information exceeded the safe response size. Narrow the request and try again.');
      await finish(
        result?.approval_required ? 'approval_pending' : 'success',
        result?.approval_required ? 'approval_pending' : (result?.noop ? 'no_op' : 'success'),
        result?.approval_required ? { 'payload.approval_status': 'pending', 'payload.approval_id': result.approval_id } : {},
      );
      return result;
    } catch (error) {
      const safe = error.category ? error : fileToolError('tool_error', 'The requested file information is temporarily unavailable.');
      await finish(safe.category === 'tool_disabled' || safe.category === 'vm_access_denied' ? 'denied' : 'error', safe.category);
      throw safe;
    }
  };
}

module.exports = { FILE_TOOL_DEFINITIONS, FILE_OPERATIONS, createFileToolRunner, validateFileArguments, sanitizeGuestPath, defaultFilePermissions, redactFileText, MAX_READ_BYTES, MAX_WRITE_BYTES };
