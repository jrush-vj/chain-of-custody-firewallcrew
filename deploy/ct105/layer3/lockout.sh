#!/usr/bin/env bash
# Demo Layer 3: push the demo account out, right now, without waiting for the automatic trigger.
# Real action, scoped to the coc-demo-intruder account only (l3_lockout.py checks this independently
# every time it runs: never root, never the account running this script, never a system account).
#
# Run on ct105 as root:
#   bash /opt/chain-of-custody/deploy/ct105/layer3/lockout.sh ["reason text"]
set -uo pipefail

if [ "${COC_SKIP_HOST_CHECK:-0}" != 1 ] && [ "$(hostname)" != ct105-ai ]; then
  echo "WRONG HOST: $(hostname)"; exit 1
fi

here="$(cd "$(dirname "$0")" && pwd)"
reason="${1:-manual lockout demo}"

output="$(python3 "$here/l3_lockout.py" lock "$reason")" || { echo "$output"; exit 1; }
echo "$output" | grep -v '^{'   # the human-readable lines (status + keys); the last line is the JSON event

event_json="$(echo "$output" | tail -n1)"
if echo "$event_json" | python3 "$here/post_event.py" 2>/dev/null; then
  :
else
  echo "(witness report skipped or failed; the lockout itself still happened — see the evidence file above)"
fi
