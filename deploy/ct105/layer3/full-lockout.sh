#!/usr/bin/env bash
# Compatibility entry point for the full mode. The scope is selected only by environment config.
set -euo pipefail
if [ "${COC_L3_MODE:-demo}" != "full" ]; then
  echo "refusing: set COC_L3_MODE=full explicitly" >&2
  exit 1
fi
if [ "${COC_L3_FULL_CONFIRM:-}" != "I_UNDERSTAND_ROOT_LOCKOUT" ]; then
  echo "refusing: full-lockout confirmation is missing" >&2
  exit 1
fi
here="$(cd "$(dirname "$0")" && pwd)"
exec bash "$here/lockout.sh" "${1:-manual full-lockout}"
