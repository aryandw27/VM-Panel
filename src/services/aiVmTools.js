const crypto = require('crypto');
const fsDefault = require('fs');
const path = require('path');

const MAX_LOG_BYTES = 12 * 1024;
const MAX_OUTPUT_BYTES = 12 * 1024;
const TOOL_TIMEOUT_MS = 8000;
const LOG_CONTEXT_LINES = 2;

const idProperty = () => ({ type: 'integer', minimum: 1, description: 'Accessible VM identifier.' });
const TOOL_DEFINITIONS = [
  { name: 'list_deployments', category: 'vm_inspection', risk: 'read_only', required_permission: 'vm_access', approval_required: false, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'List up to 50 virtual machines this account can access. Returns only basic VM metadata.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'inspect_deployment', category: 'vm_inspection', risk: 'read_only', required_permission: 'vm_access', approval_required: false, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'Inspect one accessible QEMU VM: configured image metadata, current process state, CPU and memory allocation, host-observed process metrics, disk image length, and available health signals. Guest OS and guest filesystem usage are not verified.', input_schema: { type: 'object', properties: { deployment_id: idProperty('deployment_id') }, required: ['deployment_id'], additionalProperties: false } },
  { name: 'read_deployment_logs', category: 'vm_inspection', risk: 'read_only', required_permission: 'vm_access', approval_required: false, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'Read a bounded, redacted tail of boot and QEMU logs for one accessible VM. Optionally filter the tail by a literal search term.', input_schema: { type: 'object', properties: { deployment_id: idProperty('deployment_id'), lines: { type: 'integer', minimum: 1, maximum: 100 }, query: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['deployment_id'], additionalProperties: false } },
  { name: 'get_vm_stats', category: 'vm_inspection', risk: 'read_only', required_permission: 'vm_access', approval_required: false, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'Get current host-observed QEMU process metrics and configured VM allocations. CPU is the host process average, memory is host QEMU RSS, and neither is guest utilization. Guest disk usage and network counters are unavailable.', input_schema: { type: 'object', properties: { vm_id: idProperty('vm_id') }, required: ['vm_id'], additionalProperties: false } },
  { name: 'search_vm_logs', category: 'vm_inspection', risk: 'read_only', required_permission: 'vm_access', approval_required: false, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'Search only the bounded recent boot and QEMU log tails for a literal term; returns matching lines and up to two surrounding lines with secrets redacted.', input_schema: { type: 'object', properties: { vm_id: idProperty('vm_id'), query: { type: 'string', minLength: 1, maxLength: 100 }, context_lines: { type: 'integer', minimum: 0, maximum: 3 } }, required: ['vm_id', 'query'], additionalProperties: false } },
  { name: 'inspect_vm_config', category: 'vm_inspection', risk: 'read_only', required_permission: 'vm_access', approval_required: false, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'Read sanitized configured VM resources, selected OS image metadata, boot order, virtual disk capacity, QEMU user-mode networking, and configured port forwards. Never returns host paths, passwords, agent tokens, or raw QEMU arguments.', input_schema: { type: 'object', properties: { vm_id: idProperty('vm_id') }, required: ['vm_id'], additionalProperties: false } },
  { name: 'get_vm_events', category: 'vm_inspection', risk: 'read_only', required_permission: 'vm_access', approval_required: false, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'Read up to 50 recorded lifecycle and backup event names and timestamps for one accessible VM. Sensitive event details and actor data are omitted.', input_schema: { type: 'object', properties: { vm_id: idProperty('vm_id'), limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['vm_id'], additionalProperties: false } },
  { name: 'list_vm_backups', category: 'recovery_inventory', risk: 'read_only', required_permission: 'vm_access', approval_required: false, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'List up to 20 existing backup records for one accessible VM. This only inventories backups; it does not create or restore one.', input_schema: { type: 'object', properties: { vm_id: idProperty('vm_id') }, required: ['vm_id'], additionalProperties: false } },
  { name: 'start_vm', category: 'vm_lifecycle', risk: 'state_change', required_permission: 'vm_access', approval_required: true, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'Propose starting one accessible stopped VM. This creates a pending approval; it never starts the VM until the authenticated user explicitly approves it.', input_schema: { type: 'object', properties: { vm_id: idProperty('vm_id') }, required: ['vm_id'], additionalProperties: false } },
  { name: 'stop_vm', category: 'vm_lifecycle', risk: 'disruptive', required_permission: 'vm_access', approval_required: true, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'Propose stopping one accessible running VM. Stopping can interrupt applications and unsaved work. Requires explicit user approval.', input_schema: { type: 'object', properties: { vm_id: idProperty('vm_id') }, required: ['vm_id'], additionalProperties: false } },
  { name: 'restart_vm', category: 'vm_lifecycle', risk: 'disruptive', required_permission: 'vm_access', approval_required: true, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'Propose restarting one accessible running VM. Restarting interrupts applications and unsaved work. Requires explicit user approval.', input_schema: { type: 'object', properties: { vm_id: idProperty('vm_id') }, required: ['vm_id'], additionalProperties: false } },
];
const DEFINITIONS_BY_NAME = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
const ALLOWED_EVENTS = new Set(['vm:create', 'vm:start', 'vm:stop', 'vm:kill', 'vm:update', 'vm:resize', 'vm:transfer_owner', 'vm:delete', 'backup:create', 'backup:restore', 'backup:delete']);

function defaultToolPermissions() {
  return Object.fromEntries(TOOL_DEFINITIONS.map((tool) => [tool.name, !['state_change', 'disruptive'].includes(tool.risk)]));
}

function toolError(category, message) {
  return Object.assign(new Error(message), { category });
}

function validateArguments(name, input) {
  const definition = DEFINITIONS_BY_NAME.get(name);
  if (!definition) throw toolError('unknown_tool', 'This assistant tool is unavailable.');
  const args = input == null ? {} : input;
  if (typeof args !== 'object' || Array.isArray(args)) throw toolError('invalid_tool_arguments', 'The tool request contained invalid arguments.');
  const properties = definition.input_schema.properties;
  if (Object.keys(args).some((key) => !Object.hasOwn(properties, key))) throw toolError('invalid_tool_arguments', 'The tool request contained invalid arguments.');
  for (const key of definition.input_schema.required || []) {
    if (!Object.hasOwn(args, key)) throw toolError('invalid_tool_arguments', 'The tool request was missing a required argument.');
  }
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key];
    if (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < (rule.minimum || 0) || value > (rule.maximum || Number.MAX_SAFE_INTEGER))) {
      throw toolError('invalid_tool_arguments', 'The tool request contained an invalid number.');
    }
    if (rule.type === 'string' && (typeof value !== 'string' || value.trim().length < (rule.minLength || 0) || value.length > (rule.maxLength || 1000) || /[\u0000-\u001f]/.test(value))) {
      throw toolError('invalid_tool_arguments', 'The tool request contained an invalid search term.');
    }
  }
  return args;
}

function requestedVmId(name, args) {
  const raw = name === 'inspect_deployment' || name === 'read_deployment_logs' ? args?.deployment_id : args?.vm_id;
  return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
}

function stripAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function redactVmLog(value, { redactHostPaths = false, paths = [] } = {}) {
  let output = stripAnsi(value)
    
    .replace(/(authorization|password|passwd|secret|token|api[_-]?key|client[_-]?secret)("?\s*[:=]\s*"?)(?:bearer\s+)?([^\s,;"]+)/gi, '$1$2[REDACTED]')
    .replace(/\bbearer\s+[a-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/gi, '[REDACTED JWT]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  for (const hostPath of paths.filter((item) => typeof item === 'string' && item.length > 1)) {
    output = output.split(hostPath).join('[REDACTED HOST PATH]');
  }
  if (redactHostPaths) {
    output = output.replace(/(?:\/(?:home|root|tmp|srv|opt|mnt|run|dev)\/[^\s"'<>;,]+|\/var\/lib\/[^\s"'<>;,]+)/g, '[REDACTED HOST PATH]');
  }
  return output;
}

function timed(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(toolError('tool_timeout', 'VM inspection timed out. Try again later.')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function safeText(value, max = 120) {
  return stripAnsi(value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function buildSearch(lines, query, contextLines = LOG_CONTEXT_LINES) {
  const needle = query.toLocaleLowerCase();
  const selected = [];
  let totalMatches = 0;
  for (const group of lines) {
    const hits = [];
    group.lines.forEach((line, index) => {
      if (line.text.toLocaleLowerCase().includes(needle)) hits.push(index);
    });
    totalMatches += hits.length;
    const windows = [];
    for (const index of hits.slice(0, 20)) {
      const start = Math.max(0, index - contextLines);
      const end = Math.min(group.lines.length - 1, index + contextLines);
      const previous = windows[windows.length - 1];
      if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
      else windows.push({ start, end });
    }
    for (const window of windows) {
      const excerptLines = group.lines.slice(window.start, window.end + 1).map((line, offset) => ({
        line_number: window.start + offset + 1,
        matched: line.text.toLocaleLowerCase().includes(needle),
        text: line.text.slice(0, 600),
        truncated: line.text.length > 600,
      }));
      selected.push({ source: group.source, lines: excerptLines });
    }
  }
  let result = { match_count: totalMatches, snippets: selected, truncated: totalMatches > 20 };
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > 9500 && result.snippets.length) {
    result.snippets.pop();
    result.truncated = true;
  }
  return result;
}

function createVmToolRunner({ vmService, collections, vmRoot, getPermissions, auditStart, auditFinish, proposeLifecycle, onAuditFailure = () => {}, fs = fsDefault, now = () => new Date() }) {
  if (!vmService || !collections || !vmRoot || typeof getPermissions !== 'function' || typeof auditStart !== 'function' || typeof auditFinish !== 'function') {
    throw new TypeError('VM tool dependencies are required.');
  }

  async function getAuthorizedVm(user, id) {
    let vm;
    try {
      vm = await vmService.getVm(id);
      if (!vm || !(await vmService.canAccess(user, vm))) throw toolError('vm_access_denied', 'VM not found or access denied.');
      return vm;
    } catch (error) {
      if (error.category === 'vm_access_denied') throw error;
      throw toolError('vm_unavailable', 'VM information could not be retrieved.');
    }
  }

  async function readRecentLogs(vm) {
    const root = path.resolve(vmRoot);
    const directory = path.resolve(root, String(vm.id));
    if (!directory.startsWith(root + path.sep)) throw toolError('log_access_denied', 'VM logs failed a safety check.');
    let realRoot;
    let directoryInfo;
    let realDirectory;
    try {
      [realRoot, directoryInfo, realDirectory] = await Promise.all([
        fs.promises.realpath(root), fs.promises.lstat(directory), fs.promises.realpath(directory),
      ]);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw toolError('log_unavailable', 'VM logs are unavailable.');
    }
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || !realDirectory.startsWith(realRoot + path.sep)) {
      throw toolError('log_access_denied', 'VM logs failed a safety check.');
    }
    const groups = [];
    const perFileBytes = Math.floor(MAX_LOG_BYTES / 2);
    for (const source of ['boot.log', 'qemu.log']) {
      let handle;
      try {
        const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
        handle = await fs.promises.open(path.join(realDirectory, source), flags);
        const stat = await handle.stat();
        if (!stat.isFile()) continue;
        const length = Math.min(stat.size, perFileBytes);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = length ? await handle.read(buffer, 0, length, Math.max(0, stat.size - length)) : { bytesRead: 0 };
        const text = redactVmLog(buffer.subarray(0, bytesRead).toString('utf8'), {
          redactHostPaths: source === 'qemu.log',
          paths: [root, directory, realRoot, realDirectory],
        });
        groups.push({ source, lines: text.split(/\r?\n/).map((line) => ({ text: line })) });
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        if (error.code === 'ELOOP') throw toolError('log_access_denied', 'VM logs failed a safety check.');
        throw toolError('log_unavailable', 'VM logs are unavailable.');
      } finally {
        if (handle) await handle.close().catch(() => {});
      }
    }
    return groups;
  }

  async function execute(user, name, args, onProgress, context) {
    if (name === 'list_deployments') {
      onProgress({ type: 'tool_running', name, target: null, approval_required: false });
      let owned;
      let shares;
      try {
        [owned, shares] = await Promise.all([
          collections.vms.find({ owner_id: Number(user.id) }).sort({ id: -1 }).limit(50).toArray(),
          collections.subusers.find({ user_id: Number(user.id) }).limit(50).toArray(),
        ]);
      } catch (_) { throw toolError('vm_unavailable', 'VM information could not be retrieved.'); }
      const ids = [...new Set(shares.map((item) => Number(item.vm_id)))].filter((id) => Number.isSafeInteger(id) && id > 0);
      let shared = [];
      if (ids.length) {
        try { shared = await collections.vms.find({ id: { $in: ids } }).limit(50).toArray(); }
        catch (_) { throw toolError('vm_unavailable', 'VM information could not be retrieved.'); }
      }
      const available = [...owned, ...shared];
      const result = [];
      const used = new Set();
      for (const row of available) {
        if (used.has(Number(row.id)) || !(await vmService.canAccess(user, row))) continue;
        used.add(Number(row.id));
        const vm = vmService.serializeVm(row);
        result.push({ id: vm.id, name: safeText(vm.name), status: vm.status, vcpus: finite(vm.cpus, 0), configured_memory_mb: finite(vm.memory, 0) });
        if (result.length >= 50) break;
      }
      return { vms: result, truncated: result.length === 50 };
    }

    const vmId = requestedVmId(name, args);
    const vm = await getAuthorizedVm(user, vmId);
    const lifecycle = name === 'start_vm' || name === 'stop_vm' || name === 'restart_vm';
    if (lifecycle && !(await vmService.canAccess(user, vm, '*'))) throw toolError('vm_access_denied', 'VM lifecycle access denied. Full VM access is required for state changes.');
    onProgress({ type: 'tool_running', name, target: vm.id, approval_required: lifecycle });
    if (lifecycle) {
      if (typeof proposeLifecycle !== 'function') throw toolError('approval_unavailable', 'VM lifecycle actions are unavailable until approval controls are configured.');
      return proposeLifecycle({ user, vmId: vm.id, operation: name, conversationId: context?.conversationId, onProgress });
    }
    const sampledAt = now().toISOString();

    if (name === 'inspect_deployment' || name === 'get_vm_stats') {
      let raw;
      try { raw = vmService.liveStats(vm); }
      catch (_) { throw toolError('stats_unavailable', 'VM process metrics are unavailable.'); }
      const stats = {
        sampled_at: raw.updated_at || sampledAt,
        sample_source: 'panel host process inspection; not guest telemetry',
        process_running: Boolean(raw.running),
        process_uptime_seconds: raw.running ? finite(raw.uptime, null) : null,
        cpu: { host_process_average_percent: raw.running ? finite(raw.cpu?.percent, null) : null, configured_vcpus: finite(vm.cpus, 0), guest_utilization_available: false, unit: 'percent (host process average)' },
        memory: { qemu_host_rss_bytes: raw.running ? finite(raw.memory?.used_bytes, null) : null, configured_guest_memory_mb: finite(vm.memory, 0), guest_memory_usage_available: false, unit: 'bytes / MiB' },
        disk: { configured_capacity: safeText(vm.disk_size || '', 24) || null, qemu_image_file_length_bytes: finite(raw.disk?.actual_bytes, null), guest_filesystem_usage_available: false, unit: 'bytes' },
        network_counters_available: false,
      };
      if (name === 'get_vm_stats') return stats;
      const osType = safeText(vm.os_type || '', 40);
      const codename = safeText(vm.codename || '', 40);
      return {
        id: vm.id,
        name: safeText(vm.name),
        status: vm.status,
        availability: raw.running ? 'qemu_process_running' : (vm.suspended ? 'suspended' : 'qemu_process_stopped'),
        configured_os_image: [osType, codename].filter(Boolean).join(' · ') || 'not recorded',
        guest_os_verified: false,
        configured_resources: { vcpus: stats.cpu.configured_vcpus, memory_mb: stats.memory.configured_guest_memory_mb, disk_capacity: stats.disk.configured_capacity },
        observed_metrics: stats,
        health: { qemu_process: raw.running ? 'running' : 'not running', guest_agent_health: 'unavailable; no diagnostics-only endpoint', guest_health: 'not verified' },
        created_at: vm.created_at || null,
      };
    }

    if (name === 'inspect_vm_config') {
      const forwards = Array.isArray(vm.port_forwards) ? vm.port_forwards.slice(0, 20).map((entry) => ({ host_port: finite(entry.host), guest_port: finite(entry.guest) })).filter((entry) => entry.host_port && entry.guest_port) : [];
      return {
        vm_id: vm.id,
        name: safeText(vm.name),
        configured_os_image: [safeText(vm.os_type || '', 40), safeText(vm.codename || '', 40)].filter(Boolean).join(' · ') || 'not recorded',
        guest_os_verified: false,
        cpu: { vcpus: finite(vm.cpus, 0) },
        memory: { configured_mb: finite(vm.memory, 0) },
        disks: [{ device: 'virtio', format: 'qcow2', configured_capacity: safeText(vm.disk_size || '', 24) || null }],
        boot: { order: 'disk first' },
        network: { mode: 'QEMU user-mode NAT', ssh_host_port: finite(vm.ssh_port), port_forwards: forwards },
        gui_mode_enabled: Boolean(vm.gui_mode),
      };
    }

    if (name === 'read_deployment_logs' || name === 'search_vm_logs') {
      let groups;
      try { groups = await readRecentLogs(vm); }
      catch (error) { throw error; }
      const all = groups.flatMap((group) => group.lines.map((line, index) => ({ source: group.source, text: line.text, line_number: index + 1 })));
      if (name === 'search_vm_logs' || args.query) {
        const query = args.query.trim();
        const contextLines = name === 'search_vm_logs' ? (args.context_lines ?? LOG_CONTEXT_LINES) : 0;
        return { vm_id: vm.id, available: groups.length > 0, ...buildSearch(groups, query, contextLines) };
      }
      const count = name === 'read_deployment_logs' ? (args.lines || 60) : 60;
      const excerpt = all.slice(-count).map((line) => ({ source: line.source, line_number: line.line_number, text: line.text.slice(0, 1000), truncated: line.text.length > 1000 }));
      return { vm_id: vm.id, available: groups.length > 0, lines_returned: excerpt.length, excerpt };
    }

    if (name === 'get_vm_events') {
      let rows;
      try { rows = await collections.activity_logs.find({ vm_id: Number(vm.id) }).sort({ id: -1 }).limit(100).toArray(); }
      catch (_) { throw toolError('events_unavailable', 'VM event history is unavailable.'); }
      const limit = args.limit || 50;
      const events = rows.filter((row) => ALLOWED_EVENTS.has(row.event)).slice(0, limit).map((row) => ({ event: safeText(row.event, 40), timestamp: row.created_at || null }));
      return { vm_id: vm.id, events, truncated: events.length === limit };
    }

    if (name === 'list_vm_backups') {
      let rows;
      try { rows = await collections.backups.find({ vm_id: Number(vm.id) }).sort({ id: -1 }).limit(20).toArray(); }
      catch (_) { throw toolError('backups_unavailable', 'VM backup inventory is unavailable.'); }
      return {
        vm_id: vm.id,
        backups: rows.map((row) => ({ id: finite(row.id), name: safeText(row.name, 100), size_bytes: Math.max(0, finite(row.size, 0)), kind: safeText(row.kind, 24), created_at: row.created_at || null })),
        note: 'Inventory only; the assistant did not create or restore a backup.',
      };
    }

    throw toolError('unknown_tool', 'This assistant tool is unavailable.');
  }

  return async function runVmTool(user, name, input, onProgress = () => {}, context = {}) {
    const userId = Number(user?.id);
    if (!Number.isSafeInteger(userId) || userId < 1) throw toolError('not_authenticated', 'Authentication is required.');
    const known = DEFINITIONS_BY_NAME.has(name);
    const correlationId = crypto.randomUUID();
    const targetId = requestedVmId(name, input);
    let permissions;
    try { permissions = await getPermissions(userId); }
    catch (_) { throw toolError('permissions_unavailable', 'Assistant permissions could not be verified.'); }
    const enabled = known && permissions?.[name] === true;
    const toolDefinition = known ? DEFINITIONS_BY_NAME.get(name) : null;
    const startedAt = now().toISOString();
    const auditRecord = {
      id: correlationId,
      event: 'ai:tool_execution',
      user_id: userId,
      vm_id: targetId,
      timestamp: startedAt,
      payload: {
        tool_name: known ? name : 'unknown',
        tool_enabled: enabled,
        risk: toolDefinition?.risk || 'unknown',
        approval_required: toolDefinition?.approval_required === true,
        approval_status: toolDefinition?.approval_required ? 'awaiting_user' : 'not_required',
        correlation_id: correlationId,
        status: 'started',
      },
    };
    try { await auditStart(auditRecord); }
    catch (_) { throw toolError('audit_unavailable', 'The tool could not run because its audit record could not be created.'); }

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
      if (!known) throw toolError('unknown_tool', 'This assistant tool is unavailable.');
      if (!enabled) throw toolError('tool_disabled', 'This assistant tool is disabled in your AI settings.');
      const args = validateArguments(name, input);
      const definition = DEFINITIONS_BY_NAME.get(name);
      const result = await timed(execute(user, name, args, onProgress, context), definition.timeout_ms);
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > definition.max_output_bytes) throw toolError('tool_output_limit', 'VM information exceeded the safe response size. Narrow the request and try again.');
      await finish(
        result?.approval_required ? 'approval_pending' : 'success',
        result?.approval_required ? 'approval_pending' : (result?.noop ? 'no_op' : 'success'),
        result?.approval_required ? { 'payload.approval_status': 'pending', 'payload.approval_id': result.approval_id } : {},
      );
      return result;
    } catch (error) {
      const safe = error.category ? error : toolError('tool_error', 'The requested VM information is temporarily unavailable.');
      await finish(safe.category === 'tool_disabled' || safe.category === 'vm_access_denied' ? 'denied' : 'error', safe.category);
      throw safe;
    }
  };
}

module.exports = { TOOL_DEFINITIONS, defaultToolPermissions, createVmToolRunner, validateArguments, redactVmLog, buildSearch, MAX_LOG_BYTES, MAX_OUTPUT_BYTES };
