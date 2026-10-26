'use strict';

const { spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_BUFFER = 8 * 1024 * 1024;

function run(command, args = [], { timeout = DEFAULT_TIMEOUT_MS, input, env } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    input,
    env: env || process.env,
    maxBuffer: MAX_BUFFER,
  });
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
    signal: result.signal || null,
  };
}

function runOrThrow(command, args = [], options = {}) {
  const result = run(command, args, options);
  if (result.error) {
    throw new Error(`${command} could not be executed: ${result.error.message}`);
  }
  if (result.code !== 0) {
    throw new Error(`${command} ${args[0] || ''} failed: ${(result.stderr || result.stdout || '').trim() || `exit code ${result.code}`}`);
  }
  return result.stdout;
}

function commandExists(binary) {
  if (!binary) return false;
  const result = spawnSync('sh', ['-c', `command -v ${shellQuote(binary)} >/dev/null 2>&1`], { stdio: 'ignore' });
  return result.status === 0;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function toArray(value) {
  if (Array.isArray(value)) return value.map((item) => (item && typeof item === 'object' ? item : String(item)));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function normalizeAccess(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch (_) { parsed = null; }
  }
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  return {
    ssh: source.ssh !== undefined ? bool(source.ssh) : true,
    terminal: source.terminal !== undefined ? bool(source.terminal) : true,
    ports: source.ports !== undefined ? bool(source.ports) : true,
  };
}

function parseDiskGb(value) {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*([GMT])?B?$/i);
  if (!match) return 0;
  const amount = parseFloat(match[1]);
  const unit = (match[2] || 'G').toUpperCase();
  if (unit === 'T') return Math.round(amount * 1024);
  if (unit === 'M') return Math.round(amount / 1024);
  return Math.round(amount);
}

function parseMemoryMb(value) {
  const number = parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeForwards(value) {
  return toArray(value)
    .map((raw) => {
      if (typeof raw === 'object' && raw) return raw;
      const parts = String(raw).split(':');
      return { host: parseInt(parts[0], 10), guest: parseInt(parts[1], 10) };
    })
    .filter((entry) => Number.isInteger(entry.host) && entry.host > 0 && entry.host < 65536
      && Number.isInteger(entry.guest) && entry.guest > 0 && entry.guest < 65536)
    .map((entry) => ({ host: Number(entry.host), guest: Number(entry.guest) }));
}

function dockerSizeToBytes(value) {
  const match = String(value || '').trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!match) return 0;
  const amount = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const factors = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TB: 1e12, TIB: 1024 ** 4 };
  return Math.round(amount * (factors[unit] || 1));
}

function percentFromDocker(value) {
  return parseFloat(String(value || '').replace('%', '')) || 0;
}

function lastLines(text, count = 200) {
  return String(text || '').split(/\r?\n/).slice(-Math.max(1, count)).join('\n');
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, Math.max(0, Number(ms) || 0));
}

function waitFor(check, { timeoutMs = 120000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    sleepSync(intervalMs);
  }
  return Boolean(check());
}

module.exports = {
  run,
  runOrThrow,
  commandExists,
  shellQuote,
  toArray,
  bool,
  normalizeAccess,
  parseDiskGb,
  parseMemoryMb,
  normalizeForwards,
  dockerSizeToBytes,
  percentFromDocker,
  lastLines,
  sleepSync,
  waitFor,
};
