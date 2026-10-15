#!/usr/bin/env bash
# Reverse of full-lockout.sh: unlocks every configured user, restores /etc/nologin, brings the site
# back up. Run this from whatever console/break-glass path RECOVERY.md describes, since if a real
# full-lockout happened and the network is cut, SSH into this host does not work.
#
#   bash full-unlock.sh               dry run: prints what would be restored
#   bash full-unlock.sh --real        actually restores access
set -uo pipefail

if [ "${COC_SKIP_HOST_CHECK:-0}" != 1 ] && [ "$(hostname)" != ct105-ai ]; then
  echo "WRONG HOST: $(hostname)"; exit 1
fi

here="$(cd "$(dirname "$0")" && pwd)"
real=0
for a in "$@"; do [ "$a" = "--real" ] && real=1; done

python3 "$here/l3_full_lockout.py" unlock $( [ "$real" = 1 ] && echo --real )
