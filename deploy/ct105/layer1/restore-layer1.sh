#!/usr/bin/env bash
# Put the protected bank log back to its approved content, from the baseline the monitor keeps.
# The monitor reports each restored file as "back to the approved content". Run on ct105 as root:
#   bash /opt/chain-of-custody/deploy/ct105/layer1/restore-layer1.sh
set -uo pipefail

if [ "${COC_SKIP_HOST_CHECK:-0}" != 1 ] && [ "$(hostname)" != ct105-ai ]; then
  echo "WRONG HOST: $(hostname)"; exit 1
fi

watch="${WATCH_DIR:-/var/log/bank-demo}"
baseline="${STATE_DIR:-/var/lib/coc-layer1}/baseline"

if [ ! -d "$baseline" ] || [ -z "$(ls -A "$baseline" 2>/dev/null)" ]; then
  echo "no approved baseline at $baseline; run monitor.py approve first"; exit 1
fi

mkdir -p "$watch"
for approved in "$baseline"/*; do
  name="$(basename "$approved")"
  # Write into the existing file (cat >), so the path and its permissions stay the same.
  cat "$approved" > "$watch/$name"
  echo "restored $watch/$name from the approved copy"
done
echo "Layer 1 restore finished"
