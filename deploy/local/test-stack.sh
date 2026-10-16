#!/usr/bin/env bash
# LOCAL TESTING ONLY: run every component of the chain-of-custody stack in Docker on this machine.
#
#   bash deploy/local/test-stack.sh up        create a throwaway .env (if none), build and start
#                                             postgres, backend, frontend (nginx) and the witness
#   bash deploy/local/test-stack.sh test      HTTP/E2E checks: nginx, auth, witnessed transactions,
#                                             hardening, Layer 2 reconciliation + tamper detection
#   bash deploy/local/test-stack.sh unit      witness tests (node) and Layer 1/2/3 + traffic Python tests
#   bash deploy/local/test-stack.sh layer2    create the coc_reader role and prove its limits (real psql)
#   bash deploy/local/test-stack.sh traffic   run the traffic simulator for a few real transactions
#   bash deploy/local/test-stack.sh hotpatch  exercise coc.sh hotpatch for backend and frontend
#   bash deploy/local/test-stack.sh witness-restart   reattach the witness after any backend restart
#   bash deploy/local/test-stack.sh all       up + every check above
#   bash deploy/local/test-stack.sh down      stop and delete the stack, its volumes and the throwaway .env
#
# Ports (loopback only): 3001 site, 8081 backend, 8787 witness, 5432 postgres.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
if command -v cygpath >/dev/null 2>&1; then here="$(cygpath -m "$here")"; repo="$(cygpath -m "$repo")"; fi
app="$repo/banking-system"
env_file="$app/.env"
marker='# LOCAL TEST ONLY (deploy/local/test-stack.sh)'

compose() { docker compose --project-directory "$app" -f "$app/docker-compose.yml" -f "$app/docker-compose.local.yml" "$@"; }
say() { printf '\n\033[1m### %s\033[0m\n' "$*"; }
rand() { node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" 2>/dev/null \
  || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

make_env() {
  if [ -f "$env_file" ]; then
    grep -qF "$marker" "$env_file" || { echo "refusing: $env_file exists and is not a local test file"; exit 1; }
    return
  fi
  cat > "$env_file" <<EOF
$marker
DB_NAME=bankingsystem
DB_USER=bank_local
DB_PASSWORD=$(rand)
JWT_SECRET=$(rand)
DATA_ENCRYPTION_KEY=$(rand)
NODE_ENV=production
COOKIE_SECURE=false
CORS_ORIGINS=http://127.0.0.1:3001
EXTERNAL_PAYMENTS_API_KEY=$(rand)
WITNESS_URL=http://127.0.0.1:8787
WITNESS_NODE_ID=ct105-ai
WITNESS_HMAC_SECRET=$(rand)
WITNESS_RECONCILE_AUTH=required
EOF
  echo "created throwaway $env_file"
}

cmd_up() {
  make_env
  say "building and starting postgres, backend, frontend, witness"
  compose up -d --build
  for url in http://127.0.0.1:8081/health http://127.0.0.1:3001/ http://127.0.0.1:8787/health; do
    for _ in $(seq 1 45); do curl -fs "$url" >/dev/null && break; sleep 2; done
    curl -fs "$url" >/dev/null && echo "up: $url" || { echo "NOT UP: $url"; compose ps; exit 1; }
  done
}

cmd_test() { say "end-to-end component checks"; node "$here/e2e.mjs" "$env_file"; }

cmd_unit() {
  say "witness unit tests (node:18)"
  docker run --rm -v "$repo/witness:/w:ro" -w /w node:18-alpine node --test --test-reporter=spec 2>&1 \
    | grep -E '^ℹ (tests|pass|fail)|✖' || true
  say "Layer 1/2/3 and traffic simulator tests (python:3.12)"
  docker run --rm -v "$repo/deploy/ct105:/src:ro" python:3.12-alpine sh -c '
    cp -r /src /t && rc=0
    for d in layer1 layer2 layer3 traffic; do
      echo "--- $d"; (cd /t/$d && python -m unittest discover -p "test_*.py" 2>&1 | tail -4) || rc=1
    done; exit $rc'
}

cmd_layer2() {
  say "Layer 2: read-only coc_reader role on the real database"
  COC_SKIP_HOST_CHECK=1 APP_DIR="$app" bash "$repo/deploy/ct105/layer2/create-reader-role.sh"
}

cmd_traffic() {
  say "traffic simulator: setup + 3 real transactions through the API"
  docker run --rm --add-host=host.docker.internal:host-gateway \
    -e BANK_URL=http://host.docker.internal:8081 -e COC_TRAFFIC_ENV=/tmp/sim.env \
    -v "$repo/deploy/ct105/traffic:/t:ro" python:3.12-alpine sh -c \
    'python /t/traffic_sim.py setup && python /t/traffic_sim.py run --max-count 3 --min-gap 1 --max-gap 2'
}

# The local witness lives in the backend's network namespace; any backend restart (hotpatch,
# rollback, rebuild) leaves it on a dead namespace until it is restarted too.
restart_witness() {
  docker restart banking-witness >/dev/null
  for _ in $(seq 1 15); do curl -fs http://127.0.0.1:8787/health >/dev/null && { echo "witness reattached"; return; }; sleep 1; done
  echo "witness did not come back"; return 1
}

cmd_hotpatch() {
  say "coc.sh hotpatch (docker cp) for backend and frontend"
  BACKUP_DIR="${TMPDIR:-/tmp}/coc-hotpatch" WITNESS_HEALTH_URL=http://127.0.0.1:8787/health \
    bash "$repo/deploy/ct105/coc.sh" hotpatch backend
  restart_witness
  BACKUP_DIR="${TMPDIR:-/tmp}/coc-hotpatch" bash "$repo/deploy/ct105/coc.sh" hotpatch frontend
  WITNESS_HEALTH_URL=http://127.0.0.1:8787/health bash "$repo/deploy/ct105/coc.sh" status
}

cmd_down() {
  say "removing the local stack"
  compose down -v --remove-orphans || true
  if [ -f "$env_file" ] && grep -qF "$marker" "$env_file"; then rm -f "$env_file"; echo "removed throwaway .env"; fi
}

case "${1:-}" in
  up) cmd_up ;;
  test) cmd_test ;;
  unit) cmd_unit ;;
  layer2) cmd_layer2 ;;
  traffic) cmd_traffic ;;
  hotpatch) cmd_hotpatch ;;
  witness-restart) restart_witness ;;
  all) cmd_up; cmd_unit; cmd_layer2; cmd_test; cmd_traffic; cmd_hotpatch ;;
  down) cmd_down ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
