const cron = require('node-cron');
const { collections, getNextId } = require('../lib/db');
const logger = require('../lib/logger');
const vmService = require('./vmService');
const backupService = require('./backupService');
const { logActivity } = require('./activityService');

const jobs = new Map();

function toCron(text) {
  let t = String(text).trim();
  if (/^(\S+\s+){4}\S+$/.test(t)) return t;
  const presets = {
    hourly: '0 * * * *',
    daily: '0 2 * * *',
    weekly: '0 2 * * 0',
    monthly: '0 2 1 * *',
  };
  if (presets[t]) return presets[t];
  return null;
}

function runJob(schedule) {
  return async () => {
    const sched = await collections.schedules.findOne({ id: Number(schedule.id) });
    if (!sched || !sched.enabled) return;
    const curVm = await vmService.getVm(sched.vm_id);
    if (!curVm) return;
    logger.info(`[cron] running "${sched.name}" (${sched.action}) for ${curVm.name}`);
    try {
      if (sched.action === 'start') await vmService.start(curVm);
      else if (sched.action === 'stop') await vmService.stop(curVm);
      else if (sched.action === 'restart') await vmService.restart(curVm);
      else if (sched.action === 'backup') await backupService.createBackup(curVm, { name: `sched-${Date.now()}` });
      await collections.schedules.updateOne({ id: Number(sched.id) }, { $set: { last_run_at: new Date().toISOString() } });
      await logActivity({ vm_id: curVm.id, event: 'schedule:run', details: { name: sched.name, action: sched.action } });
    } catch (e) {
      logger.error('[cron] job error: ' + e.message);
      try {
        await collections.schedules.updateOne({ id: Number(sched.id) }, {
          $set: { last_error_at: new Date().toISOString(), last_error: String(e.message || 'Scheduled job failed.').slice(0, 300) },
          $inc: { consecutive_failures: 1 },
        });
      } catch (_) {}
    }
  };
}

async function register(schedule) {
  unregister(schedule.id);
  const vm = await vmService.getVm(schedule.vm_id);
  if (!vm || !schedule.enabled) return;
  const cronExpr = toCron(schedule.cron);
  if (!cronExpr) {
    logger.warn(`[cron] invalid expression for "${schedule.name}"`);
    return;
  }
  if (!cron.validate(cronExpr)) {
    logger.warn(`[cron] invalid cron "${schedule.cron}"`);
    return;
  }
  try {
    const task = cron.schedule(cronExpr, runJob(schedule), { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    jobs.set(schedule.id, task);
    logger.info(`[cron] registered "${schedule.name}" ${cronExpr}`);
  } catch (e) {
    logger.error('[cron] register error: ' + e.message);
  }
}

function unregister(id) {
  const t = jobs.get(id);
  if (t) {
    t.stop();
    jobs.delete(id);
  }
}

async function loadAll() {
  const all = await collections.schedules.find({ enabled: 1 }).toArray();
  for (const s of all) {
    await register(s);
  }
}

async function reload() {
  for (const id of jobs.keys()) unregister(id);
  await loadAll();
}

async function add(data, user) {
  const cronExpr = toCron(data.cron);
  if (!cronExpr) throw new Error('Invalid cron expression');
  if (!['start', 'stop', 'restart', 'backup'].includes(data.action)) throw new Error('Invalid action');
  const id = await getNextId('schedules');
  const doc = {
    id,
    vm_id: Number(data.vm_id),
    name: data.name,
    cron: cronExpr,
    action: data.action,
    enabled: data.enabled ? 1 : 0,
    last_run_at: null,
    next_run_at: null,
    created_at: new Date().toISOString(),
  };
  await collections.schedules.insertOne(doc);
  await register(doc);
  await logActivity({ user_id: user ? user.id : null, vm_id: data.vm_id, event: 'schedule:create', details: data });
  return doc;
}

async function update(id, data, user) {
  const sched = await collections.schedules.findOne({ id: Number(id) });
  if (!sched) throw new Error('Schedule not found');
  const cronExpr = data.cron ? toCron(data.cron) : sched.cron;
  const $set = {
    name: data.name ?? sched.name,
    cron: cronExpr,
    action: data.action ?? sched.action,
    enabled: data.enabled !== undefined ? (data.enabled ? 1 : 0) : sched.enabled,
  };
  await collections.schedules.updateOne({ id: Number(id) }, { $set });
  const updated = await collections.schedules.findOne({ id: Number(id) });
  await register(updated);
  await logActivity({ user_id: user ? user.id : null, vm_id: sched.vm_id, event: 'schedule:update', details: data });
  return updated;
}

async function remove(id, user) {
  const sched = await collections.schedules.findOne({ id: Number(id) });
  if (!sched) throw new Error('Schedule not found');
  unregister(id);
  await collections.schedules.deleteOne({ id: Number(id) });
  await logActivity({ user_id: user ? user.id : null, vm_id: sched.vm_id, event: 'schedule:delete', details: { name: sched.name } });
  return true;
}

module.exports = { add, update, remove, register, unregister, loadAll, reload, toCron };
