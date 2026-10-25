#!/usr/bin/env node
'use strict';

const path = require('path');

// The installer writes config/.env next to wings.yml; load it before anything reads config.
require('dotenv').config({
  path: process.env.WINGS_CONFIG
    ? path.join(path.dirname(process.env.WINGS_CONFIG), '.env')
    : path.join(__dirname, '..', 'config', '.env'),
});

const config = require('./lib/config');
const logger = require('./lib/logger');
const vmService = require('./services/vmService');
const client = require('./websocket/client');

logger.info('Starting SiliconHost Wings Daemon v1.0.0');

try {
  config.loadConfig();
  logger.setLevel(config.getLogLevel());
  logger.info('Configuration loaded', {
    panel: config.getPanelUrl(),
    node: config.getNodeId(),
    name: config.getNodeName(),
    vm_dir: config.getVmDir(),
  });
} catch (error) {
  logger.error('Failed to load configuration', { error: error.message });
  process.exit(1);
}

vmService.registerHandlers();
client.connect();

// Reconcile VM state with reality so the panel never shows a stale power state.
const syncTimer = setInterval(() => {
  for (const vm of vmService.listVms()) {
    const actual = vmService.isRunning(vm.id) ? 'running' : 'stopped';
    if (vm.status !== actual) {
      vm.status = actual;
      vm.updated_at = new Date().toISOString();
      try { vmService.saveState(vm); } catch (_) {}
      client.sendEvent(actual === 'running' ? 'vm_started' : 'vm_stopped', { vm_id: vm.id });
    }
  }
}, 60000);
if (typeof syncTimer.unref === 'function') syncTimer.unref();

const shutdown = (signal) => {
  logger.info(`Received ${signal}, shutting down Wings`);
  clearInterval(syncTimer);
  client.close();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.stack || error.message });
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection', { error: (error && error.message) || String(error) });
});

logger.info('Wings daemon initialized');
