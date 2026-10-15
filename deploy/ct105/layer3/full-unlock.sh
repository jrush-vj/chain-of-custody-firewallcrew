#!/usr/bin/env bash
# Restore full-lockout accounts from the saved state. Run from the Proxmox console or break-glass
# session; this does not restart the banking site.
set -euo pipefail
if [ "${COC_L3_MODE:-demo}" != "full" ]; then
  echo "refusing: set COC_L3_MODE=full explicitly" >&2
  exit 1
fi
here="$(cd "$(dirname "$0")" && pwd)"
exec bash "$here/unlock.sh" "$@"
