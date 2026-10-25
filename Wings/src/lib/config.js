'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const CONFIG_PATH = process.env.WINGS_CONFIG || path.join(__dirname, '..', '..', 'config', 'wings.yml');

let configCache = null;

function loadConfig() {
  if (configCache) return configCache;

  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Wings config not found at ${CONFIG_PATH}. Run the installer or paste the panel configuration script first.`);
  }

  const parsed = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  if (!parsed.panel || !parsed.panel.url) {
    throw new Error(`Wings config at ${CONFIG_PATH} is missing panel.url`);
  }
  if (!parsed.panel.api_key) {
    throw new Error(`Wings config at ${CONFIG_PATH} is missing panel.api_key (the node token from the panel)`);
  }

  configCache = parsed;
  return configCache;
}

function getConfig() {
  return loadConfig();
}

function getPanelUrl() {
  return String(getConfig().panel.url || '').replace(/\/+$/, '');
}

function getApiKey() {
  return String(getConfig().panel.api_key || '');
}

function getNodeId() {
  const config = getConfig();
  return Number(config.node && config.node.id) || null;
}

function getNodeName() {
  const config = getConfig();
  return (config.node && config.node.name) || `node-${getNodeId() || 'unknown'}`;
}

function getVps() {
  const config = getConfig();
  return config.vps || {};
}

function getVpsAddress() {
  const vps = getVps();
  return String(vps.ip || '');
}

function getSshPort() {
  const config = getConfig();
  return parseInt((config.ssh && config.ssh.port) || 22, 10) || 22;
}

function getSshUser() {
  const config = getConfig();
  return (config.ssh && config.ssh.user) || 'root';
}

function getSshKeyPath() {
  const config = getConfig();
  return (config.ssh && config.ssh.key_path) || '/root/.ssh/id_rsa';
}

function getVmDir() {
  const config = getConfig();
  return (config.storage && config.storage.vm_dir) || '/var/lib/wings/vms';
}

function getImagesDir() {
  const config = getConfig();
  return (config.storage && config.storage.images_dir) || '/var/lib/wings/images';
}

function getLogFile() {
  const config = getConfig();
  return (config.logging && config.logging.file) || '/var/log/wings/wings.log';
}

function getLogLevel() {
  const config = getConfig();
  return (config.logging && config.logging.level) || 'info';
}

function getWebSocketUrl() {
  const panel = new URL(getPanelUrl());
  panel.protocol = panel.protocol === 'https:' ? 'wss:' : 'ws:';
  panel.pathname = '/api/wings/connect';
  panel.search = '';
  return panel.toString();
}

function getAuthHeaders() {
  return {
    Authorization: `Bearer ${getApiKey()}`,
    'X-Wings-Node': String(getNodeId() || ''),
    'X-Wings-Name': getNodeName(),
  };
}

function reloadConfig() {
  configCache = null;
  return loadConfig();
}

module.exports = {
  CONFIG_PATH,
  loadConfig,
  getConfig,
  getPanelUrl,
  getApiKey,
  getNodeId,
  getNodeName,
  getVps,
  getVpsAddress,
  getVmDir,
  getImagesDir,
  getSshPort,
  getSshUser,
  getSshKeyPath,
  getLogFile,
  getLogLevel,
  getWebSocketUrl,
  getAuthHeaders,
  reloadConfig,
};
