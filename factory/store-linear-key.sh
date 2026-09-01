#!/usr/bin/env bash
set -euo pipefail
trap 'echo "CREDENTIAL_STOP: Keychain write failed at line $LINENO" >&2' ERR

SERVICE="com.mhoo.dark-factory.linear"
ACCOUNT="${USER:?USER must be set}"

printf 'Linear personal API key: ' >&2
IFS= read -r -s LINEAR_KEY
printf '\n' >&2

if [ -z "$LINEAR_KEY" ]; then
  echo "REFUSING: no Linear API key provided." >&2
  exit 2
fi

security add-generic-password -U -a "$ACCOUNT" -s "$SERVICE" -w "$LINEAR_KEY" >/dev/null
unset LINEAR_KEY
echo "Stored the Linear credential in the macOS Keychain service $SERVICE."
