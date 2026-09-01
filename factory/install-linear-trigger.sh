#!/usr/bin/env bash
set -euo pipefail
trap 'echo "TRIGGER_STOP: scheduler installer failed at line $LINENO" >&2' ERR

ROOT="$(git rev-parse --show-toplevel)"
TASK_NAME="mhoo-dark-factory-linear-triage"
LOGFILE="$ROOT/factory-linear-triage.log"
ACTION="${1:---status}"
CRON_LINE="*/30 * * * * cd $ROOT && bash factory/tick.sh >> $LOGFILE 2>&1  # $TASK_NAME"

status() {
  if crontab -l 2>/dev/null | grep -qF "$TASK_NAME"; then
    echo "ARMED: $(crontab -l 2>/dev/null | grep -F "$TASK_NAME")"
  else
    echo "NOT ARMED: $TASK_NAME"
  fi
}

install() {
  security find-generic-password -a "${USER:?USER must be set}" -s com.mhoo.dark-factory.linear -w >/dev/null 2>&1 || {
    echo "REFUSING: store the Linear credential first with bash factory/store-linear-key.sh" >&2
    exit 78
  }
  { crontab -l 2>/dev/null || true; } | grep -vF "$TASK_NAME" | crontab -
  { crontab -l 2>/dev/null || true; printf '%s\n' "$CRON_LINE"; } | crontab -
  echo "ARMED: every 30 minutes; log: $LOGFILE"
}

remove() {
  { crontab -l 2>/dev/null || true; } | grep -vF "$TASK_NAME" | crontab -
  echo "DISARMED: $TASK_NAME"
}

case "$ACTION" in
  --status) status ;;
  --install) install ;;
  --remove) remove ;;
  *) echo "usage: bash factory/install-linear-trigger.sh [--status|--install|--remove]" >&2; exit 2 ;;
esac
