#!/usr/bin/env bash
set -euo pipefail
trap 'echo "TRIAGE_STOP: scheduled tick failed at line $LINENO" >&2' ERR

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [ -f .factory/STOP ]; then
  echo "STOPPED: .factory/STOP is present."
  exit 0
fi

LINEAR_API_KEY="$(security find-generic-password -a "${USER:?USER must be set}" -s com.mhoo.dark-factory.linear -w 2>/dev/null)" || {
  echo "STOPPED: Linear credential is unavailable in the macOS Keychain." >&2
  exit 78
}
export LINEAR_API_KEY
trap 'unset LINEAR_API_KEY' EXIT

# Run the triage module from the repository root so its `factory.*` imports resolve
# exactly as they do under the test runner and in the Worker-side control plane.
python3 -m factory.linear_triage "$@"
bash factory/orchestrator.sh "$@"
