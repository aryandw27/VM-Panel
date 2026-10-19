const crypto = require('crypto');










const TOOL_TIMEOUT_MS = 8000;
const MAX_OUTPUT_BYTES = 12 * 1024;

const OPS_TOOL_DEFINITIONS = [
  { name: 'list_schedules', category: 'operations', risk: 'read_only', required_permission: 'vm_access', approval_required: false, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'List scheduled jobs (start, stop, restart, backup) for VMs this account can access, with enablement and last-run/failure info. Read-only.', input_schema: { type: 'object', properties: { vm_id: { type: 'integer', minimum: 1, description: 'Optional accessible VM identifier to narrow the listing.' } }, required: [], additionalProperties: false } },
  { name: 'get_schedule', category: 'operations', risk: 'read_only', required_permission: 'vm_access', approval_required: false, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'Inspect one scheduled job: action, cron expression, enablement, last run, and last recorded failure. Read-only.', input_schema: { type: 'object', properties: { schedule_id: { type: 'integer', minimum: 1, description: 'Scheduled job identifier.' } }, required: ['schedule_id'], additionalProperties: false } },
  { name: 'list_incidents', category: 'operations', risk: 'read_only', required_permission: 'vm_access', approval_required: false, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'List incidents for resources this account owns, newest first. Supports status/severity filters. Read-only.', input_schema: { type: 'object', properties: { status: { type: 'string', minLength: 1, maxLength: 16, description: 'active, detected, investigating, recovering, acknowledged, or resolved.' }, severity: { type: 'string', minLength: 1, maxLength: 16, description: 'critical, high, medium, or low.' }, limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum incidents to return.' } }, required: [], additionalProperties: false } },
  { name: 'get_incident', category: 'operations', risk: 'read_only', required_permission: 'vm_access', approval_required: false, timeout_ms: TOOL_TIMEOUT_MS, max_output_bytes: MAX_OUTPUT_BYTES, description: 'Read one owned incident in full: category, severity, timeline, evidence summary, health, recovery attempts, and resolution. Read-only.', input_schema: { type: 'object', properties: { incident_id: { type: 'integer', minimum: 1, description: 'Incident identifier.' } }, required: ['incident_id'], additionalProperties: false } },
];
const OPS_DEFINITIONS_BY_NAME = new Map(OPS_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

function opsToolError(category, message) {
  return Object.assign(new Error(message), { category });
}

function validateOpsArguments(name, input) {
  const definition = OPS_DEFINITIONS_BY_NAME.get(name);
  if (!definition) throw opsToolError('unknown_tool', 'This assistant tool is unavailable.');
  const args = input == null ? {} : input;
  if (typeof args !== 'object' || Array.isArray(args)) throw opsToolError('invalid_tool_arguments', 'The tool request contained invalid arguments.');
  const properties = definition.input_schema.properties;
  if (Object.keys(args).some((key) => !Object.hasOwn(properties, key))) throw opsToolError('invalid_tool_arguments', 'The tool request contained invalid arguments.');
  for (const key of definition.input_schema.required || []) {
    if (!Object.hasOwn(args, key)) throw opsToolError('invalid_tool_arguments', 'The tool request was missing a required argument.');
  }
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key];
    if (rule.type === 'integer' && (!Number.isSafeInteger(value) || value < (rule.minimum || 0) || value > (rule.maximum || Number.MAX_SAFE_INTEGER))) {
      throw opsToolError('invalid_tool_arguments', 'The tool request contained an invalid number.');
    }
    if (rule.type === 'string' && (typeof value !== 'string' || value.trim().length < (rule.minLength || 0) || value.length > (rule.maxLength || 1000) || /[\u0000-\u001f]/.test(value))) {
      throw opsToolError('invalid_tool_arguments', 'The tool request contained invalid text.');
    }
  }
  return args;
}

function defaultOpsPermissions() {
  return Object.fromEntries(OPS_TOOL_DEFINITIONS.map((tool) => [tool.name, true]));
}

function timed(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(opsToolError('tool_timeout', 'Operation lookup timed out. Try again later.')), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function safeText(value, max = 160) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function redactEvidence(value) {
  return String(value ?? '')
    .replace(/(authorization|password|passwd|secret|token|api[_-]?key|client[_-]?secret)("?\s*[:=]\s*"?)(?:bearer\s+)?([^\s,;"]+)/gi, '$1$2[REDACTED]')
    .replace(/\bbearer\s+[a-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/gi, '[REDACTED JWT]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
}

function createOpsToolRunner({ vmService, collections, incidentService, getPermissions, auditStart, auditFinish, onAuditFailure = () => {}, now = () => new Date() }) {
  if (!vmService || !collections || !incidentService || typeof getPermissions !== 'function' || typeof auditStart !== 'function' || typeof auditFinish !== 'function') {
    throw new TypeError('Operations tool dependencies are required.');
  }

  async function ownedVmIds(user) {
    const [owned, shares] = await Promise.all([
      collections.vms.find({ owner_id: Number(user.id) }).project({ id: 1 }).limit(200).toArray().catch(() => { throw opsToolError('vm_unavailable', 'VM information could not be retrieved.'); }),
      collections.subusers.find({ user_id: Number(user.id) }).project({ vm_id: 1 }).limit(200).toArray().catch(() => []),
    ]);
    return new Set([...owned.map((r) => Number(r.id)), ...shares.map((s) => Number(s.vm_id))].filter((id) => Number.isSafeInteger(id) && id > 0));
  }

  async function execute(user, name, args, onProgress) {
    onProgress({ type: 'tool_running', name, target: null, approval_required: false });

    if (name === 'list_schedules' || name === 'get_schedule') {
      const ids = await ownedVmIds(user);
      if (name === 'list_schedules') {
        const filter = {};
        if (args.vm_id) {
          if (!ids.has(Number(args.vm_id))) throw opsToolError('vm_access_denied', 'VM not found or access denied.');
          filter.vm_id = Number(args.vm_id);
        } else if (ids.size) {
          filter.vm_id = { $in: [...ids] };
        } else {
          return { schedules: [] };
        }
        const rows = await collections.schedules.find(filter).sort({ id: -1 }).limit(50).toArray().catch(() => { throw opsToolError('schedules_unavailable', 'Scheduled jobs are unavailable.'); });
        return {
          schedules: rows.map((row) => ({
            id: row.id, vm_id: row.vm_id, name: safeText(row.name, 100), action: safeText(row.action, 24),
            enabled: Boolean(row.enabled), cron: safeText(row.cron, 40),
            last_run_at: row.last_run_at || null, last_error_at: row.last_error_at || null,
            last_error: row.last_error ? safeText(redactEvidence(row.last_error), 200) : null,
            consecutive_failures: Number.isFinite(Number(row.consecutive_failures)) ? Number(row.consecutive_failures) : 0,
          })),
        };
      }
      const row = await collections.schedules.findOne({ id: Number(args.schedule_id) }).catch(() => { throw opsToolError('schedules_unavailable', 'Scheduled jobs are unavailable.'); });
      if (!row || !ids.has(Number(row.vm_id))) throw opsToolError('schedule_not_found', 'Scheduled job not found.');
      return {
        id: row.id, vm_id: row.vm_id, name: safeText(row.name, 100), action: safeText(row.action, 24),
        enabled: Boolean(row.enabled), cron: safeText(row.cron, 40),
        last_run_at: row.last_run_at || null, last_error_at: row.last_error_at || null,
        last_error: row.last_error ? safeText(redactEvidence(row.last_error), 300) : null,
        consecutive_failures: Number.isFinite(Number(row.consecutive_failures)) ? Number(row.consecutive_failures) : 0,
      };
    }

    if (name === 'list_incidents' || name === 'get_incident') {
      try {
        if (name === 'list_incidents') {
          const { incidents, total } = await incidentService.listIncidents(user, { status: args.status, severity: args.severity, limit: args.limit || 20 });
          return { incidents: incidents.map(publicIncident), total };
        }
        return publicIncident(await incidentService.getIncident(user, args.incident_id));
      } catch (error) {
        if (error.category) throw error;
        throw opsToolError('incidents_unavailable', 'Incident history is unavailable.');
      }
    }

    throw opsToolError('unknown_tool', 'This assistant tool is unavailable.');
  }

  function publicIncident(row) {
    if (!row) return null;
    return {
      id: row.id, resource_type: row.resource_type, resource_id: row.resource_id,
      resource_name: safeText(row.resource_name, 120), category: row.category, severity: row.severity,
      status: row.status, source: row.source, exit_code: row.exit_code ?? null,
      health: row.health || null, occurrence_count: row.occurrence_count || 1,
      evidence: row.evidence ? safeText(redactEvidence(JSON.stringify(row.evidence)), 2000) : null,
      recovery_attempts: (Array.isArray(row.recovery_attempts) ? row.recovery_attempts : []).slice(-10).map((a) => ({ at: a.at || null, action: safeText(a.action, 120), outcome: safeText(a.outcome, 32) })),
      first_detected_at: row.first_detected_at || null, last_observed_at: row.last_observed_at || null,
      resolved_at: row.resolved_at || null, resolution_summary: row.resolution_summary ? safeText(row.resolution_summary, 300) : null,
    };
  }

  return async function runOpsTool(user, name, input, onProgress = () => {}, context = {}) {
    const userId = Number(user?.id);
    if (!Number.isSafeInteger(userId) || userId < 1) throw opsToolError('not_authenticated', 'Authentication is required.');
    const known = OPS_DEFINITIONS_BY_NAME.has(name);
    const correlationId = crypto.randomUUID();
    let permissions;
    try { permissions = await getPermissions(userId); }
    catch (_) { throw opsToolError('permissions_unavailable', 'Assistant permissions could not be verified.'); }
    const enabled = known && permissions?.[name] === true;
    const startedAt = now().toISOString();
    try { await auditStart({ id: correlationId, event: 'ai:tool_execution', user_id: userId, vm_id: null, timestamp: startedAt, payload: { tool_name: known ? name : 'unknown', tool_enabled: enabled, risk: 'read_only', approval_required: false, approval_status: 'not_required', correlation_id: correlationId, status: 'started' } }); }
    catch (_) { throw opsToolError('audit_unavailable', 'The tool could not run because its audit record could not be created.'); }
    const finish = async (status, category) => {
      try { await auditFinish(correlationId, { 'payload.status': status, 'payload.result_category': category, 'payload.finished_at': now().toISOString() }); }
      catch (_) { onAuditFailure(correlationId); }
    };
    try {
      if (!known) throw opsToolError('unknown_tool', 'This assistant tool is unavailable.');
      if (!enabled) throw opsToolError('tool_disabled', 'This assistant tool is disabled in your AI settings.');
      const args = validateOpsArguments(name, input);
      const result = await timed(execute(user, name, args, onProgress), OPS_DEFINITIONS_BY_NAME.get(name).timeout_ms);
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > OPS_DEFINITIONS_BY_NAME.get(name).max_output_bytes) throw opsToolError('tool_output_limit', 'Operation information exceeded the safe response size. Narrow the request and try again.');
      await finish('success', 'success');
      return result;
    } catch (error) {
      const safe = error.category ? error : opsToolError('tool_error', 'The requested information is temporarily unavailable.');
      await finish(safe.category === 'tool_disabled' ? 'denied' : 'error', safe.category);
      throw safe;
    }
  };
}

module.exports = { OPS_TOOL_DEFINITIONS, createOpsToolRunner, validateOpsArguments, defaultOpsPermissions };
