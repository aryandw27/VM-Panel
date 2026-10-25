#!/usr/bin/env bash
# SiliconHost Wings uninstaller
set -euo pipefail

WINGS_DIR="${WINGS_DIR:-/opt/siliconhost-wings}"
SERVICE_NAME="wings"
ASSUME_YES=0
PURGE=0

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

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -y|--yes|--non-interactive) ASSUME_YES=1; shift ;;
      --purge) PURGE=1; shift ;;
      -h|--help)
        echo "Usage: sudo bash uninstall-wings.sh [-y] [--purge]"
        echo "  -y        Do not prompt; keep VM storage and logs"
        echo "  --purge   Also delete /var/lib/wings (all VM disks) and /var/log/wings"
        exit 0
        ;;
      *) log_warn "Unknown option: $1"; shift ;;
    esac
  done

  require_root
  log_info "=== SiliconHost Wings Uninstaller ==="

  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    log_info "Stopping Wings service..."
    systemctl stop "$SERVICE_NAME" || true
  fi
  if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    log_info "Disabling Wings service..."
    systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true
  fi

  if [ -f /etc/systemd/system/wings.service ]; then
    log_info "Removing systemd service..."
    rm -f /etc/systemd/system/wings.service
    systemctl daemon-reload
  fi

  if [ "$PURGE" -eq 1 ]; then
    log_warn "Removing Wings directory, VM storage and logs..."
    rm -rf "$WINGS_DIR" /var/lib/wings /var/log/wings
    log_ok "Wings removed completely"
    return
  fi

  if [ "$ASSUME_YES" -eq 0 ]; then
    read -r -p "Remove the Wings program directory ($WINGS_DIR)? [y/N] " reply
    if [[ "$reply" =~ ^[Yy]$ ]]; then
      rm -rf "$WINGS_DIR"
      log_ok "Wings program directory removed"
    else
      log_info "Program directory preserved at $WINGS_DIR"
    fi

    read -r -p "Delete ALL VM disks in /var/lib/wings? [y/N] " reply_vms
    if [[ "$reply_vms" =~ ^[Yy]$ ]]; then
      rm -rf /var/lib/wings
      log_ok "VM storage removed"
    else
      log_info "VM storage preserved at /var/lib/wings"
    fi
  else
    rm -rf "$WINGS_DIR"
    log_info "VM storage preserved at /var/lib/wings"
  fi

  log_ok "=== Wings uninstalled ==="
}

main "$@"
