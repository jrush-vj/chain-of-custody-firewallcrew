#!/usr/bin/env bash
# Derive monitor environment from banking-system/.env.
# Called by test-stack.sh lab-up to set up the lab container before starting monitor.py.
set -eo pipefail

app_dir="${1:-.}"
env_file="$app_dir/banking-system/.env"

[ -f "$env_file" ] || { echo "missing $env_file"; exit 1; }

# Source the .env and export the variables monitor.py expects.
set -a
source "$env_file"
set +a

# Witness and bank endpoints (local Docker stack).
export WITNESS_URL="${WITNESS_URL:-http://127.0.0.1:8787}"
export WITNESS_NODE_ID="${WITNESS_NODE_ID:-ct105-ai}"
export WITNESS_HMAC_SECRET="${WITNESS_HMAC_SECRET:?must be set in .env}"

# Layer 1.
export WATCH_DIR="${WATCH_DIR:-/var/log/bank-demo}"
export STATE_DIR="${STATE_DIR:-/var/lib/coc-layer1}"
export COMMANDS_SPOOL="${COMMANDS_SPOOL:-/var/spool/coc-layer1/commands.jsonl}"
export TRIP_BIN="${TRIP_BIN:-/usr/local/coc-trip/bin}"
export PROFILE_FILE="${PROFILE_FILE:-/etc/profile.d/coc-layer1.sh}"

# Layer 2.
export COC_PG_CONTAINER="${COC_PG_CONTAINER:-banking-postgres}"
export COC_DB_NAME="${COC_DB_NAME:-bankingsystem}"
export COC_DB_ROLE="${COC_DB_ROLE:-coc_reader}"

# Layer 3.
export COC_L3_STATE="${COC_L3_STATE:-/var/lib/coc-layer3}"
export COC_WITNESS_CUT_FLAG="${COC_WITNESS_CUT_FLAG:-/var/lib/coc-demo/witness-cut}"
export COC_BANK_ENV="$env_file"
export COC_BANK_COMPOSE="$app_dir/banking-system/docker-compose.yml"
export RESTORE_SCRIPT="$app_dir/deploy/ct105/restore-normal.sh"

# Shorter timers for demo.
export WITNESS_UNWITNESSED_GRACE_S="${WITNESS_UNWITNESSED_GRACE_S:-20}"
export QUARANTINE_AFTER_S="${QUARANTINE_AFTER_S:-45}"
export HEARTBEAT_S="${HEARTBEAT_S:-30}"
export POLL_S="${POLL_S:-5}"

# Guarantee docker socket and compose file.
export COMPOSE_FILE="docker-compose.yml:docker-compose.local.yml"

# Print sourced vars for debug.
echo "Monitor environment loaded from $env_file" >&2
