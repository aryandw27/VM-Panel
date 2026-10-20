#!/usr/bin/env bash





set -e


RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -d "$SCRIPT_DIR/vpanel-pro" ]; then
  APP_DIR="$SCRIPT_DIR/vpanel-pro"
else
  APP_DIR="$SCRIPT_DIR"
fi

cd "$APP_DIR"

safe_clear() {
  clear 2>/dev/null || true
}

log_info()  { printf "${CYAN}${BOLD}[vPanel]${NC} %b\n" "$*"; }
log_ok()    { printf "${GREEN}${BOLD}[✔ SUCCESS]${NC} %b\n" "$*"; }
log_warn()  { printf "${YELLOW}${BOLD}[⚠ WARN]${NC} %b\n" "$*"; }
log_err()   { printf "${RED}${BOLD}[✖ ERROR]${NC} %b\n" "$*" >&2; }

check_root() {
  if [ "$(id -u)" -ne 0 ]; then
    log_err "This script must be run as root. Please run with: sudo bash install.sh"
    exit 1
  fi
}

detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="$ID"
    OS_VER="${VERSION_ID:-}"
    OS_NAME="${PRETTY_NAME:-$ID}"
  else
    log_err "Cannot detect Linux distribution (/etc/os-release missing)."
    exit 1
  fi

  case "$OS_ID" in
    debian|ubuntu)
      log_info "Detected Supported OS: ${GREEN}${OS_NAME}${NC}"
      ;;
    *)
      log_warn "Detected OS: ${OS_NAME}. Recommended distributions: Debian 11/12/13, Ubuntu 20.04/22.04/24.04."
      ;;
  esac
}

get_server_ip() {
  local ip
  ip=$(curl -s -4 https://api.ipify.org 2>/dev/null || curl -s -4 https://ifconfig.me 2>/dev/null || ip route get 1.1.1.1 2>/dev/null | awk '{print $7}' || echo "localhost")
  echo "$ip"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp "${APP_DIR}/.env.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 {
      if (!found) print key "=" value
      found = 1
      next
    }
    { print }
    END { if (!found) print key "=" value }
  ' .env > "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}

mongo_connection_works() {
  node -e "require('dotenv').config(); const { MongoClient } = require('mongodb'); const c = new MongoClient(process.env.MONGO_URI || '', { serverSelectionTimeoutMS: 2000 }); c.connect().then(() => c.close()).then(() => process.exit(0)).catch(() => process.exit(1));" >/dev/null 2>&1
}

mongo_uri_is_local() {
  node -e "require('dotenv').config(); try { const host = new URL(process.env.MONGO_URI || '').hostname.toLowerCase(); process.exit(['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) ? 0 : 1); } catch (_) { process.exit(1); }" >/dev/null 2>&1
}

mongo_uri_port() {
  node -e "require('dotenv').config(); try { process.stdout.write(String(new URL(process.env.MONGO_URI || '').port || 27017)); } catch (_) { process.exit(1); }"
}

mongo_uri_auth_base64() {
  node -e "require('dotenv').config(); try { const uri = new URL(process.env.MONGO_URI || ''); process.stdout.write(Buffer.from(JSON.stringify({ username: decodeURIComponent(uri.username), password: decodeURIComponent(uri.password) })).toString('base64')); } catch (_) { process.exit(1); }"
}

show_mongo_diagnostics() {
  if command -v docker >/dev/null 2>&1 && docker ps -a --format "{{.Names}}" | grep -Fxq "mongodb"; then
    log_warn "MongoDB container state:"
    docker inspect --format 'status={{.State.Status}} exit_code={{.State.ExitCode}}' mongodb 2>/dev/null || true
    log_warn "Recent MongoDB container logs:"
    docker logs --tail 40 mongodb 2>&1 || true
  fi
  node -e "require('dotenv').config(); const { MongoClient } = require('mongodb'); const c = new MongoClient(process.env.MONGO_URI || '', { serverSelectionTimeoutMS: 5000 }); c.connect().then(() => c.close()).catch((error) => { console.error('MongoDB connection error: ' + error.name + (error.code ? ' (code ' + error.code + ')' : '')); process.exitCode = 1; });" 2>&1 || true
}

port_is_available() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    if ss -H -ltn "sport = :${port}" | grep -q .; then
      return 1
    fi
    return 0
  elif (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
    exec 3>&-
    return 1
  else
    return 0
  fi
}

collect_install_settings() {
  local default_panel_port="${PANEL_PORT:-3001}"
  local default_api_port="${API_PORT:-3002}"

  if [ -t 0 ] && [ "$NON_INTERACTIVE" -eq 0 ]; then
    echo ""
    read -r -p "Admin username [${ADMIN_USER:-admin}]: " INPUT_USER
    ADMIN_USER="${INPUT_USER:-${ADMIN_USER:-admin}}"

    read -r -p "Admin email [${ADMIN_EMAIL:-admin@vpanel.local}]: " INPUT_EMAIL
    ADMIN_EMAIL="${INPUT_EMAIL:-${ADMIN_EMAIL:-admin@vpanel.local}}"

    if [ -z "$ADMIN_PASS" ]; then
      local confirm_pass
      while true; do
        read -r -s -p "Admin password (minimum 12 characters): " ADMIN_PASS
        echo ""
        read -r -s -p "Confirm admin password: " confirm_pass
        echo ""
        if [ -z "$ADMIN_PASS" ]; then
          log_warn "Admin password cannot be empty."
        elif [ "$ADMIN_PASS" != "$confirm_pass" ]; then
          ADMIN_PASS=""
          log_warn "Passwords did not match. Please try again."
        else
          break
        fi
      done
    fi

    read -r -p "Web panel port [${default_panel_port}]: " INPUT_PANEL_PORT
    PANEL_PORT="${INPUT_PANEL_PORT:-$default_panel_port}"
  else
    PANEL_PORT="$default_panel_port"
  fi

  if ! [[ "$ADMIN_USER" =~ ^[a-zA-Z0-9_]{3,32}$ ]]; then
    log_err "Admin username must be 3-32 characters (letters, numbers, underscore)."
    exit 1
  fi
  if ! [[ "$ADMIN_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
    log_err "Enter a valid admin email address."
    exit 1
  fi
  if [ -z "$ADMIN_PASS" ]; then
    ADMIN_PASS="$(openssl rand -hex 16)"
    ADMIN_PASS_WAS_GENERATED=1
    log_warn "No admin password provided; a random password was generated."
  fi
  if [ "${#ADMIN_PASS}" -lt 12 ]; then
    log_err "Admin password must be at least 12 characters."
    exit 1
  fi
  if ! [[ "$PANEL_PORT" =~ ^[0-9]+$ ]] || [ "$PANEL_PORT" -lt 1 ] || [ "$PANEL_PORT" -gt 65535 ]; then
    log_err "Web panel port must be a number between 1 and 65535."
    exit 1
  fi
  PANEL_PORT=$((10#$PANEL_PORT))

  if ! [[ "$default_api_port" =~ ^[0-9]+$ ]] || [ "$default_api_port" -lt 1 ] || [ "$default_api_port" -gt 65535 ]; then
    log_err "Configured API port must be a number between 1 and 65535."
    exit 1
  fi
  if [ "$PANEL_PORT" -eq "$default_api_port" ]; then
    API_PORT=$((PANEL_PORT + 1))
    if [ "$API_PORT" -gt 65535 ]; then
      API_PORT=$((PANEL_PORT - 1))
    fi
  else
    API_PORT="$default_api_port"
  fi
  if ! [[ "$API_PORT" =~ ^[0-9]+$ ]] || [ "$API_PORT" -lt 1 ] || [ "$API_PORT" -gt 65535 ] || [ "$PANEL_PORT" -eq "$API_PORT" ]; then
    log_err "The selected web panel and API ports are invalid or conflict."
    exit 1
  fi
  if ! port_is_available "$PANEL_PORT"; then
    log_err "Port ${PANEL_PORT} is already in use."
    exit 1
  fi
  if ! port_is_available "$API_PORT"; then
    log_err "API port ${API_PORT} is already in use."
    exit 1
  fi
}



do_install() {
  safe_clear
  printf "${CYAN}${BOLD}"
  echo "================================================================="
  echo "             🚀 Installing vPanel Pro on $OS_NAME                "
  echo "================================================================="
  printf "${NC}\n"

  collect_install_settings

  export PATH="$PATH:$(npm config get prefix 2>/dev/null)/bin:/usr/local/bin:/usr/bin"


  log_info "Step 1/8: Updating APT package repositories..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y

  log_info "Step 2/8: Installing core system dependencies & QEMU packages..."
  apt-get install -y --no-install-recommends \
    git curl wget openssl ca-certificates tar gzip iproute2 procps \
    build-essential python3 make g++ \
    qemu-system-x86 qemu-utils cloud-image-utils


  log_info "Step 3/8: Verifying Node.js 18+ LTS environment..."
  local install_node=0
  if ! command -v node >/dev/null 2>&1; then
    install_node=1
  else
    local cur_ver
    cur_ver=$(node -v | sed 's/^v//; s/\..*$//')
    if [ "${cur_ver:-0}" -lt 18 ]; then
      install_node=1
    fi
  fi

  if [ "$install_node" -eq 1 ]; then
    log_info "Installing Node.js 20.x LTS repository via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
  log_ok "Node.js $(node -v) & NPM $(npm -v) ready"


  log_info "Step 4/8: Checking hardware virtualization (/dev/kvm)..."
  if [ -e "/dev/kvm" ]; then
    chmod 666 /dev/kvm || true
    log_ok "KVM Hardware Acceleration detected (/dev/kvm)"
  else
    log_warn "/dev/kvm not found or disabled. Enabling automatic No-KVM Mode (QEMU TCG Software Emulation)."
    export NO_KVM=1
  fi


  log_info "Step 5/8: Installing NPM packages & building native binaries..."
  npm install --no-audit --no-fund


  log_info "Step 6/8: Setting up environment configuration (.env)..."
  local env_preexisting=0
  local generated_mongo_password
  generated_mongo_password="$(openssl rand -hex 24)"
  if [ -f .env ]; then
    env_preexisting=1
  fi
  if [ ! -f .env ]; then
    log_info "Generating secure .env configuration..."
    if [ -f .env.example ]; then
      cp .env.example .env
    else
      cat << 'EOF' > .env
PANEL_PORT=3001
API_PORT=3002
PANEL_URL=http://localhost:3001
JWT_SECRET=
JWT_EXPIRES=7d
MONGO_URI=mongodb://admin:password@127.0.0.1:27017/vpanel?authSource=admin
AUTO_PORT_MIN=25501
AUTO_PORT_MAX=25600
AUTO_VNC_PORT_MIN=25901
AUTO_VNC_PORT_MAX=26000
AUTO_AGENT_PORT_MIN=26101
AUTO_AGENT_PORT_MAX=26200
ALLOW_REGISTER=1
EOF
    fi
    local secret
    secret="$(openssl rand -hex 32)"
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${secret}|" .env
  else
    log_info ".env already exists, preserving existing configuration."
  fi
  if [ "$env_preexisting" -eq 0 ]; then
    set_env_value PANEL_PORT "$PANEL_PORT"
    set_env_value API_PORT "$API_PORT"
    set_env_value PANEL_URL "http://localhost:${PANEL_PORT}"
    set_env_value MONGO_URI "mongodb://admin:${generated_mongo_password}@127.0.0.1:27017/vpanel?authSource=admin"
  else
    set_env_value PANEL_PORT "$PANEL_PORT"
    set_env_value API_PORT "$API_PORT"
    local current_panel_url
    current_panel_url="$(node -e "require('dotenv').config(); process.stdout.write(process.env.PANEL_URL || '')")"
    if [ -z "$current_panel_url" ] || [[ "$current_panel_url" == "http://localhost" || "$current_panel_url" == "http://localhost:3001" ]]; then
      set_env_value PANEL_URL "http://localhost:${PANEL_PORT}"
    fi
  fi
  chmod 600 .env


  log_info "Step 7/8: Checking MongoDB service & database connection..."
  local mongo_ready=0


  local dproxy=""
  dproxy=$(command -v docker-proxy 2>/dev/null || find /usr/bin /usr/sbin /usr/libexec -name "docker-proxy" 2>/dev/null | head -n 1 || true)
  if [ -n "$dproxy" ]; then
    mkdir -p /usr/libexec/docker
    if [ ! -e /usr/libexec/docker/docker-proxy ]; then
      ln -sf "$dproxy" /usr/libexec/docker/docker-proxy 2>/dev/null || true
    fi
    if [ ! -e /usr/bin/docker-proxy ]; then
      ln -sf "$dproxy" /usr/bin/docker-proxy 2>/dev/null || true
    fi
  fi

  if node -e "require('dotenv').config(); const { MongoClient } = require('mongodb'); const uri = process.env.MONGO_URI || 'mongodb://admin:password@127.0.0.1:27017/vpanel?authSource=admin'; const c = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 }); c.connect().then(() => { c.close(); process.exit(0); }).catch(() => process.exit(1));" >/dev/null 2>&1; then
    log_ok "MongoDB is already reachable and authenticated."
    mongo_ready=1
  fi

  if [ "$mongo_ready" -eq 0 ]; then
    if [ "$env_preexisting" -eq 1 ]; then
      if ! mongo_uri_is_local; then
        log_err "Configured MongoDB is unreachable. MONGO_URI points to a non-local database; check that server. Existing database settings were preserved."
        exit 1
      fi

      log_info "Existing .env points to local MongoDB. Checking for an installed MongoDB service..."
      systemctl start mongod >/dev/null 2>&1 || systemctl start mongodb >/dev/null 2>&1 || true
      if mongo_connection_works; then
        log_ok "Started the existing local MongoDB service."
        mongo_ready=1
      fi

      if [ "$mongo_ready" -eq 0 ] && command -v docker >/dev/null 2>&1 && docker ps -a --format "{{.Names}}" | grep -Fxq "mongodb"; then
        log_info "Starting the existing MongoDB container without changing its data or credentials..."
        docker start mongodb >/dev/null || true
        local existing_attempt=0
        while [ "$existing_attempt" -lt 30 ]; do
          if mongo_connection_works; then
            log_ok "Existing MongoDB container is online and authenticated."
            mongo_ready=1
            break
          fi
          sleep 1
          existing_attempt=$((existing_attempt + 1))
        done
        if [ "$mongo_ready" -eq 0 ]; then
          log_err "Existing MongoDB container did not accept the preserved MONGO_URI. Its container and data were left untouched."
          show_mongo_diagnostics
          exit 1
        fi
      fi

      if [ "$mongo_ready" -eq 0 ]; then
        log_info "No local MongoDB service or container is available. Installing Docker to provide the configured local database..."
        if ! command -v docker >/dev/null 2>&1; then
          apt-get install -y --no-install-recommends docker.io
        fi
        systemctl enable --now docker 2>/dev/null || service docker start
        if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
          log_err "Docker could not start. Check the Docker service before continuing."
          exit 1
        fi
        if docker ps -a --format "{{.Names}}" | grep -Fxq "mongodb"; then
          log_info "Starting the existing MongoDB container without changing its data or credentials..."
          docker start mongodb >/dev/null || true
          local recovered_attempt=0
          while [ "$recovered_attempt" -lt 30 ]; do
            if mongo_connection_works; then
              log_ok "Existing MongoDB container is online and authenticated."
              mongo_ready=1
              break
            fi
            sleep 1
            recovered_attempt=$((recovered_attempt + 1))
          done
          if [ "$mongo_ready" -eq 0 ]; then
            log_err "Existing MongoDB container did not accept the preserved MONGO_URI. Its container and data were left untouched."
            show_mongo_diagnostics
            exit 1
          fi
        fi

        if [ "$mongo_ready" -eq 0 ]; then
        local mongo_port mongo_auth mongo_user mongo_password mongo_env_file
        mongo_port="$(mongo_uri_port)" || {
          log_err "Could not read the local MongoDB port from MONGO_URI."
          exit 1
        }
        if ! [[ "$mongo_port" =~ ^[0-9]+$ ]] || [ "$mongo_port" -lt 1 ] || [ "$mongo_port" -gt 65535 ]; then
          log_err "MONGO_URI contains an invalid local MongoDB port."
          exit 1
        fi
        mongo_auth="$(mongo_uri_auth_base64)" || {
          log_err "Could not read MongoDB credentials from the preserved MONGO_URI."
          exit 1
        }
        mongo_user="$(node -e "process.stdout.write(JSON.parse(Buffer.from(process.argv[1], 'base64').toString()).username)" "$mongo_auth")"
        mongo_password="$(node -e "process.stdout.write(JSON.parse(Buffer.from(process.argv[1], 'base64').toString()).password)" "$mongo_auth")"
        if [[ "$mongo_user$mongo_password" == *$'\n'* || "$mongo_user$mongo_password" == *$'\r'* ]]; then
          log_err "Multiline MongoDB credentials cannot be used to provision a local Docker database."
          exit 1
        fi

        if [ -n "$mongo_user" ]; then
          mongo_env_file="$(mktemp)"
          chmod 600 "$mongo_env_file"
          printf 'MONGO_INITDB_ROOT_USERNAME=%s\nMONGO_INITDB_ROOT_PASSWORD=%s\n' "$mongo_user" "$mongo_password" > "$mongo_env_file"
          if ! docker run -d \
            --name mongodb \
            -p "127.0.0.1:${mongo_port}:27017" \
            --env-file "$mongo_env_file" \
            -v mongodb_data:/data/db \
            --restart unless-stopped \
            mongo:latest >/dev/null; then
            rm -f "$mongo_env_file"
            log_err "MongoDB container could not be created. Existing .env settings and database volumes were preserved."
            exit 1
          fi
          rm -f "$mongo_env_file"
        else
          if ! docker run -d \
            --name mongodb \
            -p "127.0.0.1:${mongo_port}:27017" \
            -v mongodb_data:/data/db \
            --restart unless-stopped \
            mongo:latest >/dev/null; then
            log_err "MongoDB container could not be created. Existing .env settings and database volumes were preserved."
            exit 1
          fi
        fi

        log_info "Waiting for the configured local MongoDB database..."
        local local_attempt=0
        while [ "$local_attempt" -lt 30 ]; do
          if mongo_connection_works; then
            log_ok "Local MongoDB is online using the preserved MONGO_URI."
            mongo_ready=1
            break
          fi
          sleep 1
          local_attempt=$((local_attempt + 1))
        done
        if [ "$mongo_ready" -eq 0 ]; then
          log_err "MongoDB did not accept the existing MONGO_URI. Its container and volume were left in place; check the URI credentials and Docker logs."
          show_mongo_diagnostics
          exit 1
        fi
        fi
      fi
    fi
    if [ "$mongo_ready" -eq 0 ]; then
    if command -v docker >/dev/null 2>&1 && docker ps -a --filter "name=mongodb" --format "{{.Names}}" | grep -q "^mongodb$"; then
      log_err "A MongoDB Docker container already exists but is unreachable with the configured URI. Resolve its credentials before continuing."
      exit 1
    fi
    if ! command -v docker >/dev/null 2>&1; then
      log_info "Installing Docker engine for containerized MongoDB..."
      apt-get install -y --no-install-recommends docker.io
    fi
    systemctl enable --now docker 2>/dev/null || service docker start

    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      if docker ps --filter "name=mongodb" --format "{{.Names}}" | grep -q "^mongodb$"; then
        log_ok "MongoDB Docker container is already running."
      else
        log_info "Deploying MongoDB server container via Docker..."
        docker run -d \
          --name mongodb \
          -p 127.0.0.1:27017:27017 \
          -e MONGO_INITDB_ROOT_USERNAME=admin \
          -e MONGO_INITDB_ROOT_PASSWORD="$generated_mongo_password" \
          -v mongodb_data:/data/db \
          --restart unless-stopped \
          mongo:latest
      fi
    else
      log_err "Docker could not start. Check the Docker service before continuing."
      exit 1
    fi


    log_info "Waiting for MongoDB to become ready..."
    local attempts=0
    while [ $attempts -lt 30 ]; do
      if node -e "require('dotenv').config(); const { MongoClient } = require('mongodb'); const uri = process.env.MONGO_URI || 'mongodb://admin:password@127.0.0.1:27017/vpanel?authSource=admin'; const c = new MongoClient(uri, { serverSelectionTimeoutMS: 1500 }); c.connect().then(() => { c.close(); process.exit(0); }).catch(() => process.exit(1));" >/dev/null 2>&1; then
        mongo_ready=1
        log_ok "MongoDB server is online and ready."
        break
      fi
      sleep 1
      attempts=$((attempts + 1))
    done

    if [ "$mongo_ready" -eq 0 ]; then
      log_err "MongoDB did not become ready within 30 seconds. Check Docker logs and the MONGO_URI in .env."
      show_mongo_diagnostics
      exit 1
    fi
    fi
  fi


  log_info "Initializing storage directories & building assets..."
  mkdir -p data vms public/uploads/logo public/uploads/favicon public/uploads/background public/uploads/music public/uploads/avatar storage/backups storage/logs data/tmp
  node scripts/build.js


  log_info "Step 8/8: Creating Administrator Account..."
  local IN_USER="$ADMIN_USER"
  local IN_EMAIL="$ADMIN_EMAIL"
  local IN_PASS="$ADMIN_PASS"

  log_info "Provisioning Administrator account '${IN_USER}' in database..."
  CREATEUSER_USERNAME="$IN_USER" \
  CREATEUSER_EMAIL="$IN_EMAIL" \
  CREATEUSER_PASSWORD="$IN_PASS" \
  CREATEUSER_NAME="$IN_USER" \
  CREATEUSER_ROLE=admin \
  node -e "
    const auth = require('./src/services/authService');
    const { initDb, closeDb, collections } = require('./src/lib/db');
    const username = process.env.CREATEUSER_USERNAME;
    const email = process.env.CREATEUSER_EMAIL;
    const password = process.env.CREATEUSER_PASSWORD;
    const name = process.env.CREATEUSER_NAME || username;

    (async () => {
      await initDb();
      const existing = await collections.users.findOne({ \$or: [{ username }, { email }] });
      if (existing) {
        await auth.updateUser(existing.id, { username, email, password, role: 'admin', root_admin: 1, suspended: 0, verified: 1 });
        console.log('[✔] Administrator user ' + username + ' password updated and promoted to Root Admin.');
      } else {
        const u = await auth.createUser({ username, email, password, name, role: 'admin', verified: 1 });
        await collections.users.updateOne({ id: u.id }, { \$set: { root_admin: 1 } });
        console.log('[✔] Administrator user ' + username + ' created successfully.');
      }
      await closeDb();
    })().catch((err) => { console.error('[✖] Admin setup error: ' + err.message); process.exit(1); });
  "


  if [ "$USE_PM2" -eq 1 ]; then
    if ! command -v pm2 >/dev/null 2>&1; then
      log_info "Installing PM2 Process Manager globally..."
      npm install -g pm2 --no-audit --no-fund
    fi

    log_info "Starting vPanel Pro cluster with PM2..."
    pm2 delete vpanel >/dev/null 2>&1 || true
    pm2 start ecosystem.config.js || pm2 start src/server.js --name vpanel
    pm2 save
    pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
  else
    log_info "PM2 skipped (--no-pm2). Start manually with: npm start"
  fi

  local s_ip
  s_ip=$(get_server_ip)

  echo ""
  printf "${GREEN}${BOLD}"
  echo "================================================================="
  echo "           🎉 vPanel Pro Successfully Installed & Online!        "
  echo "================================================================="
  printf "${NC}\n"
  echo "  🌐 Web Panel URL:    http://${s_ip}:${PANEL_PORT}"
  echo "  ⚡ REST API URL:     http://${s_ip}:${API_PORT}/api"
  echo "  👤 Admin Username:   ${IN_USER}"
  if [ "$ADMIN_PASS_WAS_GENERATED" -eq 1 ]; then
    echo "  🔑 Admin Password (save now): ${IN_PASS}"
  else
    echo "  🔑 Admin Password:   configured (not displayed)"
  fi
  echo "  📧 Admin Email:      ${IN_EMAIL}"
  echo ""
  if [ "$USE_PM2" -eq 1 ]; then
    echo "  ⚙️  PM2 Process:      pm2 status | pm2 logs vpanel"
  else
    echo "  ⚙️  Run Server:      npm start"
  fi
  echo "================================================================="
  echo ""
}




do_create_user() {
  safe_clear
  printf "${CYAN}${BOLD}"
  echo "================================================================="
  echo "               👤 Create / Reset Administrator User               "
  echo "================================================================="
  printf "${NC}\n"

  export PATH="$PATH:$(npm config get prefix 2>/dev/null)/bin:/usr/local/bin:/usr/bin"

  local A_USER="${ADMIN_USER:-admin}"
  local A_EMAIL="${ADMIN_EMAIL:-}"
  local A_NAME="${ADMIN_NAME:-Administrator}"
  local A_PASS="${ADMIN_PASS:-}"

  if [ -t 0 ] && [ "$NON_INTERACTIVE" -eq 0 ] && [ -z "$ADMIN_PASS" ]; then
    read -r -p "Enter Username [default: ${A_USER}]: " INPUT_USER
    A_USER="${INPUT_USER:-$A_USER}"

    local DEF_EMAIL="${A_USER}@vpanel.local"
    read -r -p "Enter Email [default: ${A_EMAIL:-$DEF_EMAIL}]: " INPUT_EMAIL
    A_EMAIL="${INPUT_EMAIL:-${A_EMAIL:-$DEF_EMAIL}}"

    read -r -p "Enter Display Name [default: ${A_NAME}]: " INPUT_NAME
    A_NAME="${INPUT_NAME:-$A_NAME}"

    read -r -s -p "Enter Password: " INPUT_PASS
    echo ""
    while [ -z "$INPUT_PASS" ]; do
      read -r -s -p "Password cannot be empty. Please enter password: " INPUT_PASS
      echo ""
    done
    A_PASS="$INPUT_PASS"
  fi

  if [ -z "$A_EMAIL" ]; then
    A_EMAIL="${A_USER}@vpanel.local"
  fi

  if [ -z "$A_PASS" ]; then
    A_PASS="$(openssl rand -hex 6)"
    log_warn "Generated secure admin password: ${A_PASS}"
  fi

  log_info "Provisioning Administrator account '${A_USER}' in database..."

  CREATEUSER_USERNAME="$A_USER" \
  CREATEUSER_EMAIL="$A_EMAIL" \
  CREATEUSER_PASSWORD="$A_PASS" \
  CREATEUSER_NAME="$A_NAME" \
  CREATEUSER_ROLE=admin \
  node -e "
    const auth = require('./src/services/authService');
    const { initDb, closeDb, collections } = require('./src/lib/db');
    const username = process.env.CREATEUSER_USERNAME;
    const email = process.env.CREATEUSER_EMAIL;
    const password = process.env.CREATEUSER_PASSWORD;
    const name = process.env.CREATEUSER_NAME || username;

    (async () => {
      await initDb();
      const existing = await collections.users.findOne({ \$or: [{ username }, { email }] });
      if (existing) {
        await auth.updateUser(existing.id, { password, role: 'admin', root_admin: 1, suspended: 0, verified: 1 });
        console.log('[✔] Administrator user ' + username + ' password updated and promoted to Root Admin.');
      } else {
        const u = await auth.createUser({ username, email, password, name, role: 'admin', verified: 1 });
        await collections.users.updateOne({ id: u.id }, { \$set: { root_admin: 1 } });
        console.log('[✔] Administrator user ' + username + ' created successfully.');
      }
      await closeDb();
    })().catch((err) => { console.error('[✖] Error: ' + err.message); process.exit(1); });
  "

  log_ok "Administrator account '${A_USER}' is ready for login."
  echo "  👤 Username: ${A_USER}"
  echo "  🔑 Password: ${A_PASS}"
  echo "  📧 Email:    ${A_EMAIL}"
  echo ""
}




do_update() {
  safe_clear
  printf "${CYAN}${BOLD}"
  echo "================================================================="
  echo "                   🔄 Updating vPanel Pro                        "
  echo "================================================================="
  printf "${NC}\n"

  export PATH="$PATH:$(npm config get prefix 2>/dev/null)/bin:/usr/local/bin:/usr/bin"

  if [ -d ".git" ]; then
    log_info "Fetching latest updates from git repository..."
    git pull || log_warn "Git pull reported conflicts or already up to date."
  else
    log_info "Preserving current source directory..."
  fi

  log_info "Updating npm packages..."
  npm install --no-audit --no-fund

  log_info "Running build & database migrations..."
  node scripts/build.js

  if command -v pm2 >/dev/null 2>&1; then
    log_info "Reloading PM2 cluster with zero downtime..."
    pm2 restart all || pm2 start ecosystem.config.js
    pm2 save
  fi

  log_ok "vPanel Pro has been updated successfully!"
  echo ""
}




do_pm2_menu() {
  export PATH="$PATH:$(npm config get prefix 2>/dev/null)/bin:/usr/local/bin:/usr/bin"
  while true; do
    safe_clear
    printf "${MAGENTA}${BOLD}"
    echo "================================================================="
    echo "                   ⚙️  PM2 Process Manager                       "
    echo "================================================================="
    printf "${NC}\n"
    echo "  [1] 📊 View Status (pm2 status)"
    echo "  [2] 🔄 Restart vPanel (pm2 restart vpanel)"
    echo "  [3] ⏹️  Stop vPanel (pm2 stop vpanel)"
    echo "  [4] ▶️  Start vPanel (pm2 start vpanel)"
    echo "  [5] 📜 View Live Logs (pm2 logs vpanel)"
    echo "  [6] ⚡ Enable Auto-start on System Boot"
    echo "  [7] 🚫 Disable Auto-start on System Boot"
    echo "  [0] 🔙 Back to Main Menu"
    echo ""
    read -r -p "Select PM2 Option [0-7]: " PM2_OPT

    case "$PM2_OPT" in
      1)
        echo ""
        pm2 status
        echo ""
        read -r -p "Press Enter to continue..." _
        ;;
      2)
        log_info "Restarting vPanel cluster..."
        pm2 restart all
        log_ok "vPanel restarted."
        read -r -p "Press Enter to continue..." _
        ;;
      3)
        log_info "Stopping vPanel cluster..."
        pm2 stop all
        log_ok "vPanel stopped."
        read -r -p "Press Enter to continue..." _
        ;;
      4)
        log_info "Starting vPanel cluster..."
        pm2 start ecosystem.config.js || pm2 start all
        log_ok "vPanel started."
        read -r -p "Press Enter to continue..." _
        ;;
      5)
        log_info "Streaming live PM2 logs (Ctrl+C to exit)..."
        pm2 logs vpanel --lines 50
        ;;
      6)
        log_info "Configuring PM2 startup systemd service..."
        pm2 save
        pm2 startup systemd -u root --hp /root || true
        log_ok "Auto-start on boot enabled."
        read -r -p "Press Enter to continue..." _
        ;;
      7)
        log_info "Disabling PM2 startup service..."
        pm2 unstartup systemd || true
        log_ok "Auto-start on boot disabled."
        read -r -p "Press Enter to continue..." _
        ;;
      0)
        break
        ;;
      *)
        log_warn "Invalid option. Please choose between 0 and 7."
        sleep 1
        ;;
    esac
  done
}




do_uninstall() {
  safe_clear
  printf "${RED}${BOLD}"
  echo "================================================================="
  echo "                 🗑️  Uninstall vPanel Pro                        "
  echo "================================================================="
  printf "${NC}\n"

  if [ "$NON_INTERACTIVE" -eq 0 ]; then
    read -r -p "Are you sure you want to completely uninstall vPanel Pro? (y/N): " CONFIRM
    if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
      log_info "Uninstall aborted."
      return
    fi

    read -r -p "Do you want to KEEP your VM disks and database data? [Y/n]: " KEEP_DATA
    KEEP_DATA="${KEEP_DATA:-Y}"
  else
    KEEP_DATA="Y"
  fi

  log_info "Stopping and removing PM2 daemon process..."
  if command -v pm2 >/dev/null 2>&1; then
    pm2 delete vpanel >/dev/null 2>&1 || true
    pm2 save >/dev/null 2>&1 || true
    pm2 unstartup systemd >/dev/null 2>&1 || true
  fi

  if [[ "$KEEP_DATA" == "n" || "$KEEP_DATA" == "N" ]]; then
    log_info "Removing all data, VMs, and uploads..."
    rm -rf data/tmp vms/* public/uploads/logo/* public/uploads/favicon/* public/uploads/background/* public/uploads/music/* public/uploads/avatar/*
    if command -v docker >/dev/null 2>&1; then
      if docker ps -a --format "{{.Names}}" | grep -q "^mongodb$"; then
        log_info "Removing MongoDB Docker container and volume..."
        docker stop mongodb >/dev/null 2>&1 || true
        docker rm mongodb >/dev/null 2>&1 || true
        docker volume rm mongodb_data >/dev/null 2>&1 || true
      fi
    fi
  else
    log_info "Preserving database and VM disks."
  fi

  log_ok "vPanel Pro has been uninstalled successfully."
  echo ""
}




show_menu() {
  while true; do
    safe_clear
    printf "${CYAN}${BOLD}"
    echo "================================================================="
    echo "                   ⚡ vPanel Pro Management Suite                "
    echo "            Full Support: Debian 11/12/13 & Ubuntu 20/22/24      "
    echo "================================================================="
    printf "${NC}"
    echo ""
    echo "  [1] 🚀 1. Install (Full automated install for Debian/Ubuntu)"
    echo "  [2] 👤 2. User Create Admin (Create or reset admin account)"
    echo "  [3] 🔄 3. Update (Pull updates, rebuild & zero-downtime reload)"
    echo "  [4] ⚙️  4. PM2 Management (Restart, logs, boot startup)"
    echo "  [5] 🗑️  5. Uninstall (Safe uninstall wizard)"
    echo "  [0] 🚪 0. Exit"
    echo ""
    printf "${CYAN}=================================================================${NC}\n"
    read -r -p "Enter choice [0-5]: " CHOICE

    case "$CHOICE" in
      1)
        do_install
        read -r -p "Press Enter to return to menu..." _
        ;;
      2)
        do_create_user
        read -r -p "Press Enter to return to menu..." _
        ;;
      3)
        do_update
        read -r -p "Press Enter to return to menu..." _
        ;;
      4)
        do_pm2_menu
        ;;
      5)
        do_uninstall
        read -r -p "Press Enter to return to menu..." _
        ;;
      0)
        log_info "Exiting vPanel Pro Installer. Goodbye!"
        exit 0
        ;;
      *)
        log_warn "Invalid option '$CHOICE'. Please choose 1, 2, 3, 4, 5, or 0."
        sleep 1.2
        ;;
    esac
  done
}


check_root
detect_os

ACTION=""
USE_PM2=1
NON_INTERACTIVE=0
ADMIN_USER="${ADMIN_USERNAME:-${ADMIN_USER:-}}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@vpanel.local}"
ADMIN_PASS="${ADMIN_PASSWORD:-${ADMIN_PASS:-}}"
ADMIN_PASS_WAS_GENERATED=0
ADMIN_USER="${ADMIN_USER:-admin}"
PANEL_PORT="${PANEL_PORT:-3001}"
API_PORT="${API_PORT:-3002}"

while [ $# -gt 0 ]; do
  case "$1" in
    1|--install|install)
      ACTION="install"
      ;;
    2|--create-admin|--create-user|createuser|usercreate|--usercrate)
      ACTION="create_user"
      ;;
    3|--update|update)
      ACTION="update"
      ;;
    4|--pm2|pm2)
      ACTION="pm2"
      ;;
    5|--uninstall|uninstall)
      ACTION="uninstall"
      ;;
    --menu)
      ACTION="menu"
      ;;
    --admin-user|--user|-u)
      shift
      ADMIN_USER="${1:-}"
      ACTION="${ACTION:-install}"
      ;;
    --admin-email|--email|-e)
      shift
      ADMIN_EMAIL="${1:-}"
      ACTION="${ACTION:-install}"
      ;;
    --admin-pass|--password|-p)
      shift
      ADMIN_PASS="${1:-}"
      ACTION="${ACTION:-install}"
      ;;
    --panel-port)
      shift
      PANEL_PORT="${1:-}"
      ACTION="${ACTION:-install}"
      ;;
    --no-pm2)
      USE_PM2=0
      ;;
    -y|--yes|--non-interactive)
      NON_INTERACTIVE=1
      ;;
    --branch)
      shift
      BRANCH="${1:-}"
      if [ -n "$BRANCH" ]; then
        log_info "Switching to branch: $BRANCH"
        git fetch --all || true
        git checkout "$BRANCH" || git checkout -B "$BRANCH" origin/"$BRANCH" || true
      fi
      ;;
    -h|--help)
      echo "Usage: sudo bash install.sh [action] [options]"
      echo ""
      echo "Actions:"
      echo "  1, install, --install           Full automated installation"
      echo "  2, createuser, --create-admin   Create or reset admin account"
      echo "  3, update, --update             Pull updates and rebuild"
      echo "  4, pm2, --pm2                   PM2 cluster management menu"
      echo "  5, uninstall, --uninstall       Uninstall vPanel Pro"
      echo "  --menu                           Open management menu"
      echo ""
      echo "Options:"
      echo "  --admin-user <user>             Admin username (default: admin)"
      echo "  --admin-email <email>           Admin email (default: admin@vpanel.local)"
      echo "  --admin-pass <pass>             Admin password (interactive prompt recommended)"
      echo "  --panel-port <port>             Web panel port (default: 3001)"
      echo "  --no-pm2                        Skip PM2 process manager"
      echo "  -y, --non-interactive           Run without interactive prompts"
      echo "  -h, --help                      Show this help message"
      exit 0
      ;;
    *)
      log_warn "Unknown option: $1"
      ;;
  esac
  shift
done

if [ -n "$ACTION" ]; then
  case "$ACTION" in
    install)     do_install ;;
    create_user) do_create_user ;;
    update)      do_update ;;
    pm2)         do_pm2_menu ;;
    uninstall)   do_uninstall ;;
    menu)        show_menu ;;
  esac
else
  do_install
fi
