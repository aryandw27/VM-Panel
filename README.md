<div align="center">

# SiliconHost VM Panel
### Virtual machine provisioning and management for your infrastructure

[![Node.js](https://img.shields.io/badge/Node.js-v18+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com)
[![QEMU](https://img.shields.io/badge/QEMU-Virtualization-FF6600?style=for-the-badge&logo=qemu&logoColor=white)](https://www.qemu.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![GitHub Release](https://img.shields.io/badge/Release-v3.1.1-6366F1?style=for-the-badge&logo=github)](https://github.com/aryandw27/VM-Panel/releases)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

*A self-hosted QEMU/KVM control panel for provisioning and operating virtual machines, with separate administrator and customer workspaces, SSH console access, telemetry, a VPS app store, and configurable Discord activity logging.*

---

</div>

## 🌟 Key Highlights & Features

### 🎨 1. SiliconHost Design System
- **Refined Interface**: Charcoal and light surfaces, one restrained blue brand accent, subtle borders, readable typography, compact controls, and quiet shadows.
- **Optional Ambience**: Custom image/video backgrounds and interactive audio cues (`online`, `offline`, `copy`) remain available.
- **Light & Dark Appearance**: Polished light and charcoal themes with consistent controls and clear success, warning, and error states.
- **SiliconHost Design System**: Shared charcoal and light surfaces, restrained blue brand accent, compact spacing, subtle borders, consistent typography, and reduced-motion support across the admin panel, customer panel, and public website.
- **Admin Rate Limits & IP Security**: Configure per-IP request thresholds and temporary automatic blocks, review privacy-limited browser/OS request analytics, and manage manual IP blocks.
  - Automatic protection starts at 120 requests per IP per minute, followed by a 15-minute block; administrators can adjust these limits under **Admin → Rate Limits & IP Security**. Request summaries expire after 30 days.
- **Unified Navigation**: Compact responsive sidebar, restrained active states, mobile drawer, and consistent topbar controls.
- **VPS App Store**: Install reviewed WordPress and OpenClaw deployments on an owned VM, or run a confirmed custom shell script. WordPress installs save a QEMU host-port mapping that takes effect on the next VM restart; OpenClaw remains private and is accessed through SSH tunnelling.
- **Discord Activity Logging**: Run a Discord bot with encrypted token storage, live guild/channel discovery, per-event destinations, editable message templates, embed colors, and test delivery.

### 🖥️ 2. Signature Arix Server Console Dashboard
- **Top Header & Spec Summary**: Displays server name, OS distro, allocated vCPUs, RAM, and SSH port.
- **Unified Power Controls**: Real-time 3-state power button group with consistent action colors and safety confirmations.
- **2-Column Split Console Grid**:
  - **Left (Terminal Window)**:
    - Multi-session SSH Terminal with **24/7 background persistence**.
    - 4-corner interactive mouse resize handles and quick presets (`169×33`, `Fit`, `Full`).
    - **noVNC Graphical Desktop**: Low-latency HTML5 remote framebuffer console for QEMU guests with `Ctrl+Alt+Del`.
    - **Live Boot Logs**: Real-time serial kernel streaming with AI Virtualization Diagnostics for boot failure remediation.
    - **Interactive Command Prompt Bar**: Terminal input (`» Type a command...`) supporting Enter dispatch and Up/Down history navigation.
  - **Right (7 Real-Time Stat Cards)**:
    - **Address**: Hostname & port with 1-click clipboard copy.
    - **Uptime**: Live guest uptime counter (`Xd Xh Xm Xs` / `Offline`).
    - **CPU Load**: Real-time % utilization.
    - **Memory**: Used MB vs. Total Allocated MB.
    - **Disk**: Live consumed storage vs. Virtual disk capacity.
    - **Network (Inbound)**: Live RX throughput (KiB/s).
    - **Network (Outbound)**: Live TX throughput (KiB/s).
- **Bottom 3 Telemetry Area Charts**:
  - Real-time Bézier SVG area charts for **CPU Load**, **Memory**, and **Network** (inbound/outbound dual metrics) updated every 2.5 seconds.

### 👑 3. Admin Control Plane vs. Tenant User Panel
- **Cluster Nodes Architecture**: Manage virtualization nodes, resource capacity, daemon ports, and guest allocations.
- **Virtual Machines & Storage**: Deploy VMs from cloud-init-ready images (Ubuntu 22.04–26.04, Debian 11–13, Kali Linux, Fedora 43, CentOS Stream 9–10, AlmaLinux 9–10, Rocky Linux 9–10). Manage Local Directory, LVM, and NFS storage pools. Windows and Proxmox installer ISOs are not offered as cloud images; they require a separate manual installation workflow.
- **User Management & Delegation**: Subuser access control, TOTP Two-Factor Authentication (2FA), and 1-click **Admin User Impersonation** with a floating return bar.
- **MongoDB Management Studio**: Integrated Mongo-Express style database manager for collections, documents, and query execution.
- **Command Palette (`Ctrl + K`)**: Universal spotlight modal for instant server search, navigation, and power dispatch.
- **Plugin System & Webhooks**: Native integrations for **Discord Rich Embeds**, **Telegram Bot Alerts**, and outgoing signed HTTP POST webhooks.

### 🔄 4. Automated CI/CD & GitHub Actions Release
- **Automated Workflow (`.github/workflows/release.yml`)**: Automatically generates semver tags (`v3.1.1`) and publishes GitHub Releases with release notes upon pushes to `main`.

---

## 🏗️ Architecture & Stack

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   SiliconHost VM Panel Frontend                       │
│       Arix Theme v2.1.3 • EJS • Xterm.js • Socket.IO • Lucide Icons    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP / WebSocket (Port 3001)
┌───────────────────────────────────▼────────────────────────────────────┐
│                         Node.js & Express Core                         │
│     Cluster Node Orchestrator • MongoDB • Auth / RBAC • Event Plugins  │
└─────────────────┬──────────────────────────────────────┬───────────────┘
                  │                                      │
┌─────────────────▼──────────────┐     ┌─────────────────▼───────────────┐
│     QEMU Hypervisor Engine     │     │      vPanel Guest Agent         │
│   (KVM / TCG • VirtIO • VNC)   │     │   (Serial Daemon / SSH / Files) │
└────────────────────────────────┘     └─────────────────────────────────┘
```

---

## 📋 System Requirements

- **Operating System**: Linux (Ubuntu 20.04+, Debian 11+, RHEL/CentOS 9+, Fedora, Arch Linux)
- **Node.js**: v18.0.0+ (v20+ recommended)
- **Database**: MongoDB 5.0+ (or Docker container `mongo:latest`)
- **Virtualization**: QEMU (`qemu-system-x86_64`, `qemu-img`)
- **Utilities**: `cloud-image-utils` (`cloud-localds`), `wget`, `openssl`, `python3`

---

## 🚀 Installation & Quick Start

### Option 1: Automated Installer (Recommended)

```bash
# Clone the repository
git clone https://github.com/aryandw27/VM-Panel.git
cd VM-Panel

# Guided install (installs dependencies, MongoDB, and vPanel)
sudo bash install.sh

# The installer prompts for admin username, email, password, and web panel port.
# The API uses port 3002 by default (3003 if the web panel is assigned 3002).
# Use `sudo bash install.sh --menu` to open the maintenance menu instead.
# Allow the chosen web port and API port through your VPS provider firewall/security group.

# If an existing `.env` points to an unreachable local MongoDB, the installer
# tries to start the installed MongoDB service or existing `mongodb` container.
# If neither exists, it provisions a local-only Docker MongoDB using the
# preserved URI credentials and `mongodb_data` volume. Non-local MongoDB URIs
# are never replaced; restore access to that database before retrying. Do not
# delete `.env` or MongoDB volumes as a troubleshooting step.
# If MongoDB still fails, the installer prints the container exit status,
# recent MongoDB logs, and the connection error category to help identify
# unsupported CPU features, port conflicts, or stale database credentials.
# If a local MongoDB explicitly rejects the configured `admin` password while
# reusing `mongodb_data`, the installer updates only that credential in an
# isolated, localhost-only maintenance container. MongoDB collections and
# files are not deleted; unreachable non-local databases are never modified.

# Or 1-line unattended install
sudo bash install.sh --install -y --admin-user admin --admin-email admin@siliconhost.local --admin-pass 'your_secure_password'
```

#### Installer CLI Options:
| Flag | Description | Default |
| :--- | :--- | :--- |
| `1`, `--install` | Full automated Debian/Ubuntu installation | - |
| `2`, `--create-admin` | Create or reset administrator account | - |
| `3`, `--update` | Pull latest updates and zero-downtime reload | - |
| `4`, `--pm2` | PM2 cluster management menu | - |
| `5`, `--uninstall` | Safe uninstaller wizard | - |
| `--menu` | Open the maintenance menu | - |
| `--admin-user <user>` | Administrator username | `admin` |
| `--admin-email <email>`| Administrator email address | `admin@siliconhost.local` |
| `--admin-pass <pass>` | Administrator password | Prompted securely |
| `--panel-port <port>` | Web panel port | `3001` |
| `--no-pm2` | Skip PM2 daemon setup | `0` |
| `-y`, `--non-interactive` | Run without interactive prompts | `0` |

---

### Option 2: Manual Setup

```bash
# 1. Clone repository & install dependencies
git clone https://github.com/aryandw27/VM-Panel.git
cd VM-Panel
npm install

# 2. Build assets
npm run build

# 3. Create administrator account
npm run createuser

# 4. Start SiliconHost VM Panel
npm start
```

---

### Option 3: Production Deployment with PM2

```bash
# Start cluster with automatic restarts and logging
pm2 start ecosystem.config.js

# Persist across system reboots
pm2 save
pm2 startup
```

---

### Option 4: Docker & No-KVM Mode

For environments without `/dev/kvm` hardware acceleration, follow the required secret setup and Compose steps in [README-DOCKER.md](README-DOCKER.md):

```bash
docker compose up -d --build
```

---

## 🌐 Default Ports & Access

| Service | Default URL / Port | Description |
| :--- | :--- | :--- |
| **Web Panel** | `http://<host_ip>:3001` | SiliconHost VM Panel administrator and customer workspaces |
| **REST API** | `http://<host_ip>:3002/api` | RESTful API & Socket.IO telemetry engine |
| **VM Port Range** | `25501 - 25600` | Dynamic host-forwarded guest SSH ports |
| **noVNC Console Range** | `25901 - 26000` | Dynamic host-forwarded guest VNC ports |
| **Agent Port Range** | `26101 - 26200` | Guest daemon communication |

---

## VPS App Store

The authenticated **App Store** installs reviewed WordPress and OpenClaw setups on VMs owned by the signed-in user. It also provides an advanced custom-script option, limited to 16 KB and requiring explicit confirmation; custom scripts run as root inside the selected guest. Installs require a running VM with working SSH access.

- **WordPress** installs a persistent Docker Compose stack. SiliconHost selects an available host port and saves a QEMU forward to guest port `8080`. Restart the VM to activate the mapping, allow the selected port through the host firewall, then finish setup in WordPress.
- **OpenClaw** is installed from its official source and started with token authentication. It is not publicly forwarded by default. Use the private SSH tunnel and one-time gateway token shown after installation, then configure a model provider in OpenClaw.
- Docker-based catalog apps currently support Debian and Ubuntu guests. The app store does not silently execute third-party catalog scripts; custom scripts are supplied by the VM owner.

## Discord Activity Logging

Administrators can configure a Discord bot under **Admin → Discord Logging**. The bot requires the Guilds intent and View Channels, Send Messages, and Embed Links permissions in each server. It discovers servers and text channels through the Discord Gateway, supports event/channel routes, templates (`{user}`, `{ip}`, `{server}`, `{event}`, `{time}`, `{details}`), embed colors, and test delivery. Bot tokens are encrypted at rest using `JWT_SECRET` and are never returned by the settings API. Keep the secret persistent and backed up; changing or losing it requires entering the bot token again.

## ⚙️ Configuration (`.env`)

```ini
# Panel Ports & URLs
PANEL_PORT=3001
API_PORT=3002
PANEL_URL=http://localhost:3001
NODE_ENV=production

# Security
JWT_SECRET=your_super_secret_jwt_key_here
JWT_EXPIRES=7d
ALLOW_REGISTER=1

# MongoDB Connection URI
MONGO_URI=mongodb://admin:password@127.0.0.1:27017/vpanel?authSource=admin

# Storage & VM Directories
VM_DIR=./vms

# Port Allocation Ranges
AUTO_PORT_MIN=25501
AUTO_PORT_MAX=25600
AUTO_VNC_PORT_MIN=25901
AUTO_VNC_PORT_MAX=26000
AUTO_AGENT_PORT_MIN=26101
AUTO_AGENT_PORT_MAX=26200
```

### AI assistant (BYOK)

The account AI assistant uses each user's own provider key. Before users save keys, configure `AI_CREDENTIALS_ENCRYPTION_KEY` in the panel process environment. Generate a persistent 32-byte key with `openssl rand -base64 32`; keep it outside Git and back it up securely. Saved keys use authenticated encryption, and are unrecoverable if this encryption key is lost. See [docs/ai-byok.md](docs/ai-byok.md) for provider setup, supported read-only tools, security details, and rollout notes.

---

## 🔌 Core API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/login` | Authenticate and obtain JWT token |
| `GET` | `/api/vms` | List all accessible virtual machines |
| `POST` | `/api/vms/:id/action` | Trigger power actions (`start`, `stop`, `restart`, `kill`) |
| `GET` | `/api/vms/:id/status` | Fetch real-time CPU, RAM, disk, and network telemetry |
| `GET` | `/api/vms/:id/bootlog` | Retrieve kernel serial boot stream |
| `GET` | `/api/vms/:id/files?path=/` | Browse guest filesystem via agent/SSH |
| `POST` | `/api/vms/:id/files/upload` | Upload files to guest filesystem |
| `GET` | `/api/wallpapers?category=all` | Browse 4K wallpaper library |
| `POST` | `/api/wallpapers/apply` | Apply wallpaper & glassmorphism theme presets |

---

## 📜 License

Distributed under the MIT License. See `LICENSE` for more information.

<div align="center">
  <sub>Built with ❤️ by <a href="https://github.com/nobita329">Nobita</a> & contributors.</sub>
</div>
