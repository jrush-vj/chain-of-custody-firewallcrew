#!/usr/bin/env bash
# Trigger the configured Layer 3 mode immediately instead of waiting for the automatic trigger.
# The default mode is demo-only. Full mode requires its explicit confirmation and all prerequisites.
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
