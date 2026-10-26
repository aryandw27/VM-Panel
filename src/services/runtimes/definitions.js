'use strict';

/**
 * Deployment kinds supported by the panel. "kind" is stored on every record so
 * existing QEMU servers stay valid (legacy rows default to qemu-dedicated).
 *
 * cpu_overcommit / memory_overcommit are admission-control factors, not runtime
 * limits: every workload still receives a hard cgroup cap.
 */
const KINDS = Object.freeze({
  'qemu-dedicated': {
    id: 'qemu-dedicated',
    runtime: 'qemu',
    label: 'Dedicated CPU VM',
    summary: 'Full KVM virtual machine with reserved vCPUs',
    description: 'A complete guest OS with reserved CPU capacity. Best for production workloads that need predictable performance and kernel isolation.',
    icon: 'server',
    is_vm: true,
    cpu_overcommit: 1,
    memory_overcommit: 1,
    supports_ssh: true,
    supports_terminal: true,
    supports_ports: true,
    supports_kvm: true,
    image_source: 'cloud-image',
  },
  'qemu-shared': {
    id: 'qemu-shared',
    runtime: 'qemu',
    label: 'Shared CPU VM',
    summary: 'Burstable virtual machine with hard CPU quota',
    description: 'A full guest OS whose vCPUs may be overcommitted across the node. Each VM still has a hard CPU and memory ceiling, so one tenant cannot starve the panel.',
    icon: 'cpu',
    is_vm: true,
    cpu_overcommit: 2.5,
    memory_overcommit: 1,
    supports_ssh: true,
    supports_terminal: true,
    supports_ports: true,
    supports_kvm: true,
    image_source: 'cloud-image',
  },
  docker: {
    id: 'docker',
    runtime: 'docker',
    label: 'Docker Container',
    summary: 'Lightweight container from an Ubuntu, Debian, Alpine or Fedora image',
    description: 'Runs a Docker image with hard --cpus, --memory and PID limits. Fast to deploy, but shares the host kernel and is not a security boundary equivalent to a VM.',
    icon: 'container',
    is_vm: false,
    cpu_overcommit: 4,
    memory_overcommit: 1,
    supports_ssh: true,
    supports_terminal: true,
    supports_ports: true,
    supports_kvm: false,
    image_source: 'docker-image',
  },
  lxc: {
    id: 'lxc',
    runtime: 'lxc',
    label: 'LXC Container',
    summary: 'System container managed by the LXC CLI',
    description: 'A full userspace Linux system sharing the host kernel, with limits.cpu and limits.memory enforced by LXC.',
    icon: 'box',
    is_vm: false,
    cpu_overcommit: 4,
    memory_overcommit: 1,
    supports_ssh: true,
    supports_terminal: true,
    supports_ports: true,
    supports_kvm: false,
    image_source: 'lxc-image',
  },
  'incus-container': {
    id: 'incus-container',
    runtime: 'incus',
    label: 'Incus Container',
    summary: 'Incus system container with proxy port forwarding',
    description: 'An Incus-managed system container with hard resource limits and console access. A lighter alternative to Incus VMs.',
    icon: 'layers',
    is_vm: false,
    cpu_overcommit: 4,
    memory_overcommit: 1,
    supports_ssh: true,
    supports_terminal: true,
    supports_ports: true,
    supports_kvm: false,
    image_source: 'incus-image',
  },
  'incus-vm': {
    id: 'incus-vm',
    runtime: 'incus',
    label: 'Incus Virtual Machine',
    summary: 'Incus-managed VM with a real guest kernel',
    description: 'An Incus virtual machine, provisioned from an Incus image with hard limits and cloud-init credentials.',
    icon: 'monitor',
    is_vm: true,
    cpu_overcommit: 2,
    memory_overcommit: 1,
    supports_ssh: true,
    supports_terminal: true,
    supports_ports: true,
    supports_kvm: true,
    image_source: 'incus-image',
  },
});

const KIND_ORDER = [
  'qemu-dedicated',
  'qemu-shared',
  'docker',
  'lxc',
  'incus-container',
  'incus-vm',
];

const DEFAULT_KIND = 'qemu-dedicated';

const IMAGE_CATALOG = Object.freeze({
  docker: [
    { value: 'ubuntu:24.04', label: 'Ubuntu 24.04 LTS', distro: 'ubuntu', username: 'root' },
    { value: 'ubuntu:22.04', label: 'Ubuntu 22.04 LTS', distro: 'ubuntu', username: 'root' },
    { value: 'debian:12', label: 'Debian 12 Bookworm', distro: 'debian', username: 'root' },
    { value: 'debian:11', label: 'Debian 11 Bullseye', distro: 'debian', username: 'root' },
    { value: 'alpine:3.20', label: 'Alpine Linux 3.20', distro: 'alpine', username: 'root' },
    { value: 'fedora:40', label: 'Fedora 40', distro: 'fedora', username: 'root' },
    { value: 'rockylinux:9', label: 'Rocky Linux 9', distro: 'rockylinux', username: 'root' },
  ],
  lxc: [
    { value: 'images:ubuntu/24.04', label: 'Ubuntu 24.04 LTS', distro: 'ubuntu', username: 'ubuntu' },
    { value: 'images:ubuntu/22.04', label: 'Ubuntu 22.04 LTS', distro: 'ubuntu', username: 'ubuntu' },
    { value: 'images:debian/12', label: 'Debian 12 Bookworm', distro: 'debian', username: 'debian' },
    { value: 'images:debian/11', label: 'Debian 11 Bullseye', distro: 'debian', username: 'debian' },
    { value: 'images:alpine/3.20', label: 'Alpine Linux 3.20', distro: 'alpine', username: 'root' },
    { value: 'images:fedora/40', label: 'Fedora 40', distro: 'fedora', username: 'fedora' },
  ],
  incus: [
    { value: 'images:ubuntu/24.04', label: 'Ubuntu 24.04 LTS', distro: 'ubuntu', username: 'ubuntu' },
    { value: 'images:ubuntu/22.04', label: 'Ubuntu 22.04 LTS', distro: 'ubuntu', username: 'ubuntu' },
    { value: 'images:debian/12', label: 'Debian 12 Bookworm', distro: 'debian', username: 'debian' },
    { value: 'images:debian/11', label: 'Debian 11 Bullseye', distro: 'debian', username: 'debian' },
    { value: 'images:alpine/3.20', label: 'Alpine Linux 3.20', distro: 'alpine', username: 'root' },
    { value: 'images:fedora/40', label: 'Fedora 40', distro: 'fedora', username: 'fedora' },
  ],
});

const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{1,180}$/;

function isKnownKind(value) {
  return Object.prototype.hasOwnProperty.call(KINDS, String(value || ''));
}

function normalizeKind(value) {
  const kind = String(value || '').trim();
  return isKnownKind(kind) ? kind : DEFAULT_KIND;
}

function definitionFor(value) {
  return KINDS[normalizeKind(value)];
}

function runtimeForKind(value) {
  return definitionFor(value).runtime;
}

function isContainerKind(value) {
  return !definitionFor(value).is_vm;
}

function isQemuKind(value) {
  return definitionFor(value).runtime === 'qemu';
}

function imagesFor(value) {
  return IMAGE_CATALOG[runtimeForKind(value)] || [];
}

function imageEntry(kind, image) {
  return imagesFor(kind).find((entry) => entry.value === image) || null;
}

function isValidImage(kind, image) {
  const value = String(image || '').trim();
  if (!value || !IMAGE_PATTERN.test(value)) return false;
  if (imagesFor(kind).some((entry) => entry.value === value)) return true;
  // Administrators may supply any registry path as long as it is a plain image
  // reference; quotes, whitespace and shell metacharacters are rejected.
  return !/[\s"'`;|&$<>\\]/.test(value);
}

function publicKinds() {
  return KIND_ORDER.map((id) => {
    const entry = KINDS[id];
    return {
      id: entry.id,
      runtime: entry.runtime,
      label: entry.label,
      summary: entry.summary,
      description: entry.description,
      icon: entry.icon,
      is_vm: entry.is_vm,
      daemon: entry.runtime,
      supports_ssh: entry.supports_ssh,
      supports_terminal: entry.supports_terminal,
      supports_ports: entry.supports_ports,
      image_source: entry.image_source,
      images: imagesFor(id),
    };
  });
}

module.exports = {
  KINDS,
  KIND_ORDER,
  DEFAULT_KIND,
  IMAGE_CATALOG,
  isKnownKind,
  normalizeKind,
  definitionFor,
  runtimeForKind,
  isContainerKind,
  isQemuKind,
  imagesFor,
  imageEntry,
  isValidImage,
  publicKinds,
};
