#!/usr/bin/env bash
# Unlock the demo account: needs 2 of the 3 printed demo keys. Re-enables its login for real.
#
# Run on ct105 as root:
#   bash /opt/chain-of-custody/deploy/ct105/layer3/unlock.sh "KEY-ONE" "KEY-TWO"
set -uo pipefail

if [ "${COC_SKIP_HOST_CHECK:-0}" != 1 ] && [ "$(hostname)" != ct105-ai ]; then
  echo "WRONG HOST: $(hostname)"; exit 1
fi

here="$(cd "$(dirname "$0")" && pwd)"

if [ "$#" -lt 2 ]; then
  echo "usage: unlock.sh KEY KEY   (any 2 of the 3; run 'python3 $here/l3_lockout.py keys' to see them)"
  exit 2
fi

output="$(python3 "$here/l3_lockout.py" unlock "$@")" || { echo "$output"; exit 1; }
echo "$output" | grep -v '^{'

event_json="$(echo "$output" | tail -n1)"
if echo "$event_json" | python3 "$here/post_event.py" 2>/dev/null; then
  :
else
  echo "(witness report skipped or failed; the account is still unlocked — see the evidence file above)"
fi
