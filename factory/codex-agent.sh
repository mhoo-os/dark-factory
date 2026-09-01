#!/usr/bin/env bash
set -euo pipefail
trap 'echo "FACTORY_AGENT_STOP: Codex launcher failed at line $LINENO" >&2' ERR

if [ "${1:-}" != "-p" ] || [ -z "${2:-}" ]; then
  echo "usage: codex-agent.sh -p <prompt>" >&2
  exit 2
fi

ROOT="$(git rev-parse --show-toplevel)"
WORKSPACE_ROOT="$(dirname "$ROOT")"
exec codex exec --sandbox danger-full-access --dangerously-bypass-approvals-and-sandbox \
  --cd "$ROOT" --add-dir "$WORKSPACE_ROOT" "$2"
