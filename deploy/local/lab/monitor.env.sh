#!/usr/bin/env bash
# Sourced inside the coc-lab container: the environment the ct105 monitor and attack scripts expect,
# pointed at the local stack instead of production. Path defaults (/opt/chain-of-custody, /var/lib/*)
# already match ct105 because the repo is mounted at /opt/chain-of-custody.
bank_env=/opt/chain-of-custody/banking-system/.env
[ -f "$bank_env" ] || { echo "lab: missing $bank_env (run test-stack.sh up first)" >&2; return 1 2>/dev/null || exit 1; }
env_value() { grep -E "^$1=" "$bank_env" | tail -1 | cut -d= -f2- | tr -d '\r'; }

witness=http://banking-witness:8787
export WITNESS_URL="$witness"
export WITNESS_NODE_ID="$(env_value WITNESS_NODE_ID)"
export WITNESS_HMAC_SECRET="$(env_value WITNESS_HMAC_SECRET)"
# The attack scripts default to the production witness; keep them on the local one.
export WITNESS_MISMATCHES_URL="$witness/mismatches"
export WITNESS_STATUS_URL="$witness/status"
export WITNESS_HEALTH_URL="$witness/health"
# coc.sh status checks, from inside the stack network.
export BACKEND_HEALTH_URL=http://banking-witness:8080/health
export FRONTEND_URL=http://banking-frontend/
export COMPOSE_FILE=docker-compose.yml:docker-compose.local.yml
export PYTHONUNBUFFERED=1
