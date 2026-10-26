'use strict';

const { spawn } = require('child_process');
const { Client } = require('ssh2');
const runtimes = require('./runtimes');
const { shellQuote } = require('./runtimes/util');
const logger = require('../lib/logger');

function commandFor(vm) {
  const argv = runtimes.terminalArgv(vm);
  return argv.map(shellQuote).join(' ');
}

function bridge(child) {
  const stream = {
    on(event, handler) {
      if (event === 'data') child.stdout.on('data', handler);
      else if (event === 'close') child.on('close', handler);
      else if (event === 'error') child.on('error', handler);
      else child.stdin.on(event, handler);
      return stream;
    },
    write(data) { try { child.stdin.write(data); } catch (_) {} },
    end() { try { child.stdin.end(); } catch (_) {} },
    setWindow() {},
  };
  const conn = { end() { try { child.kill('SIGTERM'); } catch (_) {} } };
  return { conn, stream };
}

function fallbackArgv(vm) {
  const argv = runtimes.terminalArgv(vm).filter((part) => part !== '-t');
  // Docker needs -i for a piped stdin; without a TTY it cannot use -t.
  if (argv[0] === 'docker') return argv.map((part) => (part === '-it' ? '-i' : part));
  return argv;
}

function openLocal(vm) {
  return new Promise((resolve, reject) => {
    const command = commandFor(vm);
    // script(1) allocates a pty even though the panel's stdin is a pipe. If the
    // host has no script(1), fall back to a piped session without a TTY.
    const child = spawn('script', ['-qfc', command, '/dev/null'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (error.code !== 'ENOENT') return reject(error);
      try {
        const argv = fallbackArgv(vm);
        const direct = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
        direct.once('error', reject);
        direct.once('spawn', () => resolve(bridge(direct)));
      } catch (spawnError) {
        reject(spawnError);
      }
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      resolve(bridge(child));
    });
    child.once('exit', (code, signal) => {
      if (code && code !== 0) logger.warn(`[console] local container terminal exited (${code}${signal ? `/${signal}` : ''})`);
    });
  });
}

async function openRemote(vm, { cols = 120, rows = 32 } = {}) {
  const node = await require('../lib/db').collections.nodes.findOne({ id: Number(vm.node_id) });
  if (!node) throw new Error('The compute node for this deployment no longer exists.');
  const host = node.ssh_ip || node.fqdn;
  if (!host || !node.ssh_user) throw new Error('SSH access to the compute node is not configured.');

  const conn = new Client();
  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; conn.end(); reject(new Error('SSH connection to the node timed out')); }
    }, 15000);
    conn.once('ready', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } });
    conn.once('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    const options = {
      host,
      port: parseInt(node.ssh_port, 10) || 22,
      username: node.ssh_user,
      readyTimeout: 15000,
      keepaliveInterval: 5000,
      keepaliveCountMax: 10,
    };
    if (node.ssh_password) options.password = String(node.ssh_password);
    else if (node.ssh_key_path) options.privateKey = require('fs').readFileSync(node.ssh_key_path);
    else { clearTimeout(timer); settled = true; reject(new Error('The compute node has no SSH password or key configured.')); return; }
    conn.connect(options);
  });

  const stream = await new Promise((resolve, reject) => {
    conn.exec(commandFor(vm), { pty: { term: 'xterm-256color', cols, rows } }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });

  return { conn, stream };
}

function open(vm, { cols = 120, rows = 32 } = {}) {
  if (vm.remote) return openRemote(vm, { cols, rows });
  return openLocal(vm);
}

module.exports = { open, openLocal, openRemote, commandFor };
