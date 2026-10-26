'use strict';

const definitions = require('./definitions');
const capabilities = require('./capabilities');
const qemuLimits = require('./qemuLimits');
const docker = require('./docker');
const lxc = require('./lxc');
const incus = require('./incus');

const DRIVERS = { docker, lxc, incus };

function driverForKind(kind) {
  return DRIVERS[definitions.runtimeForKind(kind)] || null;
}

function isManaged(kind) {
  return Boolean(driverForKind(kind));
}

function create(vm) {
  const driver = driverForKind(vm.kind);
  if (!driver) throw new Error(`No local runtime is registered for ${vm.kind}`);
  return driver.create(vm);
}

function start(vm) {
  return driverForKind(vm.kind).start(vm);
}

function stop(vm, options) {
  return driverForKind(vm.kind).stop(vm, options);
}

function restart(vm) {
  return driverForKind(vm.kind).restart(vm);
}

function remove(vm) {
  return driverForKind(vm.kind).remove(vm);
}

function status(vm) {
  return driverForKind(vm.kind).status(vm);
}

function stats(vm) {
  return driverForKind(vm.kind).stats(vm);
}

function logs(vm, lines) {
  return driverForKind(vm.kind).logs(vm, lines);
}

function terminalArgv(vm) {
  return driverForKind(vm.kind).terminalArgv(vm);
}

function localAvailability({ force = false } = {}) {
  const detected = capabilities.detectCached({ force });
  return {
    ...detected,
    kinds: capabilities.publicAvailability(detected),
  };
}

module.exports = {
  definitions,
  capabilities,
  qemuLimits,
  drivers: DRIVERS,
  driverForKind,
  isManaged,
  create,
  start,
  stop,
  restart,
  remove,
  status,
  stats,
  logs,
  terminalArgv,
  localAvailability,
};
