#!/usr/bin/env bash
# SiliconHost Wings configuration applier
#
# Applies panel connection settings to an already installed Wings daemon.
# Use this when the panel's configuration script needs to be applied manually:
#
#   sudo bash wings-config.sh --panel-url http://1.2.3.4:3001 \
#     --node-id 2 --token <node-token> --name "Node 2" \
#     --ip 5.6.7.8 --ssh-user root --ssh-password 'secret'
#
# Or export PANEL_URL / API_KEY / NODE_ID / NODE_NAME / VPS_IP / SSH_USER /
# SSH_PASSWORD and run it without arguments.
set -euo pipefail

WINGS_DIR="${WINGS_DIR:-/opt/siliconhost-wings}"
SERVICE_NAME="wings"
LOG_DIR="/var/log/wings"

PANEL_URL="${PANEL_URL:-}"
NODE_TOKEN="${API_KEY:-${NODE_TOKEN:-}}"
NODE_ID="${NODE_ID:-}"
NODE_NAME="${NODE_NAME:-}"
VPS_IP="${VPS_IP:-}"
SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
SSH_PASSWORD="${SSH_PASSWORD:-}"

log_info() { printf '\033[1;34m[INFO]\033[0m %b\n' "$*"; }
log_ok()   { printf '\033[1;32m[OK]\033[0m %b\n' "$*"; }
log_err()  { printf '\033[1;31m[ERR]\033[0m %b\n' "$*" >&2; }

usage() {
  cat <<'EOF'
Usage: sudo bash wings-config.sh [options]

  --panel-url <url>       Panel base URL
  --node-id <id>          Node ID from the panel
  --token <token>         Node token from the panel
  --name <name>           Node name
  --ip <address>          Public IP of this VPS
  --ssh-user <user>       SSH user for panel control (default: root)
  --ssh-port <port>       SSH port (default: 22)
  --ssh-password <pass>   SSH password for panel control
  -h, --help              Show this help
EOF
}

yaml_quote() {
  local value="${1//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    log_err "This script must be run as root. Use: sudo bash $0"
    exit 1
  fi
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --panel-url) PANEL_URL="${2:-}"; shift 2 ;;
      --node-id) NODE_ID="${2:-}"; shift 2 ;;
      --token|--api-key) NODE_TOKEN="${2:-}"; shift 2 ;;
      --name|--node-name) NODE_NAME="${2:-}"; shift 2 ;;
      --ip) VPS_IP="${2:-}"; shift 2 ;;
      --ssh-user) SSH_USER="${2:-}"; shift 2 ;;
      --ssh-port) SSH_PORT="${2:-}"; shift 2 ;;
      --ssh-password) SSH_PASSWORD="${2:-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) log_err "Unknown option: $1"; exit 1 ;;
    esac
  done
}

validate() {
  if [ -z "$PANEL_URL" ] || [ -z "$NODE_ID" ] || [ -z "$NODE_TOKEN" ]; then
    log_err "PANEL_URL, NODE_ID and NODE token are required."
    echo ""
    usage
    exit 1
  fi
  case "$PANEL_URL" in
    http://*|https://*) ;;
    *) log_err "Panel URL must start with http:// or https://"; exit 1 ;;
  esac
  [[ "$NODE_ID" =~ ^[0-9]+$ ]] || { log_err "Node ID must be a number"; exit 1; }
  PANEL_URL="${PANEL_URL%/}"
  NODE_NAME="${NODE_NAME:-Wings Node ${NODE_ID}}"
}

write_config() {
  if [ ! -d "$WINGS_DIR/src" ]; then
    log_err "Wings is not installed at $WINGS_DIR."
    log_err "Run the panel installer and choose 6 (Install Wings) on this VPS first."
    exit 1
  fi

  log_info "Writing $WINGS_DIR/config/wings.yml..."
  mkdir -p "$WINGS_DIR/config" "$LOG_DIR" /var/lib/wings/vms /var/lib/wings/images
  umask 077
  cat > "$WINGS_DIR/config/wings.yml" <<EOF
panel:
  url: $(yaml_quote "$PANEL_URL")
  api_key: $(yaml_quote "$NODE_TOKEN")

node:
  id: $NODE_ID
  name: $(yaml_quote "$NODE_NAME")

vps:
  ip: $(yaml_quote "$VPS_IP")
  ssh_user: $(yaml_quote "$SSH_USER")
  ssh_port: $SSH_PORT
  ssh_password: $(yaml_quote "$SSH_PASSWORD")

storage:
  vm_dir: "/var/lib/wings/vms"
  images_dir: "/var/lib/wings/images"

ssh:
  port: 22
  user: "root"
  key_path: "/root/.ssh/id_rsa"

logging:
  level: "info"
  file: "/var/log/wings/wings.log"
EOF
  cat > "$WINGS_DIR/config/.env" <<EOF
WINGS_CONFIG=$WINGS_DIR/config/wings.yml
WINGS_LOG_FILE=$LOG_DIR/wings.log
NODE_ENV=production
EOF
  chmod 600 "$WINGS_DIR/config/wings.yml" "$WINGS_DIR/config/.env"
  umask 022
  log_ok "Configuration saved"
}

restart_service() {
  if ! systemctl list-unit-files 2>/dev/null | grep -q '^wings.service'; then
    log_err "The wings systemd service is not installed. Run install-wings.sh first."
    exit 1
  fi

  log_info "Restarting Wings..."
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME"
  sleep 3

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log_ok "Wings is running and connected to $PANEL_URL (node $NODE_ID)"
  else
    log_err "Wings failed to start. Recent logs:"
    journalctl -u "$SERVICE_NAME" -n 40 --no-pager || true
    exit 1
  fi
}

main() {
  parse_args "$@"
  require_root
  validate
  write_config
  restart_service
}

main "$@"
