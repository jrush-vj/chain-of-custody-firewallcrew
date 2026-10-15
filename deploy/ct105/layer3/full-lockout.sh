#!/usr/bin/env bash
# Layer 3 FULL lockout: every configured interactive user, root included. NOT the safe demo-account
# script (that's lockout.sh). This one can take you off the box for real.
#
# Read RECOVERY.md and verify the break-glass path actually works — on a CLONE of this host, per
# TEST-ON-CLONE.md — before you ever add --real here. By default this only prints what it would do.
#
#   bash full-lockout.sh "reason"            dry run: prints every command, touches nothing
#   bash full-lockout.sh "reason" --real      the real thing: requires BOTH of the guards below
#
# Guards, both required for --real:
#   1. COC_I_HAVE_VERIFIED_RECOVERY=1 in the environment (you tested the break-glass path works)
#   2. typing the confirmation phrase this script asks for, interactively
set -uo pipefail

if [ "${COC_SKIP_HOST_CHECK:-0}" != 1 ] && [ "$(hostname)" != ct105-ai ]; then
  echo "WRONG HOST: $(hostname)"; exit 1
fi

here="$(cd "$(dirname "$0")" && pwd)"
real=0
args=()
for a in "$@"; do
  if [ "$a" = "--real" ]; then real=1; else args+=("$a"); fi
done
reason="${args[0]:-manual full-lockout demo}"

if [ "$real" = 1 ]; then
  if [ "${COC_I_HAVE_VERIFIED_RECOVERY:-0}" != 1 ]; then
    echo "REFUSED: set COC_I_HAVE_VERIFIED_RECOVERY=1 only after you have actually tested the"
    echo "break-glass recovery path from RECOVERY.md — this can lock out root, and if the network"
    echo "is also down, SSH is gone until that path gets you back in."
    exit 1
  fi
  echo "This will REALLY lock out: $(python3 "$here/l3_full_lockout.py" users | tr '\n' ' ')"
  echo "including root. Type exactly:  LOCK OUT ROOT"
  read -r -p "> " confirm
  if [ "$confirm" != "LOCK OUT ROOT" ]; then
    echo "confirmation text did not match; nothing was done"
    exit 1
  fi
fi

python3 "$here/l3_full_lockout.py" lock "$reason" $( [ "$real" = 1 ] && echo --real )
