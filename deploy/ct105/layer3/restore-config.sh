#!/usr/bin/env bash
# Put the approved witness link settings back (WITNESS_URL / WITNESS_NODE_ID in the bank's .env, and
# docker-compose.yml), then recreate the backend container, but only if something was restored.
# Nothing else in .env is read or changed. Run on ct105 as root:
#   bash /opt/chain-of-custody/deploy/ct105/layer3/restore-config.sh
set -uo pipefail

if [ "${COC_SKIP_HOST_CHECK:-0}" != 1 ] && [ "$(hostname)" != ct105-ai ]; then
  echo "WRONG HOST: $(hostname)"; exit 1
fi

here="$(cd "$(dirname "$0")" && pwd)"
app_dir="${APP_DIR:-/opt/chain-of-custody/banking-system}"

if ! output="$(python3 "$here/l3_config_guard.py" restore 2>&1)"; then
  echo "config restore failed: $output"; exit 1
fi
[ -n "$output" ] && echo "$output"

if printf '%s\n' "$output" | grep -q '^restored config:'; then
  # The backend only reads its settings when its container is created, so recreate just that one
  # (not the database) so it reconnects to the witness.
  if cd "$app_dir" && docker compose up -d --no-deps backend; then
    echo "backend recreated with the approved settings"
  else
    echo "backend could not be recreated; run: cd $app_dir && docker compose up -d --no-deps backend"
    exit 1
  fi
else
  echo "witness link settings already match the approved ones"
fi
