const { collections, ensureConnected } = require('../lib/db');

class AuditService {
  async getTimeline(limit = 50) {
    await ensureConnected();
    const events = await collections.audit_events
      .find({})
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    return events.map(e => ({
      ...e,
      formattedTime: new Date(e.timestamp).toLocaleString(),
    }));
  }

  async getLoginHistory(limit = 40) {
    await ensureConnected();
    const logs = await collections.login_attempts
      .find({})
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    return logs.map(l => ({
      id: l._id,
      ip: l.ip || '127.0.0.1',
      username: l.username || 'unknown',
      success: Boolean(l.success !== false),
      method: l.method || 'Password + JWT',
      user_agent: l.user_agent || 'Mozilla/5.0 (vPanel Client)',
      timestamp: l.timestamp || new Date().toISOString(),
      formattedTime: new Date(l.timestamp || Date.now()).toLocaleString(),
    }));
  }

  async getSecurityIncidents() {
    await ensureConnected();
    const failedLogins = await collections.login_attempts
      .find({ success: false })
      .sort({ timestamp: -1 })
      .limit(20)
      .toArray();

    const incidents = [];
    failedLogins.forEach(f => {
      incidents.push({
        type: 'Failed Authentication',
        severity: 'MEDIUM',
        details: `Failed password attempt for user '${f.username}' from IP ${f.ip}`,
        ip: f.ip,
        timestamp: f.timestamp || new Date().toISOString(),
      });
    });

    const highLoadEvents = await collections.audit_events
      .find({ event: { $regex: /alert|security|fail/i } })
      .sort({ timestamp: -1 })
      .limit(10)
      .toArray();

    highLoadEvents.forEach(h => {
      incidents.push({
        type: h.event,
        severity: 'HIGH',
        details: h.payload?.message || JSON.stringify(h.payload),
        ip: h.ip,
        timestamp: h.timestamp,
      });
    });

    return incidents.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }
}

module.exports = new AuditService();
