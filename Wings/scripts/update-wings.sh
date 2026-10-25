#!/usr/bin/env bash
# SiliconHost Wings updater
set -euo pipefail

WINGS_DIR="${WINGS_DIR:-/opt/siliconhost-wings}"
SERVICE_NAME="wings"
SOURCE_DIR=""

log_info() { printf '\033[1;34m[INFO]\033[0m %b\n' "$*"; }
log_ok()   { printf '\033[1;32m[OK]\033[0m %b\n' "$*"; }
log_warn() { printf '\033[1;33m[WARN]\033[0m %b\n' "$*"; }
log_err()  { printf '\033[1;31m[ERR]\033[0m %b\n' "$*" >&2; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    log_err "This script must be run as root"
    exit 1
  fi
}

usage() {
  cat <<'EOF'
Usage: sudo bash update-wings.sh [--source <dir>]

  --source <dir>   Wings source directory to copy from (default: this script's parent)
EOF
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --source) SOURCE_DIR="${2:-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) log_warn "Unknown option: $1"; shift ;;
    esac
  done

  require_root
  log_info "=== SiliconHost Wings Updater ==="

  if [ ! -d "$WINGS_DIR/src" ]; then
    log_err "Wings is not installed at $WINGS_DIR. Run install-wings.sh first."
    exit 1
  fi

  local src="${SOURCE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  if [ ! -f "$src/src/index.js" ]; then
    log_err "No Wings source found at $src (expected src/index.js)."
    exit 1
  fi

  log_info "Stopping Wings..."
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true

  if [ "$(cd "$src" && pwd)" != "$(cd "$WINGS_DIR" && pwd)" ]; then
    log_info "Copying updated Wings files from $src..."
    rm -rf "$WINGS_DIR/src"
    cp -a "$src/src" "$src/scripts" "$src/systemd" "$src/package.json" "$WINGS_DIR/"
  fi

  log_info "Updating Node.js dependencies..."
  ( cd "$WINGS_DIR" && npm install --omit=dev --no-audit --no-fund >/tmp/wings-npm-update.log 2>&1 ) || {
    log_err "npm install failed. See /tmp/wings-npm-update.log"
    tail -n 30 /tmp/wings-npm-update.log >&2 || true
    exit 1
  }

  if [ -f "$WINGS_DIR/systemd/wings.service" ]; then
    cp "$WINGS_DIR/systemd/wings.service" /etc/systemd/system/wings.service
    sed -i "s|^ExecStart=.*|ExecStart=$(command -v node) src/index.js|" /etc/systemd/system/wings.service
    systemctl daemon-reload
  fi

  log_info "Starting Wings..."
  systemctl start "$SERVICE_NAME"
  sleep 3

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    log_ok "Wings updated and restarted successfully"
  else
    log_err "Wings failed to start after the update"
    journalctl -u "$SERVICE_NAME" -n 40 --no-pager || true
    exit 1
  fi
}

main "$@"
