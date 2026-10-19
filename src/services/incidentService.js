const crypto = require('crypto');











const STATUSES = ['detected', 'investigating', 'recovering', 'resolved', 'acknowledged'];
const OPEN_STATUSES = ['detected', 'investigating', 'recovering', 'acknowledged'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const MAX_ATTEMPTS = 50;
const MAX_EVIDENCE_BYTES = 4096;

function incidentError(category, message) {
  return Object.assign(new Error(message), { category });
}

function safeText(value, max = 500) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function trimEvidence(evidence) {
  if (evidence == null || typeof evidence !== 'object') return null;
  const json = JSON.stringify(evidence);
  if (Buffer.byteLength(json, 'utf8') <= MAX_EVIDENCE_BYTES) return JSON.parse(json);
  return { truncated: true, summary: safeText(evidence.summary || evidence.message || '', 500) };
}







function classifyVmState({ vmId, actualRunning, dbStatus, lastOp }) {
  const op = lastOp && typeof lastOp === 'object' ? lastOp : null;
  const recentMs = op && op.updated_at ? Date.now() - Date.parse(op.updated_at) : Infinity;
  const recentWindowMs = 15 * 60 * 1000;
  const planned = op && op.actor_id != null && ['completed', 'success'].includes(op.status)
    && ['start', 'stop', 'restart'].includes(op.action) && recentMs < recentWindowMs;

  if (!actualRunning && dbStatus === 'running') {
    if (planned && op.action === 'stop') return { action: 'none' };
    if (planned) return { action: 'none' };
    return { action: 'open', category: 'unexpected_stop', severity: 'high' };
  }
  if (actualRunning && dbStatus !== 'running') {
    return { action: 'open', category: 'unexpected_state', severity: 'medium' };
  }
  if (!actualRunning && dbStatus === 'stopped' && planned && op.action === 'stop') {
    return { action: 'resolve', summary: 'VM stopped by an authorized action.' };
  }
  return { action: 'none' };
}

function createIncidentService({ collections, ensureConnected, vmService, getNextId = null, now = () => new Date() }) {
  if (!collections || typeof ensureConnected !== 'function') throw new TypeError('Incident store dependencies are required.');

  function dedupeKey(resourceType, resourceId, category) {
    return `${resourceType}:${Number(resourceId)}:${String(category).slice(0, 64)}`;
  }

  async function reportIncident({ ownerId, resourceType, resourceId, resourceName = '', category, severity = 'medium', source = 'monitor', evidence = null, exitCode = null, health = null }) {
    const owner = Number(ownerId);
    if (!Number.isSafeInteger(owner) || owner < 1) throw incidentError('not_authenticated', 'Authentication is required.');
    if (!resourceType || !category) throw incidentError('invalid_incident', 'Resource type and category are required.');
    if (!SEVERITIES.includes(severity)) throw incidentError('invalid_incident', 'Unknown severity.');
    await ensureConnected();
    const at = now().toISOString();
    const key = dedupeKey(resourceType, resourceId, category);
    const open = await collections.incidents.findOne({ dedupe_key: key, status: { $in: OPEN_STATUSES } });
    if (open) {
      await collections.incidents.updateOne({ id: open.id }, {
        $set: { last_observed_at: at, updated_at: at, evidence: trimEvidence(evidence) || open.evidence, health: health ?? open.health, exit_code: exitCode ?? open.exit_code },
        $inc: { occurrence_count: 1 },
      });
      return collections.incidents.findOne({ id: open.id });
    }
    const id = await nextIncidentId();
    const row = {
      id, incident_id: crypto.randomUUID(), dedupe_key: key,
      owner_id: owner, resource_type: String(resourceType).slice(0, 32), resource_id: Number(resourceId),
      resource_name: safeText(resourceName, 120), category: String(category).slice(0, 64), severity,
      status: 'detected', source: String(source).slice(0, 32),
      exit_code: exitCode, health: health || null, evidence: trimEvidence(evidence),
      occurrence_count: 1, recovery_attempts: [],
      first_detected_at: at, last_observed_at: at, created_at: at, updated_at: at,
      resolved_at: null, resolution_summary: null,
    };
    await collections.incidents.insertOne(row);
    return collections.incidents.findOne({ id });
  }

  async function nextIncidentId() {
    
    
    if (typeof getNextId === 'function') return getNextId('incidents');
    const top = await collections.incidents.find({}).sort({ id: -1 }).limit(1).toArray().catch(() => []);
    return (top[0] && Number.isSafeInteger(top[0].id) ? top[0].id : 0) + 1;
  }

  async function visibleTo(user, row) {
    if (!row) return false;
    if (Number(row.owner_id) === Number(user?.id)) return true;
    return user?.role === 'admin' || Boolean(user?.root_admin);
  }

  async function getIncident(user, id) {
    await ensureConnected();
    const row = await collections.incidents.findOne({ id: Number(id) });
    if (!row || !(await visibleTo(user, row))) throw incidentError('incident_not_found', 'Incident not found.');
    return row;
  }

  async function listIncidents(user, { status = null, severity = null, resourceType = null, limit = 20, offset = 0 } = {}) {
    await ensureConnected();
    const filter = {};
    const isAdmin = user?.role === 'admin' || Boolean(user?.root_admin);
    if (!isAdmin) filter.owner_id = Number(user?.id);
    if (status === 'active') filter.status = { $in: OPEN_STATUSES };
    else if (status && STATUSES.includes(status)) filter.status = status;
    if (severity && SEVERITIES.includes(severity)) filter.severity = severity;
    if (resourceType) filter.resource_type = String(resourceType).slice(0, 32);
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const rows = await collections.incidents.find(filter).sort({ last_observed_at: -1 }).limit(safeLimit).skip(safeOffset).toArray().catch(() => collections.incidents.find(filter).sort({ last_observed_at: -1 }).limit(safeLimit).toArray());
    const total = await collections.incidents.countDocuments(filter).catch(() => rows.length);
    return { incidents: rows, total, limit: safeLimit, offset: safeOffset };
  }

  async function setStatus(user, id, status) {
    if (!STATUSES.includes(status) || status === 'resolved') throw incidentError('invalid_incident', 'Use the verified resolution path to resolve an incident.');
    const row = await getIncident(user, id);
    await ensureConnected();
    await collections.incidents.updateOne({ id: row.id }, { $set: { status, updated_at: now().toISOString() } });
    return collections.incidents.findOne({ id: row.id });
  }

  
  
  async function resolveRow(row, { summary = '', verified } = {}) {
    if (!verified || typeof verified !== 'object' || !verified.state || !verified.checked_at) {
      throw incidentError('unverified_resolution', 'Resolution requires verified recovery evidence: observed state and check time.');
    }
    await ensureConnected();
    const at = now().toISOString();
    await collections.incidents.updateOne({ id: row.id }, {
      $set: { status: 'resolved', resolved_at: at, updated_at: at, resolution_summary: safeText(summary, 500), verified_state: { state: String(verified.state).slice(0, 32), checked_at: String(verified.checked_at), source: String(verified.source || 'health-check').slice(0, 64) } },
      $unset: { dedupe_key: '' },
    });
    return collections.incidents.findOne({ id: row.id });
  }

  async function resolveIncident(user, id, resolution) {
    return resolveRow(await getIncident(user, id), resolution);
  }

  async function addRecoveryAttempt(user, id, { action, outcome, detail = '' }) {
    const row = await getIncident(user, id);
    if (row.status === 'resolved') throw incidentError('invalid_incident', 'Resolved incidents accept no further recovery attempts.');
    await ensureConnected();
    const attempts = Array.isArray(row.recovery_attempts) ? row.recovery_attempts.slice(-(MAX_ATTEMPTS - 1)) : [];
    attempts.push({ at: now().toISOString(), by: Number(user?.id) || null, action: safeText(action, 120), outcome: safeText(outcome, 32), detail: safeText(detail, 500) });
    const update = { recovery_attempts: attempts, last_observed_at: now().toISOString(), updated_at: now().toISOString() };
    if (row.status === 'detected') update.status = 'recovering';
    await collections.incidents.updateOne({ id: row.id }, { $set: update });
    return collections.incidents.findOne({ id: row.id });
  }

  
  async function scanVmStates({ limit = 200 } = {}) {
    const summary = { checked: 0, opened: 0, resolved: 0, errors: 0 };
    try {
      await ensureConnected();
      const vms = await collections.vms.find({}).sort({ id: -1 }).limit(Math.min(Math.max(Number(limit) || 200, 1), 500)).toArray();
      for (const vm of vms) {
        try {
          summary.checked += 1;
          const actual = vmService ? Boolean(vmService.isRunning(vm)) : vm.status === 'running';
          const latest = await collections.vm_operations.find({ vm_id: Number(vm.id) }).sort({ created_at: -1 }).limit(1).toArray().catch(() => []);
          const decision = classifyVmState({ vmId: vm.id, actualRunning: actual, dbStatus: vm.status, lastOp: latest[0] || null });
          if (decision.action === 'open') {
            await reportIncident({
              ownerId: vm.owner_id, resourceType: 'vm', resourceId: vm.id, resourceName: vm.name,
              category: decision.category, severity: decision.severity, source: 'vm-reconcile',
              health: actual ? 'running' : 'stopped',
              evidence: { db_status: vm.status, observed: actual ? 'running' : 'stopped', last_operation: latest[0] ? { action: latest[0].action, status: latest[0].status, actor_id: latest[0].actor_id ?? null } : null },
            });
            summary.opened += 1;
          } else if (decision.action === 'resolve') {
            const open = await collections.incidents.findOne({ resource_type: 'vm', resource_id: Number(vm.id), status: { $in: OPEN_STATUSES } });
            if (open) {
              await resolveRow(open, { summary: decision.summary, verified: { state: actual ? 'running' : 'stopped', checked_at: now().toISOString(), source: 'vm-reconcile' } });
              summary.resolved += 1;
            }
          }
        } catch (_) { summary.errors += 1; }
      }
    } catch (_) { summary.errors += 1; }
    return summary;
  }

  return { reportIncident, getIncident, listIncidents, setStatus, resolveIncident, addRecoveryAttempt, scanVmStates, classifyVmState, STATUSES, OPEN_STATUSES, SEVERITIES };
}

module.exports = { createIncidentService, classifyVmState, STATUSES, OPEN_STATUSES, SEVERITIES };
