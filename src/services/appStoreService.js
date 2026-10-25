const net = require('net');
const crypto = require('crypto');
const { collections, settings } = require('../lib/db');
const sshService = require('./sshService');
const vmService = require('./vmService');
const { logActivity } = require('./activityService');

const MAX_CUSTOM_SCRIPT_BYTES = 16 * 1024;
const DEFAULT_INSTALLER_TIMEOUT = 20 * 60 * 1000;
const LONG_INSTALLER_TIMEOUT = 45 * 60 * 1000;
const APP_ROOT = '/opt/siliconhost-apps';

const catalog = [
  // ── CMS ─────────────────────────────────────────────────────────────────
  {
    id: 'wordpress',
    name: 'WordPress',
    category: 'CMS',
    description: 'WordPress with MariaDB as a persistent Compose stack, plus a one-click admin setup via wp-cli. Enter the admin details during install or rely on generated values.',
    icon: 'file-text',
    guestPort: 8080,
    exposure: 'Public HTTP after the VM restarts to apply its saved port mapping.',
    resultNote: (cfg) => `WordPress admin user "${cfg?.adminName || 'admin'}" — password ${(cfg?.adminPass) ? 'as chosen in the install form' : 'saved in /opt/siliconhost-apps/wordpress/.env (WP_ADMIN_PASS)'}. If the site URL shows localhost after install, align it from the VM console with: cd /opt/siliconhost-apps/wordpress && docker compose run --rm wp wp option update home http://<your-panel-host>:<hostPort> && docker compose run --rm wp wp option update siteurl http://<your-panel-host>:<hostPort>`,
    config: [
      { key: 'siteTitle', label: 'Site title', type: 'text', default: 'SiliconHost', pattern: '^[A-Za-z0-9 .,:!&()_-]{1,60}$' },
      { key: 'adminName', label: 'Admin username', type: 'text', default: 'admin', pattern: '^[a-zA-Z0-9_.-]{1,32}$', required: true },
      { key: 'adminEmail', label: 'Admin email', type: 'email' },
      { key: 'adminPass', label: 'Admin password', type: 'password', secret: true, autoGen: 12, help: 'Leave empty to auto-generate a strong password (it is shown in the installation summary).' },
    ],
  },
  {
    id: 'woocommerce',
    name: 'WooCommerce',
    category: 'CMS',
    description: 'WordPress with the WooCommerce storefront plugin pre-installed and activated via wp-cli. Configure the admin account during install or use generated values.',
    icon: 'shopping-cart',
    guestPort: 8081,
    exposure: 'Public HTTP after the VM restarts to apply its saved port mapping.',
    resultNote: (cfg) => `WordPress is set up with admin user "${cfg?.adminName || 'admin'}" and the password ${(cfg?.adminPass) ? 'you chose in the install form' : 'saved in /opt/siliconhost-apps/woocommerce/.env (WP_ADMIN_PASS)'}. WooCommerce is activated. The site URL is http://localhost:8081 — after restarting the VM, open the mapped URL, then align the address from the VM console with: cd /opt/siliconhost-apps/woocommerce && docker compose run --rm wp wp option update home http://<your-panel-host>:<hostPort> && docker compose run --rm wp wp option update siteurl http://<your-panel-host>:<hostPort>`,
    config: [
      { key: 'siteTitle', label: 'Site title', type: 'text', default: 'SiliconHost', pattern: '^[A-Za-z0-9 .,:!&()_-]{1,60}$' },
      { key: 'adminName', label: 'Admin username', type: 'text', default: 'admin', pattern: '^[a-zA-Z0-9_.-]{1,32}$', required: true },
      { key: 'adminEmail', label: 'Admin email', type: 'email' },
      { key: 'adminPass', label: 'Admin password', type: 'password', secret: true, autoGen: 12, help: 'Leave empty to auto-generate a strong password (it is shown in the installation summary).' },
    ],
  },
  {
    id: 'drupal',
    name: 'Drupal',
    category: 'CMS',
    description: 'Drupal 11 with MariaDB as a persistent Compose stack; finish the classic /install.php wizard in the browser.',
    icon: 'package',
    guestPort: 8082,
    exposure: 'Public HTTP after the VM restarts to apply its saved port mapping.',
    resultNote: 'Finish the Drupal installer at the mapped URL. Database host: database · name: drupal · user: drupal · password from /opt/siliconhost-apps/drupal/.env (DRUPAL_DB_PASSWORD).',
  },
  {
    id: 'joomla',
    name: 'Joomla',
    category: 'CMS',
    description: 'Joomla 5 with MariaDB in Compose, prepared with database credentials for the browser setup wizard.',
    icon: 'layout-dashboard',
    guestPort: 8083,
    exposure: 'Public HTTP after the VM restarts to apply its saved port mapping.',
    resultNote: 'Finish the Joomla installer at the mapped URL. Database host: database · name: joomla · user: joomla · password from /opt/siliconhost-apps/joomla/.env (JOOMLA_DB_PASSWORD).',
  },
  {
    id: 'prestashop',
    name: 'PrestaShop',
    category: 'CMS',
    description: 'PrestaShop store with a MariaDB sidecar in Compose; complete the web installer to open your shop.',
    icon: 'store',
    guestPort: 8084,
    exposure: 'Public HTTP after the VM restarts to apply its saved port mapping.',
    resultNote: 'Finish the PrestaShop installer at the mapped URL. Database host: database · name: prestashop · user: prestashop · password from /opt/siliconhost-apps/prestashop/.env (PRESTASHOP_DB_PASSWORD).',
  },
  {
    id: 'mediawiki',
    name: 'MediaWiki',
    category: 'CMS',
    description: 'MediaWiki with MariaDB in Compose; the web wizard generates the wiki configuration.',
    icon: 'book-open',
    guestPort: 8085,
    exposure: 'Public HTTP after the VM restarts to apply its saved port mapping.',
    resultNote: 'Finish the MediaWiki installer at the mapped URL. Database host: database · name: wikidb · user: wiki · password from /opt/siliconhost-apps/mediawiki/.env (WIKI_DB_PASSWORD). When the wizard offers LocalSettings.php, download it and copy it into the wiki container from the VM console: docker cp LocalSettings.php <mediawiki-container>:/var/www/html/LocalSettings.php',
  },

  // ── Control panels & management ─────────────────────────────────────────
  {
    id: 'cloudpanel',
    name: 'CloudPanel 2',
    category: 'Control panel',
    description: 'The free and open CloudPanel 2 control panel for PHP-app hosting. Debian 11/12 and Ubuntu 22.04+ guests only.',
    icon: 'server-cog',
    guestPort: 8443,
    scheme: 'https',
    exposure: 'Public HTTPS on guest port 8443. Expect a browser warning for the self-signed certificate.',
    resultNote: 'CloudPanel setup wizard opens at the mapped URL. Install this on the VM alone: CloudPanel uses guest port 8443 and conflicts with the Plesk one-click on the same VM.',
    timeoutMs: LONG_INSTALLER_TIMEOUT,
    config: [
      { key: 'userName', label: 'CloudPanel admin username', type: 'text', default: 'admin', pattern: '^[a-zA-Z0-9_.-]{1,32}$', required: true },
      { key: 'userEmail', label: 'Admin email', type: 'email', required: true },
      { key: 'userPass', label: 'Admin password', type: 'password', secret: true, autoGen: 12, help: 'Leave empty to auto-generate a strong password for the panel admin (it is shown in the installation summary).' },
    ],
  },
  {
    id: 'webmin',
    name: 'Webmin',
    category: 'Control panel',
    description: 'Webmin system administration panel from its official apt repository; manage users, services, and files over HTTPS.',
    icon: 'wrench',
    guestPort: 10000,
    scheme: 'https',
    exposure: 'Public HTTPS on guest port 10000. The browser will warn about the self-signed certificate.',
  },
  {
    id: 'cpanel',
    name: 'cPanel / WHM',
    category: 'Control panel',
    description: 'Official cPanel & WHM installer. Requires an AlmaLinux, Rocky Linux, or Ubuntu 20.04/22.04 guest with at least 1.5 GB RAM, and brings its own licensing model: it activates a 15-day trial, afterwards a paid cPanel license is required.',
    icon: 'key-round',
    guestPort: 2087,
    scheme: 'https',
    exposure: 'Public HTTPS on guest port 2087 (WHM). cPanel user accounts are served on guest port 2083, which you can map manually after creating them.',
    resultNote: 'WHM opens at https://<your-panel-host>:<hostPort> after the VM restarts; sign in with the VM root password to finish setup and create cPanel accounts. The cPanel user port 2083 only becomes reachable when you add that mapping in VM Settings. The license activates a free 15-day trial; continue with a purchased license or re-image the VM afterwards.',
    timeoutMs: LONG_INSTALLER_TIMEOUT,
  },
  {
    id: 'plesk',
    name: 'Plesk',
    category: 'Control panel',
    description: 'The official Plesk one-click installer for Ubuntu, Debian, or AlmaLinux guests. Plesk Obsidian starts with a 14-day trial licence; obtain a license key for production use.',
    icon: 'globe',
    guestPort: 8443,
    scheme: 'https',
    exposure: 'Public HTTPS on guest port 8443. Not installable next to CloudPanel 2 on the same VM (same port).',
    resultNote: 'Plesk is reachable at https://<your-panel-host>:<hostPort> after the VM restarts. Sign in with the server root password, then apply your Plesk license key (BYOL) under Security & License.',
    timeoutMs: LONG_INSTALLER_TIMEOUT,
  },

  // ── Dev & DevOps ─────────────────────────────────────────────────────────
  {
    id: 'docker',
    name: 'Docker Engine',
    category: 'Dev & DevOps',
    description: 'Docker Engine with the Compose v2 plugin, installed from the distro repositories and enabled at boot.',
    icon: 'container',
    exposure: 'Private. Nothing is forwarded; map container ports from VM Settings when you publish services.',
  },
  {
    id: 'nodejs',
    name: 'Node.js 22',
    category: 'Dev & DevOps',
    description: 'Node.js 22 LTS and npm from the official NodeSource repository, ready for application deployments.',
    icon: 'terminal',
    exposure: 'Private developer tooling. Nothing is exposed; forward your app ports from VM Settings.',
  },
  {
    id: 'laravel',
    name: 'Laravel',
    category: 'Dev & DevOps',
    description: 'A fresh Laravel application created with Composer and served with `php artisan serve`; uses SQLite out of the box.',
    icon: 'layers',
    guestPort: 8100,
    exposure: 'Public HTTP on guest port 8100 after the VM restarts (development server).',
    resultNote: 'The Laravel app lives in /opt/siliconhost-apps/laravel/app and serves on the mapped port. Database is SQLite at database/database.sqlite; edit .env for MySQL/PostgreSQL.',
    timeoutMs: LONG_INSTALLER_TIMEOUT,
  },
  {
    id: 'lamp',
    name: 'LAMP stack',
    category: 'Dev & DevOps',
    description: 'Apache, MariaDB, and PHP with distro defaults; includes a phpinfo page for quick verification.',
    icon: 'lamp',
    guestPort: 80,
    exposure: 'Public HTTP on guest port 80. Shared with LEMP, GitLab, Jitsi-style stacks — one web stack per VM on port 80.',
    resultNote: 'Database root connects with: mariadb (or mariadb -u root -p) inside the VM. Apache document root: /var/www/html. Quick verify: http://<your-panel-host>:<hostPort>/vpanel-phpinfo.php',
  },
  {
    id: 'lemp',
    name: 'LEMP stack',
    category: 'Dev & DevOps',
    description: 'Nginx, MariaDB, and PHP-FPM with distro defaults; includes a phpinfo page for quick verification.',
    icon: 'server',
    guestPort: 80,
    exposure: 'Public HTTP on guest port 80. Shared with LAMP, GitLab and other native port-80 stacks.',
    resultNote: 'Database root connects with: mariadb (or mariadb -u root -p) inside the VM. Nginx document root: /var/www/html. Quick verify: http://<your-panel-host>:<hostPort>/vpanel-phpinfo.php',
  },
  {
    id: 'openlitespeed',
    name: 'OpenLiteSpeed',
    category: 'Dev & DevOps',
    description: 'OpenLiteSpeed web server and PHP 8.3 (lsphp83) from the official LiteSpeed repository, plus a set WebAdmin password.',
    icon: 'zap',
    guestPort: 8088,
    exposure: 'Public HTTP on guest port 8088. WebAdmin stays private on guest port 7080 (SSH tunnel).',
    resultNote: 'Sample web is at http://<your-panel-host>:<hostPort> after the restart. WebAdmin runs on guest port 7080 — create an SSH tunnel with ssh -N -L 7080:127.0.0.1:7080 and sign in with the credentials stored at /opt/siliconhost-apps/openlitespeed/admin-credentials.txt.',
  },
  {
    id: 'gitlab',
    name: 'GitLab CE',
    category: 'Dev & DevOps',
    description: 'GitLab Community Edition (Omnibus) from the official GitLab package repository. Requires a VM with at least 4 GB RAM and takes a while to install.',
    icon: 'git-branch',
    guestPort: 80,
    exposure: 'Public HTTP on guest port 80. Not installable next to LAMP/LEMP on the same VM (same port).',
    resultNote: 'GitLab opens at http://<your-panel-host>:<hostPort> after the restart. Sign in as root with the one-time password from the VM console: cat /etc/gitlab/initial_root_password (valid for 24 hours — change it after the first login). If you set an initial root password in the install form, use that value instead.',
    timeoutMs: LONG_INSTALLER_TIMEOUT,
    config: [
      { key: 'rootPass', label: 'Initial root password', type: 'password', secret: true, min: 8, help: 'Optional. Sets the initial root password (8+ characters). Leave empty to use the one-time password file that GitLab generates.' },
    ],
  },
  {
    id: 'k3s',
    name: 'K3s',
    category: 'Dev & DevOps',
    description: 'The official lightweight Kubernetes distribution (k3s) with its embedded SQLite datastore and Traefik ingress.',
    icon: 'boxes',
    exposure: 'Private cluster on the guest. Manage it over SSH with: k3s kubectl get nodes (kubeconfig at /etc/rancher/k3s/k3s.yaml).',
  },
  {
    id: 'miniconda',
    name: 'Miniconda',
    category: 'Dev & DevOps',
    description: 'The official Miniconda Python environment manager, installed silently into /opt/miniconda3 with conda on PATH.',
    icon: 'flask-conical',
    exposure: 'Private developer tooling. Nothing is exposed; forward Jupyter or service ports from VM Settings.',
  },
  {
    id: 'portainer',
    name: 'Portainer CE',
    category: 'Dev & DevOps',
    description: 'Portainer Community Edition managing the guest Docker Engine through Compose, with persistent data.',
    icon: 'dock',
    guestPort: 9443,
    scheme: 'https',
    exposure: 'Public HTTPS on guest port 9443; the browser will show its generated certificate warning.',
  },

  // ── Databases & AI ───────────────────────────────────────────────────────
  {
    id: 'postgresql',
    name: 'PostgreSQL',
    category: 'Databases & AI',
    description: 'PostgreSQL server with contrib tooling from the distro repositories, enabled at boot.',
    icon: 'database',
    exposure: 'Private. PostgreSQL stays guest-local; use an SSH tunnel (guest port 5432) for remote clients.',
    resultNote: 'Connect locally with sudo -u postgres psql inside the VM. For a desktop client, tunnel from your computer: ssh -N -L 5432:127.0.0.1:5432 -p <ssh-port> <username>@<your-panel-host>',
  },
  {
    id: 'mariadb',
    name: 'MariaDB',
    category: 'Databases & AI',
    description: 'MariaDB server from the distro repositories, enabled at boot, with root socket authentication.',
    icon: 'database',
    exposure: 'Private. MariaDB stays guest-local; use an SSH tunnel (guest port 3306) for remote clients.',
    resultNote: 'Connect locally with sudo mysql inside the VM. For a desktop client, tunnel from your computer: ssh -N -L 3306:127.0.0.1:3306 -p <ssh-port> <username>@<your-panel-host>',
  },
  {
    id: 'redis',
    name: 'Redis',
    category: 'Databases & AI',
    description: 'Redis caching server from the distro repositories, enabled at boot and reachable from the guest only.',
    icon: 'database',
    exposure: 'Private. Redis stays guest-local; use an SSH tunnel (guest port 6379) for remote clients.',
    resultNote: 'Verify with redis-cli ping inside the VM. For remote access, tunnel from your computer: ssh -N -L 6379:127.0.0.1:6379 -p <ssh-port> <username>@<your-panel-host>',
  },
  {
    id: 'comfyui',
    name: 'ComfyUI',
    category: 'Databases & AI',
    description: 'The official ComfyUI node-based image generator, cloned from its GitHub source and served CPU-only inside the guest.',
    icon: 'brain',
    guestPort: 8188,
    exposure: 'Public HTTP on guest port 8188 after the VM restarts. CPU inference; expect slow generations and needs several GB of RAM.',
    timeoutMs: LONG_INSTALLER_TIMEOUT,
  },
  {
    id: 'librechat',
    name: 'LibreChat',
    category: 'Databases & AI',
    description: 'LibreChat multi-provider AI chat UI, built from the official repository with its bundled MongoDB and Meilisearch services.',
    icon: 'message-circle',
    guestPort: 3080,
    exposure: 'Public HTTP on guest port 3080 after the VM restarts.',
    resultNote: 'LibreChat opens at http://<your-panel-host>:<hostPort> after the restart. Create your account in the UI and configure a model provider key (BYOK) in the app settings. Edit /opt/siliconhost-apps/librechat/.env for server-level configuration.',
    timeoutMs: LONG_INSTALLER_TIMEOUT,
  },

  // ── VPN & security ───────────────────────────────────────────────────────
  {
    id: 'wireguard',
    name: 'WireGuard',
    category: 'VPN & security',
    description: 'WireGuard server with a generated peer profile at /etc/wireguard/client.conf and NAT forwarding inside the guest.',
    icon: 'wifi',
    exposure: 'Private server-side setup. The panel maps TCP only, so remote clients need a manual UDP forward on guest port 51820 before they can connect.',
    resultNote: 'Server profile: /etc/wireguard/wg0.conf (active now and enabled at boot). Client profile: /etc/wireguard/client.conf — replace <PANEL_HOST> in its Endpoint with the panel host address. WireGuard speaks UDP; the panel port-mapping dialog creates TCP forwards only, so add a UDP forward for guest port 51820 at the hypervisor/network layer before connecting clients.',
  },
  {
    id: 'openvpn-as',
    name: 'OpenVPN Access Server',
    category: 'VPN & security',
    description: 'The official OpenVPN Access Server (WebAdmin 943 + data channel 443). Free for two connections; production rolls need an OpenVPN license (BYOL).',
    icon: 'lock',
    guestPort: 943,
    scheme: 'https',
    exposure: 'Public HTTPS on guest port 943 (Admin UI). The client data channel on guest port 443 needs an additional manual mapping.',
    resultNote: 'Admin UI after the restart: https://<your-panel-host>:<hostPort>/admin. Sign-in credentials are saved at /opt/siliconhost-apps/openvpn-as/access.txt (read it over SSH). VPN client connections additionally need a manual mapping from host side to guest port 443. Two client connections are free; beyond that apply an OpenVPN Access Server license (BYOL).',
    timeoutMs: LONG_INSTALLER_TIMEOUT,
    config: [
      { key: 'adminUser', label: 'Admin username', type: 'text', default: 'openvpn', pattern: '^[a-zA-Z0-9_.-]{1,32}$', required: true },
      { key: 'adminPass', label: 'Admin password', type: 'password', secret: true, autoGen: 12, help: 'Leave empty to auto-generate a strong password (saved to access.txt and shown in the installation summary).' },
    ],
  },

  // ── Media & communication ────────────────────────────────────────────────
  {
    id: 'jitsi',
    name: 'Jitsi Meet',
    category: 'Media & communication',
    description: 'The official Jitsi Meet video-conferencing stack (nginx, prosody, jicofo, videobridge) installed silently with defaults.',
    icon: 'video',
    guestPort: 443,
    scheme: 'https',
    exposure: 'Public HTTPS on guest port 443. Without an FQDN certificate the browser shows a warning; rooms work over the IP.',
    resultNote: 'Open the mapped URL after restarting the VM. The installer used the guest hostname with a self-signed certificate, so accept the browser warning. For public domains, add the FQDN and Let\'s Encrypt certificates inside the VM afterwards (jitsi-meet web config includes an LE helper).',
    timeoutMs: LONG_INSTALLER_TIMEOUT,
  },
  {
    id: 'azuracast',
    name: 'AzuraCast',
    category: 'Media & communication',
    description: 'The official AzuraCast web radio manager via its Docker installer; provides station dashboards, playlists, and Icecast streams.',
    icon: 'radio',
    guestPort: 80,
    exposure: 'Public HTTP on guest port 80. Not installable next to LAMP/LEMP/GitLab on the same VM (same port).',
    resultNote: 'AzuraCast opens at http://<your-panel-host>:<hostPort> after the restart. Create the first admin account in the setup wizard. Icecast streaming uses the same listener ports configured inside the app.',
    timeoutMs: LONG_INSTALLER_TIMEOUT,
  },
  {
    id: 'owncast',
    name: 'Owncast',
    category: 'Media & communication',
    description: 'Self-hosted live streaming with an embedded web player, downloaded from the official Owncast GitHub release and run as a systemd service.',
    icon: 'screen-share',
    guestPort: 8080,
    exposure: 'Public HTTP on guest port 8080. Conflicts with the WordPress app on the same VM (same guest port).',
    resultNote: 'The embedded player opens at http://<your-panel-host>:<hostPort> after the restart. Point your broadcasting software (OBS etc.) at RTMP ingest rtmp://<your-panel-host>:<rtmp-host-port>/live and add that manual mapping (guest port 1935) in VM Settings.',
  },

  // ── Game servers ─────────────────────────────────────────────────────────
  {
    id: 'minecraft',
    name: 'Minecraft Java',
    category: 'Game server',
    description: 'Minecraft Java Edition server driven by the itzg/minecraft-server Docker image; accepts the Mojang EULA and stores the world in the VM.',
    icon: 'blocks',
    guestPort: 25565,
    exposure: 'Public on guest port 25565 after the VM restarts. First start downloads the server files and can take several minutes.',
    resultNote: 'Join with a Minecraft Java client: add the server <your-panel-host>:<hostPort> after restarting the VM. The world lives in /opt/siliconhost-apps/minecraft/data (default memory 2 GB — size the VM accordingly). The installer sets EULA=TRUE, acknowledging the Minecraft EULA on your behalf; review it at minecraft.net/eula. Watch startup progress from the VM console: docker logs -f minecraft.',
    timeoutMs: LONG_INSTALLER_TIMEOUT,
    config: [
      { key: 'mcVersion', label: 'Server version', type: 'text', default: 'latest', pattern: '^[A-Za-z0-9._-]{1,40}$', help: 'The itzg/minecraft-server VERSION value: latest, 1.21, 1.20.6, SNAPSHOT …' },
      { key: 'mcMemory', label: 'Memory limit', type: 'select', options: ['2G', '3G', '4G', '6G'], default: '2G', help: 'Size this to the VM RAM; the JDK heap needs headroom.' },
    ],
  },

  // ── AI assistant ─────────────────────────────────────────────────────────
  {
    id: 'openclaw',
    name: 'OpenClaw',
    category: 'AI assistant',
    description: 'Builds and runs the official OpenClaw Docker image with token authentication enabled.',
    icon: 'bot',
    exposure: 'Private by default. Use an SSH tunnel; no public host port is opened.',
  },
];

// ─── Shared guest helpers ───────────────────────────────────────────────────

function dockerSetup() {
  return `set -euo pipefail
if ! command -v apt-get >/dev/null 2>&1; then
  echo "This reviewed installer currently supports Debian and Ubuntu guests." >&2
  exit 1
fi
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 git openssl
systemctl enable --now docker
`;
}

function requireDebianGuest() {
  return `if ! command -v apt-get >/dev/null 2>&1; then
  echo "This reviewed installer requires a Debian or Ubuntu guest." >&2
  exit 1
fi
`;
}

function requireDistroIds(allowed) {
  return `. /etc/os-release
case "$ID" in ${allowed}) ;; *) echo "This reviewed installer requires one of these guests: ${allowed}." >&2; exit 1;; esac
`;
}

function guestRamKb() {
  return `RAM_KB=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
`;
}

// ─── CMS installers ─────────────────────────────────────────────────────────

function wordpressScript(cfg = {}) {
  const emailActive = typeof cfg.adminEmail === 'string' && cfg.adminEmail.includes('@');
  return `${dockerSetup()}
APP_DIR=${APP_ROOT}/wordpress
APP_PORT=8080
mkdir -p "$APP_DIR"
cd "$APP_DIR"
if [ ! -f .env ]; then
  printf 'APP_PORT=%s\\nDB_NAME=wordpress\\nDB_USER=wordpress\\nDB_PASSWORD=%s\\nDB_ROOT_PASSWORD=%s\\n' "$APP_PORT" "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > .env
  chmod 600 .env
fi
cat > compose.yaml <<'YAML'
services:
  database:
    image: mariadb:11.4
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: \${DB_NAME}
      MARIADB_USER: \${DB_USER}
      MARIADB_PASSWORD: \${DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - database:/var/lib/mysql
  wordpress:
    image: wordpress:php8.3-apache
    restart: unless-stopped
    depends_on:
      - database
    ports:
      - "0.0.0.0:\${APP_PORT}:80"
    environment:
      WORDPRESS_DB_HOST: database:3306
      WORDPRESS_DB_NAME: \${DB_NAME}
      WORDPRESS_DB_USER: \${DB_USER}
      WORDPRESS_DB_PASSWORD: \${DB_PASSWORD}
    volumes:
      - wordpress:/var/www/html
  wp:
    image: wordpress:cli
    restart: "no"
    depends_on:
      - wordpress
    user: "33:33"
    environment:
      APP_PORT: \${APP_PORT}
      WP_TITLE: ${composeEnvValue(cfg.siteTitle || 'SiliconHost')}
      WP_ADMIN_USER: ${composeEnvValue(cfg.adminName || 'admin')}
      WP_ADMIN_PASS: ${composeEnvValue(cfg.adminPass || genPassword(12))}${emailActive ? `
      WP_ADMIN_EMAIL: ${composeEnvValue(cfg.adminEmail)}` : ''}
    volumes:
      - wordpress:/var/www/html
    entrypoint: ["/bin/sh", "-c"]
    command: >
      i=0;
      until wp core is-installed 2>/dev/null; do
        i=$$((i+1));
        if [ "$$i" -ge 60 ]; then echo "WordPress did not come up for wp-cli in time." >&2; exit 1; fi;
        sleep 5;
      done;
      wp core install --url="http://localhost:\${APP_PORT}" --title="$$WP_TITLE" --admin_user="$$WP_ADMIN_USER" --admin_password="$$WP_ADMIN_PASS" --skip-email${emailActive ? ' --admin_email="$$WP_ADMIN_EMAIL"' : ''};
volumes:
  database:
  wordpress:
YAML
docker compose up -d
docker compose wait wp || { echo "The WordPress one-click setup failed. The stack is running; finish setup in the browser." >&2; exit 1; }
echo "WordPress containers are running on guest port $APP_PORT."
`;
}

function woocommerceScript(cfg = {}) {
  const emailActive = typeof cfg.adminEmail === 'string' && cfg.adminEmail.includes('@');
  return `${dockerSetup()}
APP_DIR=${APP_ROOT}/woocommerce
APP_PORT=8081
mkdir -p "$APP_DIR"
cd "$APP_DIR"
if [ ! -f .env ]; then
  printf 'APP_PORT=%s\\nDB_NAME=wordpress\\nDB_USER=wordpress\\nDB_PASSWORD=%s\\nDB_ROOT_PASSWORD=%s\\nWP_ADMIN_PASS=%s\\n' "$APP_PORT" "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" "$(openssl rand -hex 16)" > .env
  chmod 600 .env
fi
cat > compose.yaml <<'YAML'
services:
  database:
    image: mariadb:11.4
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: \${DB_NAME}
      MARIADB_USER: \${DB_USER}
      MARIADB_PASSWORD: \${DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - database:/var/lib/mysql
  wordpress:
    image: wordpress:php8.3-apache
    restart: unless-stopped
    depends_on:
      - database
    ports:
      - "0.0.0.0:\${APP_PORT}:80"
    environment:
      WORDPRESS_DB_HOST: database:3306
      WORDPRESS_DB_NAME: \${DB_NAME}
      WORDPRESS_DB_USER: \${DB_USER}
      WORDPRESS_DB_PASSWORD: \${DB_PASSWORD}
    volumes:
      - wordpress:/var/www/html
  wp:
    image: wordpress:cli
    restart: "no"
    depends_on:
      - wordpress
    user: "33:33"
    environment:
      APP_PORT: \${APP_PORT}
      WP_TITLE: ${composeEnvValue(cfg.siteTitle || 'SiliconHost')}
      WP_ADMIN_USER: ${composeEnvValue(cfg.adminName || 'admin')}
      WP_ADMIN_PASS: ${composeEnvValue(cfg.adminPass || genPassword(12))}${emailActive ? `
      WP_ADMIN_EMAIL: ${composeEnvValue(cfg.adminEmail)}` : ''}
    volumes:
      - wordpress:/var/www/html
    entrypoint: ["/bin/sh", "-c"]
    command: >
      i=0;
      until wp core is-installed 2>/dev/null; do
        i=$$((i+1));
        if [ "$$i" -ge 60 ]; then echo "WordPress did not come up for wp-cli in time." >&2; exit 1; fi;
        sleep 5;
      done;
      wp core install --url="http://localhost:\${APP_PORT}" --title="$$WP_TITLE" --admin_user="$$WP_ADMIN_USER" --admin_password="$$WP_ADMIN_PASS" --skip-email${emailActive ? ' --admin_email="$$WP_ADMIN_EMAIL"' : ''};
      wp plugin install woocommerce --activate
volumes:
  database:
  wordpress:
YAML
docker compose up -d
docker compose wait wp || { echo "The WordPress one-click setup failed. The stack is running; finish setup in the browser." >&2; exit 1; }
echo "WordPress with WooCommerce is running on guest port $APP_PORT."
`;
}

function drupalScript() {
  return `${dockerSetup()}
APP_DIR=${APP_ROOT}/drupal
APP_PORT=8082
mkdir -p "$APP_DIR/sites"
cd "$APP_DIR"
if [ ! -f .env ]; then
  printf 'DRUPAL_DB_PASSWORD=%s\\nDB_ROOT_PASSWORD=%s\\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > .env
  chmod 600 .env
fi
cat > compose.yaml <<'YAML'
services:
  database:
    image: mariadb:11.4
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: drupal
      MARIADB_USER: drupal
      MARIADB_PASSWORD: \${DRUPAL_DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - database:/var/lib/mysql
  drupal:
    image: drupal:11
    restart: unless-stopped
    depends_on:
      - database
    ports:
      - "0.0.0.0:8082:80"
    volumes:
      - ./sites:/var/www/html/sites
volumes:
  database:
YAML
docker compose up -d
echo "Drupal 11 and MariaDB are running on guest port $APP_PORT. Finish /install.php in the browser."
`;
}

function joomlaScript() {
  return `${dockerSetup()}
APP_DIR=${APP_ROOT}/joomla
mkdir -p "$APP_DIR"
cd "$APP_DIR"
if [ ! -f .env ]; then
  printf 'JOOMLA_DB_PASSWORD=%s\\nDB_ROOT_PASSWORD=%s\\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > .env
  chmod 600 .env
fi
cat > compose.yaml <<'YAML'
services:
  database:
    image: mariadb:11.4
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: joomla
      MARIADB_USER: joomla
      MARIADB_PASSWORD: \${JOOMLA_DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - database:/var/lib/mysql
  joomla:
    image: joomla:5-apache
    restart: unless-stopped
    depends_on:
      - database
    ports:
      - "0.0.0.0:8083:80"
    environment:
      JOOMLA_DB_HOST: database
      JOOMLA_DB_USER: joomla
      JOOMLA_DB_PASSWORD: \${JOOMLA_DB_PASSWORD}
      JOOMLA_DB_NAME: joomla
volumes:
  database:
YAML
docker compose up -d
echo "Joomla 5 and MariaDB are running on guest port 8083. Finish the browser setup wizard."
`;
}

function prestashopScript() {
  return `${dockerSetup()}
APP_DIR=${APP_ROOT}/prestashop
mkdir -p "$APP_DIR"
cd "$APP_DIR"
if [ ! -f .env ]; then
  printf 'PRESTASHOP_DB_PASSWORD=%s\\nDB_ROOT_PASSWORD=%s\\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > .env
  chmod 600 .env
fi
cat > compose.yaml <<'YAML'
services:
  database:
    image: mariadb:11.4
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: prestashop
      MARIADB_USER: prestashop
      MARIADB_PASSWORD: \${PRESTASHOP_DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - database:/var/lib/mysql
  prestashop:
    image: prestashop/prestashop:latest
    restart: unless-stopped
    depends_on:
      - database
    ports:
      - "0.0.0.0:8084:80"
volumes:
  database:
YAML
docker compose up -d
echo "PrestaShop and MariaDB are running on guest port 8084. Finish the browser installer."
`;
}

function mediawikiScript() {
  return `${dockerSetup()}
APP_DIR=${APP_ROOT}/mediawiki
mkdir -p "$APP_DIR"
cd "$APP_DIR"
if [ ! -f .env ]; then
  printf 'WIKI_DB_PASSWORD=%s\\nDB_ROOT_PASSWORD=%s\\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > .env
  chmod 600 .env
fi
cat > compose.yaml <<'YAML'
services:
  database:
    image: mariadb:11.4
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: wikidb
      MARIADB_USER: wiki
      MARIADB_PASSWORD: \${WIKI_DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - database:/var/lib/mysql
  mediawiki:
    image: mediawiki:latest
    restart: unless-stopped
    depends_on:
      - database
    ports:
      - "0.0.0.0:8085:80"
volumes:
  database:
YAML
docker compose up -d
echo "MediaWiki and MariaDB are running on guest port 8085. Finish the browser installer and add LocalSettings.php."
`;
}

// ─── Control panel installers ───────────────────────────────────────────────

function cloudpanelScript(cfg = {}) {
  const panUser = cfg.userName || 'admin';
  const panEmail = cfg.userEmail || 'admin@cloudpanel.local';
  const panPass = cfg.userPass || genPassword(12);
  return `${requireDebianGuest()}
. /etc/os-release
if [ "$ID" = "debian" ]; then
  case "$VERSION_ID" in 11|12|13) ;; *) echo "CloudPanel 2 expects Debian 11/12/13." >&2; exit 1;; esac
elif [ "$ID" = "ubuntu" ]; then
  case "$VERSION_ID" in 22.04|24.04) ;; *) echo "CloudPanel 2 expects Ubuntu 22.04 or 24.04." >&2; exit 1;; esac
else
  echo "CloudPanel 2 expects Debian 11/12/13 or Ubuntu 22.04/24.04." >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
curl -sSL https://installer.cloudpanel.io/ce/v2/install.sh | bash
if command -v clpctl >/dev/null 2>&1; then
  clpctl user:add --user-name=${shQuote(panUser)} --email=${shQuote(panEmail)} --role=admins --password=${shQuote(panPass)} 2>/dev/null || echo "The panel admin could not be seeded automatically; open CloudPanel on guest port 8443 and finish admin setup in the browser."
else
  echo "clpctl was not found; open CloudPanel on guest port 8443 and finish admin setup in the browser."
fi
echo "CloudPanel 2 is installed. Admin setup opens on guest port 8443."
`;
}

function webminScript() {
  return `${requireDebianGuest()}
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y curl gnupg
mkdir -p /usr/share/keyrings
curl -fsSL https://download.webmin.com/developers-key.asc | gpg --dearmor -o /usr/share/keyrings/webmin-developers-authors.gpg
echo "deb [signed-by=/usr/share/keyrings/webmin-developers-authors.gpg] https://download.webmin.com/download/newkey apt contrib" > /etc/apt/sources.list.d/webmin.list
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y webmin
systemctl enable --now webmin
echo "Webmin is installed on guest port 10000."
`;
}

function cpanelScript() {
  return `${requireDistroIds('almalinux|rocky|centos|ubuntu')}
if [ "$ID" = "ubuntu" ]; then
  case "$VERSION_ID" in 20.04|22.04) ;; *) echo "cPanel supports Ubuntu 20.04 or 22.04 guests. Use an AlmaLinux or Rocky guest instead." >&2; exit 1;; esac
fi
${guestRamKb()}
if [ "$RAM_KB" -lt 1400000 ]; then echo "cPanel needs a VM with at least 1.5 GB of RAM. Reshape this VM and retry." >&2; exit 1; fi
cd /tmp && curl -o latest -L https://cpanel.net/latest && sh latest
echo "cPanel & WHM are installed. Complete the WHM setup on port 2087 first."
`;
}

function pleskScript() {
  return `${requireDistroIds('debian|ubuntu|almalinux|rocky|centos')}
export DEBIAN_FRONTEND=noninteractive
curl -fsSL https://autoinstall.plesk.com/one-click-installer | sh
echo "Plesk is installed on guest port 8443."
`;
}

// ─── Dev & DevOps installers ────────────────────────────────────────────────

function dockerScript() {
  return `${dockerSetup()}
docker --version
docker compose version
echo "Docker Engine and Compose v2 are enabled at boot."
`;
}

function nodejsScript() {
  return `${requireDebianGuest()}
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
node --version
npm --version
echo "Node.js 22 and npm are installed."
`;
}

function laravelScript() {
  return `${requireDebianGuest()}
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y php-cli php-mbstring php-xml php-mysql php-curl php-zip php-sqlite3 php-gd php-intl php-bcmath composer curl unzip
mkdir -p ${APP_ROOT}/laravel
cd ${APP_ROOT}/laravel
PHPV=$(php -r 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;')
COMPONENT=laravel/laravel
if [ "$PHPV" = "8.1" ]; then COMPONENT='laravel/laravel:^10.0'; fi
composer create-project --no-interaction "$COMPONENT" app
cd app
sed -i 's/^DB_CONNECTION=.*/DB_CONNECTION=sqlite/' .env
touch database/database.sqlite
php artisan migrate --force
cat > /etc/systemd/system/vpanel-laravel.service <<'UNIT'
[Unit]
Description=vPanel Laravel
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_ROOT}/laravel/app
ExecStart=/usr/bin/php artisan serve --host=0.0.0.0 --port=8100
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now vpanel-laravel
echo "Laravel is running on guest port 8100."
`;
}

function phpInfoFile() {
  return `printf '<?php phpinfo();\\n' > /var/www/html/vpanel-phpinfo.php
`;
}

function lampScript() {
  return `${requireDebianGuest()}
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y apache2 mariadb-server php libapache2-mod-php php-mysql curl
systemctl enable --now apache2
systemctl enable --now mariadb
${phpInfoFile()}
systemctl reload apache2
echo "LAMP is running on guest port 80 with /vpanel-phpinfo.php."
`;
}

function lempScript() {
  return `${requireDebianGuest()}
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx mariadb-server php-fpm php-mysql curl
systemctl enable --now nginx
systemctl enable --now mariadb
PHP_SOCK=$(ls /run/php/php*-fpm.sock 2>/dev/null | head -n 1)
if [ -z "$PHP_SOCK" ]; then echo "No PHP-FPM socket was found." >&2; exit 1; fi
cat > /etc/nginx/sites-available/default <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    root /var/www/html;
    index index.php index.html index.htm;

    location / {
        try_files $uri $uri/ =404;
    }

    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:__PHP_SOCK__;
    }
}
NGINX
sed -i "s#__PHP_SOCK__#\${PHP_SOCK}#" /etc/nginx/sites-available/default
${phpInfoFile()}
nginx -t && systemctl reload nginx
echo "LEMP is running on guest port 80 with /vpanel-phpinfo.php."
`;
}

function openlitespeedScript() {
  return `${requireDebianGuest()}
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y wget curl
wget -qO- https://repo.litespeed.sh | bash -
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y openlitespeed lsphp83
mkdir -p ${APP_ROOT}/openlitespeed
WEB_USER=admin
WEB_PASS=$(openssl rand -hex 12)
printf '%s\\n%s\\n%s\\n' "$WEB_USER" "$WEB_PASS" "$WEB_PASS" | /usr/local/lsws/admin/misc/admpass.sh >/dev/null 2>&1 || true
printf 'WebAdmin user: %s\\nWebAdmin password: %s\\n' "$WEB_USER" "$WEB_PASS" > ${APP_ROOT}/openlitespeed/admin-credentials.txt
chmod 600 ${APP_ROOT}/openlitespeed/admin-credentials.txt
systemctl enable --now lsws
echo "OpenLiteSpeed web is on guest port 8088; WebAdmin stays on guest port 7080 (SSH tunnel)."
`;
}

function gitlabScript(cfg = {}) {
  const rootPass = cfg.rootPass || '';
  return `${requireDebianGuest()}
${guestRamKb()}
if [ "$RAM_KB" -lt 3500000 ]; then echo "GitLab CE needs a VM with at least 4 GB of RAM. Reshape this VM and retry." >&2; exit 1; fi
export DEBIAN_FRONTEND=noninteractive
${rootPass ? `export GITLAB_ROOT_PASSWORD=${shQuote(rootPass)}\n` : ''}if ! dpkg -s gitlab-ce >/dev/null 2>&1; then
  curl -fsSL https://packages.gitlab.com/install/repositories/gitlab/gitlab-ce/script.deb.sh | bash -
  EXTERNAL_URL="http://$(hostname)" apt-get install -y gitlab-ce
fi
${rootPass ? 'echo "GitLab CE is installed on guest port 80. Sign in as root with the initial root password you set in the install form."' : 'echo "GitLab CE is installed on guest port 80. Root one-time password: cat /etc/gitlab/initial_root_password"'}
`;
}

function k3sScript() {
  return `${requireDebianGuest()}
curl -sfL https://get.k3s.io | sh -s - --write-kubeconfig-mode "644"
sleep 10
k3s kubectl get nodes || true
echo "k3s is installed. Kubeconfig: /etc/rancher/k3s/k3s.yaml (get nodes with: k3s kubectl get nodes)"
`;
}

function minicondaScript() {
  return `${requireDebianGuest()}
DEBIAN_FRONTEND=noninteractive apt-get install -y wget
wget -q https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -O /tmp/miniconda.sh
bash /tmp/miniconda.sh -b -p /opt/miniconda3
rm -f /tmp/miniconda.sh
ln -sf /opt/miniconda3/bin/conda /usr/local/bin/conda
conda --version
echo "Miniconda is installed in /opt/miniconda3 with conda on the PATH."
`;
}

function portainerScript() {
  return `${dockerSetup()}
APP_DIR=${APP_ROOT}/portainer
mkdir -p "$APP_DIR"
cd "$APP_DIR"
cat > compose.yaml <<'YAML'
services:
  portainer:
    image: portainer/portainer-ce:latest
    restart: unless-stopped
    ports:
      - "0.0.0.0:9443:9443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - portainer_data:/data
volumes:
  portainer_data:
YAML
docker compose up -d
echo "Portainer CE is running on guest port 9443 (HTTPS)."
`;
}

// ─── Databases & AI installers ──────────────────────────────────────────────

function postgresqlScript() {
  return `${requireDebianGuest()}
DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-contrib
systemctl enable --now postgresql
runuser -u postgres -- psql -tAc 'SELECT version();'
echo "PostgreSQL is enabled at boot and listens on guest port 5432 (localhost only)."
`;
}

function mariadbScript() {
  return `${requireDebianGuest()}
DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y mariadb-server
systemctl enable --now mariadb
mariadb -e 'SELECT VERSION();'
echo "MariaDB is enabled at boot (as root, connect with: mariadb)."
`;
}

function redisScript() {
  return `${requireDebianGuest()}
DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y redis-server
systemctl enable --now redis-server
redis-cli ping
echo "Redis is enabled at boot on guest port 6379 (localhost only)."
`;
}

function comfyuiScript() {
  return `${requireDebianGuest()}
DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y git python3-venv python3-pip
rm -rf ${APP_ROOT}/comfyui
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git ${APP_ROOT}/comfyui/ComfyUI
cd ${APP_ROOT}/comfyui/ComfyUI
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
cat > /etc/systemd/system/vpanel-comfyui.service <<'UNIT'
[Unit]
Description=vPanel ComfyUI
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_ROOT}/comfyui/ComfyUI
ExecStart=${APP_ROOT}/comfyui/ComfyUI/venv/bin/python main.py --listen 0.0.0.0 --port 8188 --cpu
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now vpanel-comfyui
echo "ComfyUI (CPU mode) is running on guest port 8188."
`;
}

function librechatScript() {
  return `${dockerSetup()}
rm -rf ${APP_ROOT}/librechat
git clone --depth 1 https://github.com/danny-avila/LibreChat.git ${APP_ROOT}/librechat
cd ${APP_ROOT}/librechat
ENV_SRC=$(ls example.env .env.example 2>/dev/null | head -n 1)
if [ -n "$ENV_SRC" ] && [ ! -f .env ]; then cp "$ENV_SRC" .env; fi
docker compose up -d --build
echo "LibreChat is running on guest port 3080. Configure a provider key in the web UI."
`;
}

// ─── VPN & security installers ──────────────────────────────────────────────

function wireguardScript() {
  return `${requireDebianGuest()}
DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard iptables
umask 077
WAN=$(ip route show default 2>/dev/null | awk '{print $5; exit}')
if [ -z "$WAN" ]; then WAN=eth0; fi
if [ ! -f /etc/wireguard/server.key ]; then
  wg genkey > /etc/wireguard/server.key
fi
if [ ! -f /etc/wireguard/client.key ]; then
  wg genkey > /etc/wireguard/client.key
fi
SERVER_PRV=$(cat /etc/wireguard/server.key)
SERVER_PUB=$(printf '%s' "$SERVER_PRV" | wg pubkey)
CLIENT_PRV=$(cat /etc/wireguard/client.key)
CLIENT_PUB=$(printf '%s' "$CLIENT_PRV" | wg pubkey)
cat > /etc/wireguard/wg0.conf <<WG
[Interface]
Address = 10.66.66.1/24
ListenPort = 51820
PrivateKey = \${SERVER_PRV}
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o \${WAN} -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o \${WAN} -j MASQUERADE

[Peer]
PublicKey = \${CLIENT_PUB}
AllowedIPs = 10.66.66.2/32
WG
cat > /etc/wireguard/client.conf <<CLIENT
[Interface]
PrivateKey = \${CLIENT_PRV}
Address = 10.66.66.2/24
DNS = 1.1.1.1

[Peer]
PublicKey = \${SERVER_PUB}
Endpoint = <PANEL_HOST>:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
CLIENT
chmod 600 /etc/wireguard/wg0.conf /etc/wireguard/client.conf
sysctl -w net.ipv4.ip_forward=1 > /dev/null
wg-quick down wg0 2>/dev/null || true
wg-quick up wg0
systemctl enable wg-quick@wg0
wg show
echo "WireGuard is up. Server: /etc/wireguard/wg0.conf · Client profile: /etc/wireguard/client.conf (replace <PANEL_HOST> with the panel host)."
`;
}

function openVpnAsScript(cfg = {}) {
  const vpnUser = cfg.adminUser || 'openvpn';
  const vpnPass = cfg.adminPass || genPassword(12);
  return `${requireDistroIds('debian|ubuntu')}
if [ "$(dpkg --print-architecture)" != "amd64" ]; then echo "OpenVPN Access Server publishes amd64 packages." >&2; exit 1; fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates wget net-tools gnupg lsb-release
mkdir -p /etc/apt/keyrings
wget -qO /etc/apt/keyrings/openvpn-repo-public.asc https://as-repository.openvpn.net/as-repo-public.asc
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/openvpn-repo-public.asc] http://as-repository.openvpn.net/as/debian $(lsb_release -sc) main" > /etc/apt/sources.list.d/openvpn-as-repo.list
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y openvpn-as
AS_PASS=${shQuote(vpnPass)}
VPN_USER=${shQuote(vpnUser)}
if [ -x /usr/local/openvpn_as/scripts/sacli ]; then
  /usr/local/openvpn_as/scripts/sacli --user "$VPN_USER" --new_pass "$AS_PASS" UpdateUserPassword >/dev/null 2>&1 || true
fi
mkdir -p ${APP_ROOT}/openvpn-as
cat > ${APP_ROOT}/openvpn-as/access.txt <<ACCESS
OpenVPN Access Server
Admin UI: https://<PANEL_HOST>:<ADMIN_PORT>/admin
Admin user: \${VPN_USER}
Admin password: \${AS_PASS}
Data channel: guest port 443 (add a manual mapping to expose VPN clients)
ACCESS
chmod 600 ${APP_ROOT}/openvpn-as/access.txt
echo "OpenVPN Access Server is installed. Admin facts: https://<panel-host>:<admin-port>/admin · credentials in ${APP_ROOT}/openvpn-as/access.txt"
`;
}

// ─── Media & communication installers ───────────────────────────────────────

function jitsiScript() {
  return `${requireDebianGuest()}
DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y curl gnupg
mkdir -p /usr/share/keyrings
curl -fsSL https://download.jitsi.org/jitsi-key.gpg.key | gpg --dearmor > /usr/share/keyrings/jitsi-key-ring.gpg
echo "deb [signed-by=/usr/share/keyrings/jitsi-key-ring.gpg] https://download.jitsi.org stable/" > /etc/apt/sources.list.d/jitsi-stable.list
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get -y install jitsi-meet
echo "Jitsi Meet is installed. HTTPS serves on guest port 443 with the guest hostname."
`;
}

function azuracastScript() {
  return `${dockerSetup()}
rm -rf ${APP_ROOT}/azuracast
git clone --depth 1 https://github.com/AzuraCast/AzuraCast.git ${APP_ROOT}/azuracast
cd ${APP_ROOT}/azuracast
chmod +x install.sh
export DEBIAN_FRONTEND=noninteractive
yes "" | bash ./install.sh
echo "AzuraCast is running on guest port 80."
`;
}

function owncastScript() {
  return `${requireDebianGuest()}
DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y unzip curl
rm -rf ${APP_ROOT}/owncast
mkdir -p ${APP_ROOT}/owncast
cd ${APP_ROOT}/owncast
OC_ZIP=/tmp/owncast.zip
curl -fsSL -o "$OC_ZIP" https://github.com/owncast/owncast/releases/latest/download/owncast-linux-64bit.zip || curl -fsSL -o "$OC_ZIP" https://github.com/owncast/owncast/releases/latest/download/owncast-linux-amd64.zip
unzip -o -q "$OC_ZIP"
rm -f "$OC_ZIP"
chmod +x owncast
cat > /etc/systemd/system/vpanel-owncast.service <<'UNIT'
[Unit]
Description=vPanel Owncast
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_ROOT}/owncast
ExecStart=${APP_ROOT}/owncast/owncast
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now vpanel-owncast
echo "Owncast is running: web on guest port 8080, RTMP ingest on guest port 1935."
`;
}

// ─── Game server installers ─────────────────────────────────────────────────

function minecraftScript(cfg = {}) {
  const mcVersion = /^(latest|[A-Za-z0-9._-]{1,40})$/.test(String(cfg.mcVersion || '')) ? String(cfg.mcVersion) : 'latest';
  const mcMemory = ['2G', '3G', '4G', '6G'].includes(cfg.mcMemory) ? cfg.mcMemory : '2G';
  return `${dockerSetup()}
APP_DIR=${APP_ROOT}/minecraft
mkdir -p "$APP_DIR/data"
cd "$APP_DIR"
cat > compose.yaml <<'YAML'
services:
  minecraft:
    image: itzg/minecraft-server:latest
    restart: unless-stopped
    ports:
      - "0.0.0.0:25565:25565"
    environment:
      EULA: "TRUE"
      VERSION: "${mcVersion}"
      MEMORY: "${mcMemory}"
    volumes:
      - ./data:/data
    stdin_open: true
    tty: true
YAML
docker compose up -d
echo "The Minecraft server container is starting on guest port 25565; the first run downloads server files (version ${mcVersion}, memory ${mcMemory})."
`;
}

// ─── Installer registry ─────────────────────────────────────────────────────

const installers = {
  wordpress: wordpressScript,
  woocommerce: woocommerceScript,
  drupal: drupalScript,
  joomla: joomlaScript,
  prestashop: prestashopScript,
  mediawiki: mediawikiScript,
  cloudpanel: cloudpanelScript,
  webmin: webminScript,
  cpanel: cpanelScript,
  plesk: pleskScript,
  docker: dockerScript,
  nodejs: nodejsScript,
  laravel: laravelScript,
  lamp: lampScript,
  lemp: lempScript,
  openlitespeed: openlitespeedScript,
  gitlab: gitlabScript,
  k3s: k3sScript,
  miniconda: minicondaScript,
  portainer: portainerScript,
  postgresql: postgresqlScript,
  mariadb: mariadbScript,
  redis: redisScript,
  comfyui: comfyuiScript,
  librechat: librechatScript,
  wireguard: wireguardScript,
  'openvpn-as': openVpnAsScript,
  jitsi: jitsiScript,
  azuracast: azuracastScript,
  owncast: owncastScript,
  minecraft: minecraftScript,
};

// ─── Install configuration, Cloudflare tunnels & streamed job handling ──────

function genPassword(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

// Compose value helper: embedded literal for compose.yaml. Escapes backslashes,
// quotes and Interpolation dollars ($ -> $$) so compose keeps them literal.
function composeEnvValue(value) {
  const text = String(value).replace(/[\r\n\t]/g, ' ');
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$') + '"';
}

// POSIX single-quote shell wrapper for values written at build time.
function shQuote(value) {
  return "'" + String(value).split("'").join("'\\''") + "'";
}

function cloudflaredSection(token) {
  return `set -euo pipefail
${requireDebianGuest()}
echo "══ Cloudflare Tunnel phase ══"
echo "Installing cloudflared from the official Cloudflare release channel…"
export DEBIAN_FRONTEND=noninteractive
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg
CF_ARCH=$(dpkg --print-architecture)
case "$CF_ARCH" in amd64|arm64) ;; *) echo "cloudflared publishes amd64/arm64 .deb packages only." >&2; exit 1;; esac
curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CF_ARCH.deb"
dpkg -i /tmp/cloudflared.deb || { apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y -f; dpkg -i /tmp/cloudflared.deb; }
rm -f /tmp/cloudflared.deb
cloudflared service install ${shQuote(token)}
sleep 2
if systemctl is-active --quiet cloudflared; then
  echo "cloudflared service is active and connected to Cloudflare."
  echo "Map your hostname in dash.cloudflare.com > Networking > Tunnels to the app (for example http://localhost:8080)."
else
  echo "cloudflared was installed but the service is not active yet." >&2
  echo "Inspect it inside the VM with: systemctl status cloudflared" >&2
  exit 1
fi
`;
}

function extractTunnelToken(input) {
  const text = String(input ?? '').trim();
  if (!text) {
    throw new TypeError('Enter the full cloudflared service install command from the Cloudflare dashboard, including the eyJ… tunnel token.');
  }
  if (text.length > 2000) {
    throw new TypeError('That tunnel command is too long. Copy the install line from the Cloudflare dashboard exactly as shown.');
  }
  const match = text.match(/eyJ[A-Za-z0-9_-]{80,}=*/);
  if (!match) {
    throw new TypeError('The tunnel command must contain the long eyJ… token that follows "cloudflared service install" on the Cloudflare dashboard.');
  }
  return match[0];
}

function normalizeAppConfig(app, raw) {
  const fields = app && Array.isArray(app.config) ? app.config : [];
  if (!fields.length) {
    if (raw !== undefined && raw !== null && typeof raw === 'object') {
      throw new TypeError(`${app ? app.name : 'This app'} does not accept installation options.`);
    }
    return {};
  }
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const field of fields) {
    let value = String(source[field.key] ?? '').trim();
    if (!value && field.default !== undefined) value = String(field.default);
    if (!value) {
      if (field.autoGen) value = genPassword(field.autoGen);
      if (field.required) throw new TypeError(`${field.label} is required to install ${app.name}.`);
      continue;
    }
    if (value.length > 128) throw new TypeError(`${field.label} is too long.`);
    if (field.type === 'email' && !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      throw new TypeError('Enter a valid email address.');
    }
    if (field.min && value.length < field.min) {
      throw new TypeError(`${field.label} must be at least ${field.min} characters.`);
    }
    if (field.pattern && !new RegExp(field.pattern).test(value)) {
      throw new TypeError(`${field.label} has an unsupported value.`);
    }
    if (Array.isArray(field.options) && field.options.length && !field.options.includes(value)) {
      throw new TypeError(`${field.label} must be one of: ${field.options.join(', ')}.`);
    }
    out[field.key] = value;
  }
  return out;
}

function publicConfigView(app, cfg) {
  const out = {};
  for (const field of app && Array.isArray(app.config) ? app.config : []) {
    if (field.secret) continue;
    if (cfg[field.key] !== undefined) out[field.key] = cfg[field.key];
  }
  return out;
}

function credentialsView(app, cfg) {
  const rows = [];
  for (const field of app && Array.isArray(app.config) ? app.config : []) {
    if (!field.secret || !cfg[field.key]) continue;
    rows.push({
      key: field.key,
      label: field.label,
      generated: Boolean(field.autoGen),
      value: field.autoGen ? cfg[field.key] : '•••••••• (the value you entered)',
    });
  }
  return rows;
}

const INSTALL_LOG_CHUNK_MAX = 2000;
const INSTALL_LOG_CHUNKS_MAX = 4000;
const INSTALL_LOG_BUFFER_FLUSH = 40;

function clipChunk(text, kind) {
  return { t: kind, s: String(text).slice(0, INSTALL_LOG_CHUNK_MAX) };
}

function makeLogSink(jobId) {
  const buffer = [];
  let timer = null;
  let total = 0;
  const flush = async () => {
    timer = null;
    if (!buffer.length) return;
    const batch = buffer.splice(0, buffer.length);
    total += batch.length;
    await collections.app_store_installs
      .updateOne(
        { id: jobId },
        { $push: { logs: { $each: batch, $slice: -INSTALL_LOG_CHUNKS_MAX } }, $set: { log_total: total } },
      )
      .catch(() => {});
  };
  return {
    push(kind, text) {
      if (!text) return;
      buffer.push(clipChunk(text, kind));
      if (buffer.length >= INSTALL_LOG_BUFFER_FLUSH) {
        if (!timer) void flush();
      } else if (!timer) {
        timer = setTimeout(flush, 1500);
        if (typeof timer.unref === 'function') timer.unref();
      }
    },
    async end() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flush();
    },
  };
}

async function markJob(jobId, update) {
  await collections.app_store_installs.updateOne({ id: jobId }, update).catch(() => {});
}

function serializeInstallJob(doc, { since = 0, includeLogs = true } = {}) {
  const logs = Array.isArray(doc.logs) ? doc.logs : [];
  const total = Math.max(Number(doc.log_total) || 0, logs.length);
  const availableFrom = total - logs.length;
  let from = total;
  let slice = [];
  if (includeLogs) {
    if (since > availableFrom) from = Math.min(since, total);
    else from = availableFrom;
    slice = logs.slice(Math.max(0, from - availableFrom)).map((entry) => ({ t: entry.t, s: String(entry.s || '') }));
  }
  let status = doc.status;
  if (status === 'running' && doc.started_at) {
    const startedMs = Date.parse(doc.started_at);
    if (Number.isFinite(startedMs) && Date.now() - startedMs > 2.5 * 60 * 60 * 1000) status = 'stale';
  }
  return {
    id: doc.id,
    appId: doc.app_id,
    appName: doc.app_name,
    kind: doc.kind,
    vmId: doc.vm_id,
    userId: doc.user_id,
    status,
    phase: doc.phase,
    startedAt: doc.started_at || null,
    finishedAt: doc.finished_at || null,
    exitCode: doc.exit_code ?? null,
    hasCloudflare: Boolean(doc.has_cloudflare),
    hostPort: doc.host_port ?? null,
    guestPort: doc.guest_port ?? null,
    config: doc.config || {},
    result: doc.result || null,
    from: slice.length ? from : total,
    total,
    logs: slice,
  };
}

function buildInstallResult(plan, { cloudflareNote, cloudflareFailed, appFailed, errorMessage } = {}) {
  const app = plan.app;
  const portInfo = { hostPort: plan.hostPort, guestPort: plan.guestPort };
  const config = plan.publicConfig || publicConfigView(app, plan.cfg);
  const result = {
    appId: plan.id,
    appName: plan.appName,
    kind: plan.kind,
    hostPort: plan.hostPort ?? null,
    guestPort: plan.guestPort ?? null,
    restartRequired: Boolean(plan.hostPort),
    scheme: app ? (app.scheme || 'http') : 'http',
    config,
    credentials: app ? credentialsView(app, plan.cfg) : [],
    cloudflare: plan.kind === 'cloudflared'
      ? { enabled: true, status: 'done', note: 'See the console output for the service state.' }
      : { enabled: Boolean(cloudflareNote), status: cloudflareFailed ? 'failed' : (cloudflareNote ? 'done' : 'skipped'), error: cloudflareFailed || null, note: cloudflareNote || null },
  };
  if (plan.openClawToken) result.openClawToken = plan.openClawToken;
  if (appFailed) {
    result.appInstalled = false;
    result.errorMessage = errorMessage || 'The installer failed.';
    result.message = `${plan.appName || 'The installer'} failed${errorMessage ? ': ' + errorMessage : ''}.`;
    return result;
  }
  result.appInstalled = true;
  if (plan.kind === 'openclaw') {
    result.message = null;
    return result;
  }
  result.message = resultMessage(app, portInfo, plan.cfg) || 'Installation finished. See the console output for details.';
  return result;
}

async function buildPlan({ vm, user, appId, config, customScript }) {
  if (vm.status !== 'running') throw new Error('Start the VM and wait for SSH access before installing an app.');
  const id = String(appId || '');
  let hostPort = null;
  let guestPort = null;
  let openClawToken = null;
  let app = null;
  let script;
  let timeout = DEFAULT_INSTALLER_TIMEOUT;
  let cfg = {};
  let forwards = [];

  if (id === 'custom') {
    if (typeof customScript !== 'string' || !customScript.trim()) throw new TypeError('Enter an installation script.');
    if (Buffer.byteLength(customScript, 'utf8') > MAX_CUSTOM_SCRIPT_BYTES) {
      throw new TypeError(`Custom scripts are limited to ${MAX_CUSTOM_SCRIPT_BYTES / 1024} KB.`);
    }
    script = customScript;
  } else if (id === 'openclaw') {
    openClawToken = crypto.randomBytes(32).toString('hex');
    script = openClawScript(openClawToken);
  } else {
    app = catalog.find((entry) => entry.id === id);
    if (!app || !installers[id]) throw new TypeError('Choose an app from the catalog or select custom script.');
    timeout = app.timeoutMs || DEFAULT_INSTALLER_TIMEOUT;
    cfg = normalizeAppConfig(app, config);
    script = installers[id](cfg);
    if (app.guestPort) {
      guestPort = app.guestPort;
      forwards = ensureGuestPortAvailable(vm, guestPort);
      hostPort = await allocateHostPort(vm);
    }
  }

  return {
    kind: id === 'custom' ? 'custom' : app ? 'catalog' : 'openclaw',
    id,
    app,
    appName: app ? app.name : (id === 'openclaw' ? 'OpenClaw' : 'custom script'),
    cfg,
    publicConfig: publicConfigView(app, cfg),
    script,
    timeout,
    hostPort,
    guestPort,
    forwards,
    openClawToken,
  };
}

async function executeInstallJob(vm, user, plan, jobId, { hasCloudflare, cloudflareToken }) {
  const sink = makeLogSink(jobId);
  const tunnelInstalled = { value: false };
  const isTunnelOnly = plan.kind === 'cloudflared';
  try {
    sink.push('info', `▶ Installing ${plan.appName} on VM #${vm.id} (${vm.name}).`);
    if (plan.kind === 'custom') sink.push('info', 'Custom script — the panel does not review its commands.');
    if (!isTunnelOnly && plan.hostPort) {
      sink.push('info', `Port mapping reserved: guest ${plan.guestPort} → host ${plan.hostPort} (activates at the next VM restart).`);
    }
    const run = await runScript(vm, plan.script, plan.timeout, {
      onLog: (text, isErr) => sink.push(isErr ? 'err' : 'out', text),
    });
    if (plan.kind === 'catalog' && plan.hostPort && plan.guestPort) {
      await vmService.update(vm, { port_forwards: [...plan.forwards, { host: plan.hostPort, guest: plan.guestPort }] }, user);
      sink.push('info', `Saved mapping guest ${plan.guestPort} → host ${plan.hostPort}.`);
    }
    let cloudflareError = null;
    if (!isTunnelOnly && hasCloudflare && cloudflareToken) {
      await markJob(jobId, { $set: { phase: 'cloudflared' } });
      sink.push('info', '══ Cloudflare Tunnel phase ══');
      try {
        const cf = await runScript(vm, cloudflaredSection(cloudflareToken), 20 * 60 * 1000, {
          onLog: (text, isErr) => sink.push(isErr ? 'err' : 'out', text),
        });
        tunnelInstalled.value = cf.code === 0;
      } catch (error) {
        cloudflareError = error;
      }
    }
    await sink.end();
    const cfNote = hasCloudflare && !isTunnelOnly && !cloudflareError
      ? (plan.guestPort
        ? `Tunnel connected. In dash.cloudflare.com go to Networking > Tunnels > your tunnel > Public Hostname and map your hostname to http://localhost:${plan.guestPort} to reach this app.`
        : 'Tunnel connected. Map a Public Hostname for this tunnel in the Cloudflare Zero Trust dashboard.')
      : null;
    const result = buildInstallResult(plan, {
      cloudflareNote: cfNote,
      cloudflareFailed: cloudflareError ? String(cloudflareError.message || 'Cloudflare tunnel installation failed.') : null,
    });
    await markJob(jobId, {
      $set: {
        phase: 'done',
        status: 'success',
        finished_at: new Date().toISOString(),
        exit_code: run ? run.code : null,
        result,
      },
    });
    await logActivity({
      user_id: user.id,
      vm_id: vm.id,
      event: isTunnelOnly ? 'vm:cloudflared_install' : 'vm:app_install',
      details: {
        app: plan.id,
        ...(plan.hostPort ? { host_port: plan.hostPort, guest_port: plan.guestPort } : {}),
        ...(cloudflareError ? { cloudflare_failed: true } : {}),
      },
    });
    return { result };
  } catch (error) {
    await sink.end();
    const message = String((error && error.message) || 'The installer failed. Check the VM SSH connection and try again.');
    const result = buildInstallResult(plan, { appFailed: true, errorMessage: message });
    result.appInstalled = false;
    result.errorMessage = message;
    await markJob(jobId, {
      $set: {
        phase: 'done',
        status: 'failed',
        finished_at: new Date().toISOString(),
        exit_code: null,
        result,
      },
    });
    return { status: 'failed' };
  }
}

async function createInstallJob(plan, vm, user, { hasCloudflare }) {
  const id = crypto.randomUUID();
  const doc = {
    id,
    app_id: plan.id,
    app_name: plan.appName,
    kind: plan.kind,
    vm_id: vm.id,
    user_id: Number(user.id),
    status: 'running',
    phase: plan.kind === 'cloudflared' ? 'cloudflared' : 'app',
    started_at: new Date().toISOString(),
    finished_at: null,
    exit_code: null,
    host_port: plan.hostPort ?? null,
    guest_port: plan.guestPort ?? null,
    has_cloudflare: Boolean(hasCloudflare),
    config: plan.publicConfig || {},
    log_total: 0,
    logs: [],
    result: null,
  };
  try {
    await collections.app_store_installs.insertOne(doc);
  } catch (error) {
    if (/duplicate/i.test(String(error.message))) throw new Error('This install job already exists. Refresh and try again.');
    throw error;
  }
  return id;
}

async function getOwnedInstallJob(jobId, user) {
  const doc = await collections.app_store_installs.findOne({ id: String(jobId || '') });
  if (!doc) return null;
  const privileged = user && (user.role === 'admin' || user.root_admin);
  if (!privileged && Number(doc.user_id) !== Number(user.id)) return null;
  return doc;
}

async function listInstallsForVm(vm, user) {
  const privileged = user && (user.role === 'admin' || user.root_admin);
  const ownerView = privileged || Number(vm.owner_id) === Number(user.id);
  const query = ownerView ? { vm_id: vm.id } : { vm_id: vm.id, user_id: Number(user.id) };
  const docs = await collections.app_store_installs.find(query).sort({ started_at: -1 }).limit(60).toArray();
  return docs.map((doc) => serializeInstallJob(doc, { includeLogs: false }));
}

function refreshJobMessage(job, newHostPort) {
  try {
    const app = catalog.find((entry) => entry.id === job.app_id) || null;
    if (!app || !job.result || !job.result.message) return job.result ? job.result.message : null;
    const cfg = job.config || {};
    const raw = typeof app.resultNote === 'function' ? app.resultNote(cfg) : null;
    return resultMessage(app, { hostPort: newHostPort, guestPort: job.guest_port }, cfg);
  } catch (_) {
    return job.result ? job.result.message : null;
  }
}

async function renewInstallPort({ job, vm, user, preferredPort }) {
  if (job.status === 'running' || job.phase !== 'done') {
    throw new Error('Wait for the installation to finish before changing its port mapping.');
  }
  if (!Number.isInteger(Number(job.host_port)) || !Number.isInteger(Number(job.guest_port))) {
    throw new TypeError('This installation has no public port mapping to change.');
  }
  const preferredText = preferredPort === undefined || preferredPort === null ? '' : String(preferredPort).trim();
  let newHost;
  if (preferredText === '') {
    newHost = await allocateHostPort(vm);
  } else {
    newHost = Number(preferredText);
    if (!Number.isSafeInteger(newHost) || newHost < 1024 || newHost > 65535) {
      throw new TypeError('Pick a host port between 1024 and 65535, or leave the field empty for an automatic one.');
    }
    if (newHost === Number(job.host_port)) {
      throw new TypeError('That is already the current host port for this app.');
    }
    const used = new Set([Number(vm.ssh_port), Number(vm.vnc_port), Number(vm.agent_port)]);
    for (const item of await collections.vms.find({}, { projection: { ssh_port: 1, vnc_port: 1, agent_port: 1, port_forwards: 1 } }).toArray()) {
      for (const port of [item.ssh_port, item.vnc_port, item.agent_port]) {
        if (Number.isInteger(Number(port))) used.add(Number(port));
      }
      for (const forward of parsePortForwards(item.port_forwards)) {
        if (Number.isInteger(Number(forward.host))) used.add(Number(forward.host));
      }
    }
    if (used.has(newHost)) throw new TypeError(`Host port ${newHost} is already used on this panel.`);
    if (!(await checkAvailablePort(newHost))) throw new TypeError(`Host port ${newHost} is not free on this host.`);
  }
  const forwards = parsePortForwards(vm.port_forwards);
  const index = forwards.findIndex(
    (forward) => Number(forward.host) === Number(job.host_port) && Number(forward.guest) === Number(job.guest_port),
  );
  if (index < 0) {
    throw new TypeError('The original mapping is no longer present on this VM. Manage ports from VM Settings instead.');
  }
  const updated = forwards.slice();
  updated[index] = { host: newHost, guest: Number(job.guest_port) };
  await vmService.update(vm, { port_forwards: updated }, user);
  const patch = { $set: { host_port: newHost } };
  if (job.result) {
    const updatedResult = { ...job.result, hostPort: newHost };
    const refreshedMessage = refreshJobMessage(job, newHost);
    if (refreshedMessage) updatedResult.message = refreshedMessage;
    patch.$set.result = updatedResult;
  }
  await markJob(job.id, patch);
  await logActivity({
    user_id: user.id,
    vm_id: vm.id,
    event: 'vm:app_port_refresh',
    details: { app: job.app_id, host_port: newHost, guest_port: job.guest_port },
  });
}

async function startTunnelInstall({ vm, user, cloudflareToken }) {
  if (vm.status !== 'running') throw new Error('Start the VM and wait for SSH access before installing an app.');
  const token = extractTunnelToken(cloudflareToken);
  const plan = {
    kind: 'cloudflared',
    id: 'cloudflared',
    app: null,
    appName: 'Cloudflare Tunnel',
    cfg: {},
    publicConfig: {},
    script: cloudflaredSection(token),
    timeout: 20 * 60 * 1000,
    hostPort: null,
    guestPort: null,
    forwards: [],
    openClawToken: null,
  };
  const jobId = await createInstallJob(plan, vm, user, { hasCloudflare: true });
  void executeInstallJob(vm, user, plan, jobId, { hasCloudflare: false, cloudflareToken: token }).catch(() => {});
  await logActivity({
    user_id: user.id,
    vm_id: vm.id,
    event: 'vm:cloudflared_install',
    details: { app: 'cloudflared' },
  });
  return getJobSnapshot(jobId);
}

function configDefs() {
  const out = {};
  for (const app of catalog) {
    if (!Array.isArray(app.config) || !app.config.length) continue;
    out[app.id] = app.config.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type || 'text',
      ...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
      ...(field.default !== undefined ? { default: field.default } : {}),
      ...(field.required ? { required: true } : {}),
      ...(Array.isArray(field.options) ? { options: field.options.slice() } : {}),
      ...(field.help ? { help: field.help } : {}),
      ...(field.min ? { min: field.min } : {}),
      secret: Boolean(field.secret),
    }));
  }
  return out;
}

async function getJobSnapshot(jobId) {
  const doc = await collections.app_store_installs.findOne({ id: jobId }).catch(() => null);
  return doc ? serializeInstallJob(doc, { includeLogs: false }) : null;
}

async function startInstall({ vm, user, appId, config, customScript, cloudflareToken }) {
  const plan = await buildPlan({ vm, user, appId, config, customScript });
  let cfToken = null;
  if (cloudflareToken !== undefined && cloudflareToken !== null && String(cloudflareToken).trim() !== '') {
    cfToken = extractTunnelToken(cloudflareToken);
  }
  const jobId = await createInstallJob(plan, vm, user, { hasCloudflare: Boolean(cfToken) });
  void executeInstallJob(vm, user, plan, jobId, { hasCloudflare: Boolean(cfToken), cloudflareToken: cfToken }).catch(() => {});
  return { jobId, snapshot: await getJobSnapshot(jobId) };
}

// ─── Plumbing ───────────────────────────────────────────────────────────────

function parsePortForwards(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function checkAvailablePort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    });
    server.listen({ host: '0.0.0.0', port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve(true));
    });
  });
}

async function allocateHostPort(vm) {
  const min = Math.max(1024, Number.parseInt(settings.get('vm.auto_port_min'), 10) || 25501);
  const max = Math.min(65535, Number.parseInt(settings.get('vm.auto_port_max'), 10) || 25600);
  const allVms = await collections.vms.find({}, {
    projection: { ssh_port: 1, vnc_port: 1, agent_port: 1, port_forwards: 1 },
  }).toArray();
  const used = new Set();
  for (const item of allVms) {
    for (const port of [item.ssh_port, item.vnc_port, item.agent_port]) {
      if (Number.isInteger(Number(port))) used.add(Number(port));
    }
    for (const forward of parsePortForwards(item.port_forwards)) {
      if (Number.isInteger(Number(forward.host))) used.add(Number(forward.host));
    }
  }
  for (let port = min; port <= max; port += 1) {
    if (!used.has(port) && await checkAvailablePort(port)) return port;
  }
  throw new Error('No free public port is available in the configured VM port range.');
}

function ensureGuestPortAvailable(vm, guestPort) {
  const forwards = parsePortForwards(vm.port_forwards);
  if (forwards.some((forward) => Number(forward.guest) === guestPort)) {
    throw new Error(`Guest port ${guestPort} is already forwarded. Remove or change that mapping before installing this app.`);
  }
  return forwards;
}

async function runScript(vm, script, timeout = DEFAULT_INSTALLER_TIMEOUT, opts = {}) {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  const command = `printf '%s' '${encoded}' | sudo -n bash -c 'base64 -d | bash'`;
  const result = await sshService.withExec(vm, command, {
    timeout,
    maxOutputBytes: 32 * 1024,
    ...(typeof opts.onLog === 'function' ? { onOutput: opts.onLog } : {}),
  });
  if (result.code !== 0) {
    const error = new Error(`Guest installer exited with status ${result.code}.`);
    error.code = 'APP_INSTALL_FAILED';
    throw error;
  }
  return result;
}

function fillPlaceholders(text, portInfo) {
  return String(text)
    .replace(/<hostPort>/g, String(portInfo.hostPort || ''))
    .replace(/<guestPort>/g, String(portInfo.guestPort || ''))
    .replace(/<APP_ROOT>/g, APP_ROOT);
}

function resultMessage(app, portInfo, cfg) {
  if (!app) return null;
  const rawNote = app.resultNote
    ? (typeof app.resultNote === 'function' ? app.resultNote(cfg || {}) : app.resultNote)
    : null;
  const note = rawNote ? fillPlaceholders(rawNote, portInfo) : null;
  if (portInfo.hostPort && portInfo.guestPort) {
    if (app.portNote) return fillPlaceholders(app.portNote, portInfo);
    const base = `${app.name} is installed. Guest port ${portInfo.guestPort} is mapped to host port ${portInfo.hostPort}. Restart the VM to activate the QEMU port mapping, then open ${app.scheme === 'https' ? 'https' : 'http'}://<your-panel-host>:${portInfo.hostPort}. Allow the port through your host firewall if needed.`;
    return note ? `${base} ${note}` : base;
  }
  if (note) return note;
  return 'The installer finished successfully. Verify the application inside the VM over SSH.';
}

async function install({ vm, user, appId, customScript }) {
  const plan = await buildPlan({ vm, user, appId, customScript });
  await runScript(vm, plan.script, plan.timeout);
  if (plan.kind === 'catalog' && plan.hostPort && plan.guestPort) {
    await vmService.update(vm, { port_forwards: [...plan.forwards, { host: plan.hostPort, guest: plan.guestPort }] }, user);
  }
  await logActivity({
    user_id: user.id,
    vm_id: vm.id,
    event: 'vm:app_install',
    details: { app: plan.id, ...(plan.hostPort ? { host_port: plan.hostPort, guest_port: plan.guestPort } : {}) },
  });
  const portInfo = { hostPort: plan.hostPort, guestPort: plan.guestPort };
  return {
    appId: plan.id,
    appName: plan.app ? plan.app.name : (plan.id === 'openclaw' ? 'OpenClaw' : null),
    hostPort: plan.hostPort,
    guestPort: plan.guestPort,
    restartRequired: Boolean(plan.hostPort),
    message: resultMessage(plan.app, portInfo, plan.cfg),
    ...(plan.openClawToken ? { openClawToken: plan.openClawToken } : {}),
  };
}

function openClawScript(token) {
  return `${dockerSetup()}
APP_DIR=${APP_ROOT}/openclaw
TOKEN=${token}
mkdir -p "$APP_DIR"
if [ ! -d "$APP_DIR/source/.git" ]; then
  git clone --depth 1 https://github.com/openclaw/openclaw.git "$APP_DIR/source"
fi
cd "$APP_DIR/source"
COMMIT="$(git rev-parse HEAD)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker build --build-arg "GIT_COMMIT=$COMMIT" --build-arg "OPENCLAW_BUILD_TIMESTAMP=$BUILD_TIME" -t openclaw:local .
mkdir -p "$APP_DIR/state/workspace"
cat > "$APP_DIR/state/openclaw.json" <<CONFIG
{"gateway":{"mode":"local","bind":"lan","auth":{"mode":"token","token":"$TOKEN"},"controlUi":{"allowedOrigins":["http://localhost:18789","http://127.0.0.1:18789"]}}}
CONFIG
chmod 600 "$APP_DIR/state/openclaw.json"
cat > "$APP_DIR/.env" <<ENV
OPENCLAW_GATEWAY_TOKEN=$TOKEN
ENV
chmod 600 "$APP_DIR/.env"
cat > "$APP_DIR/compose.yaml" <<'YAML'
services:
  gateway:
    image: openclaw:local
    restart: unless-stopped
    init: true
    cap_drop:
      - NET_RAW
      - NET_ADMIN
    security_opt:
      - no-new-privileges:true
    environment:
      HOME: /home/node
      OPENCLAW_HOME: /home/node
      OPENCLAW_STATE_DIR: /home/node/.openclaw
      OPENCLAW_CONFIG_PATH: /home/node/.openclaw/openclaw.json
      OPENCLAW_CONFIG_DIR: /home/node/.openclaw
      OPENCLAW_WORKSPACE_DIR: /home/node/.openclaw/workspace
      OPENCLAW_GATEWAY_PORT: "18789"
      OPENCLAW_GATEWAY_TOKEN: \${OPENCLAW_GATEWAY_TOKEN}
      TZ: UTC
    volumes:
      - ./state:/home/node/.openclaw
      - ./state/workspace:/home/node/.openclaw/workspace
    ports:
      - "18789:18789"
    command: ["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "18789"]
YAML
cd "$APP_DIR"
docker compose up -d
echo "OpenClaw gateway started. Configure a model provider during onboarding."
`;
}

module.exports = {
  catalog,
  install,
  startInstall,
  getOwnedInstallJob,
  serializeInstallJob,
  listInstallsForVm,
  renewInstallPort,
  startTunnelInstall,
  configDefs,
  parsePortForwards,
  wordpressScript,
  openClawScript,
  MAX_CUSTOM_SCRIPT_BYTES,
};
