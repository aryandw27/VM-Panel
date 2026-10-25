'use strict';

const fs = require('fs');
const path = require('path');

const LOG_FILE = process.env.WINGS_LOG_FILE || path.join(__dirname, '..', '..', 'logs', 'wings.log');
const LOG_DIR = path.dirname(LOG_FILE);

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (_) {}
}

const levels = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLevel = levels[process.env.WINGS_LOG_LEVEL] ?? levels.info;

function formatMessage(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] [wings] ${message}${metaStr}`;
}

function write(level, message, meta) {
  if (levels[level] < currentLevel) return;
  const line = formatMessage(level, message, meta);
  console[level === 'debug' ? 'log' : level](line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

const logger = {
  debug: (msg, meta) => write('debug', msg, meta),
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
  setLevel: (level) => {
    if (levels[level] !== undefined) currentLevel = levels[level];
  },
  LOG_FILE,
};

ensureLogDir();

module.exports = logger;
