# Deployment runtimes

The admin create page requires a **Deployment Type**. Six kinds are supported and stored in `vms.kind`; rows created before this feature default to `qemu-dedicated`.

| Kind | Runtime | Guest kernel | Default image source |
| :--- | :--- | :--- | :--- |
| `qemu-dedicated` | QEMU (+ KVM) | Own kernel | Cloud image |
| `qemu-shared` | QEMU (+ KVM or TCG) | Own kernel | Cloud image |
| `docker` | Docker Engine | Host kernel | Docker Hub image |
| `lxc` | LXC CLI | Host kernel | `images:` remote |
| `incus-container` | Incus | Host kernel | `images:` remote |
| `incus-vm` | Incus | Own kernel | `images:` remote + cloud-init |

## Prerequisites on each compute node

The panel detects each runtime at request time and marks it **Ready** or **Not installed** in the create form. Nothing is installed automatically.

- **QEMU**: `qemu-system-x86_64`, `qemu-img`, `cloud-localds`, `wget`; `/dev/kvm` for dedicated VMs (the panel still offers shared VMs without KVM via TCG).
- **Docker**: a reachable Docker daemon (`docker info` must succeed). The panel process needs access to the daemon socket.
- **LXC**: `lxc` with a configured `images:` remote (`lxc info` must succeed).
- **Incus**: `incus` with a configured `images:` remote (`incus info` must succeed).
- Both LXC and Incus need their daemon running on the node; on the panel host that means the panel can reach the daemon socket.

Typical installation on a Debian/Ubuntu node:

```sh
# Docker
curl -fsSL https://get.docker.com | sh

# LXC (LXD)
sudo apt-get install -y lxd && sudo lxd init --auto

# Incus
sudo apt-get install -y incus && sudo incus admin init --auto
```

On a Wings node, install the runtime as root, restart Wings so it re-registers its capabilities, then reload the create page.

Remote Wings nodes must be upgraded with this release. A node that has not re-registered reports no runtime data and its container kinds stay disabled. Wings advertises `runtime_capabilities` on every (re)connect.

## Hard resource caps

Every workload receives a hard ceiling; overcommit only affects admission, never the runtime cap.

- **QEMU**: launched in a transient systemd scope (`vpanel-vm-<id>`) with `CPUQuota=<cpus * 100>%`, `MemoryMax=<memory * 1.1 + 128>M`, `MemorySwapMax=0`. `-daemonize` is removed in this mode so the process stays inside the scope. If systemd is unavailable, the VM starts without cgroup caps and the panel logs that hard limits are inactive.
- **Docker**: `--cpus`, `--memory`, `--memory-swap` (equal to memory), `--pids-limit 512`.
- **LXC**: `limits.cpu`, `limits.memory`, `limits.processes`.
- **Incus**: `limits.cpu`, `limits.memory`; containers also get `limits.processes`.

Change CPU or memory from the server settings to apply the new limits in place for containers. QEMU limits apply on the next start and are also enforced for remote nodes.

## Admission control

`src/services/capacityService.js` refuses a deployment that would exceed the node's committed capacity:

- CPU limit = `(cores - reserve) * kind.cpu_overcommit`. Dedicated VMs use `1x`; shared VMs use `2.5x`; containers use `4x`.
- Memory limit = `memory - reserve` with no overcommit. Default reserve is 10% (minimum 512 MB) and 10% of cores (minimum 1).
- Disk is counted only for QEMU rows (95% of the node disk).
- A remote node that has never reported capacity is treated as unknown; the create is refused instead of guessing.

Tuning:

```env
CAPACITY_ENFORCEMENT=0       # disable admission control (not recommended)
CAPACITY_RESERVE_CORES=2
CAPACITY_RESERVE_MB=2048
VPANEL_VM_SLICE=vpanel-vms.slice
VPANEL_DISABLE_CGROUPS=1     # start QEMU without a systemd scope
```

The panel also reconciles local container state every 60 seconds, so a container stopped or started outside the panel does not leave a permanently wrong status.

### Keeping the panel responsive

Hard caps bound each workload, but CPU is still shared when tenants saturate their quotas. Give the panel a larger CPU share than the sandboxes:

```sh
# systemd drop-in for the panel process (PM2 uses pm2-root.service)
sudo systemctl set-property pm2-root.service CPUWeight=1000 MemoryMin=512M

# QEMU scopes live in vpanel-vms.slice; give them a smaller relative share
sudo mkdir -p /etc/systemd/system/vpanel-vms.slice.d
printf '[Slice]\nCPUWeight=100\nMemoryHigh=90%%\n' | sudo tee /etc/systemd/system/vpanel-vms.slice.d/50-vpanel.conf
sudo systemctl daemon-reload
```

Containers are managed by Docker, LXC or Incus, so limit the runtime daemons' own slices the same way if they run on the panel host. Keeping MongoDB on a separate host or at least a separate slice is strongly recommended.

## Access modes

Each deployment can enable any combination of:

- **SSH** — publishes the allocated SSH port. Containers install `openssh-server` (apt/apk/dnf/yum) and set the chosen password during creation; Incus VMs inject credentials through cloud-init. If SSH setup fails during a container create, the container is removed and the API returns `ssh_provision_failed`.
- **Web terminal** — uses `docker exec`, `lxc exec` or `incus exec` through the existing xterm console. Local sessions run through `script(1)` to obtain a PTY; remote sessions open an SSH PTY to the Wings node.
- **Published ports** — Docker `-p` mappings; LXC/Incus proxy devices. Port collisions are rejected by the runtime.

Container images need a shell and a package manager for SSH provisioning. Curated images: Ubuntu, Debian, Alpine, Fedora and Rocky. Custom references are accepted unless they contain whitespace, quotes or shell metacharacters.

## Security boundary

Docker, LXC and Incus containers share the host kernel. Run only trusted workloads in them, or add a stronger isolation layer (user namespaces, rootless Docker, gVisor/Kata). Access to the Docker socket is root-equivalent on the host; keep admin accounts limited.
