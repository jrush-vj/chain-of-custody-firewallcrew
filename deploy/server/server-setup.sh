#!/usr/bin/env bash
# Runs ON the Ubuntu bank server as root (deploy/server/setup.sh copies it there and runs it).
# Safe to re-run: re-running with a new laptop IP updates the witness link everywhere.
#   server-setup.sh <vars-file>     vars: WITNESS_SECRET, LAPTOP_IP, SERVER_IP, REPO_URL, BRANCH
set -Eeuo pipefail
. "$1"
repo=/opt/chain-of-custody
app=$repo/banking-system
ct105=$repo/deploy/ct105
witness="http://$LAPTOP_IP:8787"
say() { printf '\n\033[1m### %s\033[0m\n' "$*"; }
rand() { openssl rand -hex 32; }

say "packages"
if ! command -v git >/dev/null || ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1 \
   || ! command -v python3 >/dev/null || ! command -v openssl >/dev/null; then
  apt-get update -q
  apt-get install -y -q git curl python3 openssl docker.io docker-compose-v2
fi
systemctl enable --now docker

say "hostname (every demo script checks for ct105-ai)"
[ "$(hostname)" = ct105-ai ] || hostnamectl set-hostname ct105-ai
grep -q 'ct105-ai' /etc/hosts || echo '127.0.1.1 ct105-ai' >> /etc/hosts

say "repository at $repo"
[ -d "$repo/.git" ] || git clone --branch "$BRANCH" "$REPO_URL" "$repo"
if [ "$(git -C "$repo" branch --show-current)" != "$BRANCH" ]; then
  git -C "$repo" fetch -q origin "$BRANCH" && git -C "$repo" checkout -q -B "$BRANCH" "origin/$BRANCH"
fi
git -C "$repo" pull -q --ff-only origin "$BRANCH"   # so this run already uses the latest deploy scripts
# The auto-deploy timer follows this branch.
echo "DEPLOY_BRANCH=$BRANCH" > /etc/default/banking-deploy
export DEPLOY_BRANCH="$BRANCH"
git config --global --add safe.directory "$repo" 2>/dev/null || true

say "banking-system/.env"
umask 077
if [ ! -f "$app/.env" ]; then
  cat > "$app/.env" <<EOF
DB_NAME=bankingsystem
DB_USER=bank
DB_PASSWORD=$(rand)
JWT_SECRET=$(rand)
DATA_ENCRYPTION_KEY=$(rand)
NODE_ENV=production
EXTERNAL_PAYMENTS_API_KEY=$(rand)
WITNESS_NODE_ID=ct105-ai
WITNESS_RECONCILE_AUTH=required
EOF
  echo "created $app/.env"
fi
set_kv() {   # set_kv <file> <key> <value>: replace or append
  if grep -q "^$2=" "$1"; then sed -i "s|^$2=.*|$2=$3|" "$1"; else echo "$2=$3" >> "$1"; fi
}
set_kv "$app/.env" WITNESS_URL "$witness"
set_kv "$app/.env" WITNESS_HMAC_SECRET "$WITNESS_SECRET"
set_kv "$app/.env" WITNESS_ALLOW_LAN_HTTP 1
set_kv "$app/.env" COOKIE_SECURE false
set_kv "$app/.env" CORS_ORIGINS "http://$SERVER_IP:3001"
set_kv "$app/.env" FRONTEND_BIND 0.0.0.0
chmod 600 "$app/.env"

say "build and start the bank (first run takes a few minutes)"
bash "$ct105/deploy-banking.sh"
# Picks up .env edits on re-runs (no-op when nothing changed).
docker compose --project-directory "$app" -f "$app/docker-compose.yml" up -d postgres backend frontend

say "auto-deploy timer (pulls main every 2 minutes)"
install -m 0644 "$ct105/banking-deploy.service" /etc/systemd/system/banking-deploy.service
install -m 0644 "$ct105/banking-deploy.timer" /etc/systemd/system/banking-deploy.timer

say "Layer 1/2/3 agents"
install -d /var/log/bank-demo
[ -f /var/log/bank-demo/app.log ] || printf 'txn 1 ok\ntxn 2 ok\n' > /var/log/bank-demo/app.log
bash "$ct105/layer1/install-wrappers.sh"
bash "$ct105/layer2/create-reader-role.sh"
bash "$ct105/layer3/setup-demo-account.sh"
install -d -m 0700 /etc/coc-layer1
cat > /etc/coc-layer1/monitor.env <<EOF
WITNESS_URL=$witness
WITNESS_NODE_ID=ct105-ai
WITNESS_HMAC_SECRET=$WITNESS_SECRET
WITNESS_STATUS_URL=$witness/status
WITNESS_MISMATCHES_URL=$witness/mismatches
WITNESS_HEALTH_URL=$witness/health
PYTHONUNBUFFERED=1
EOF
chmod 600 /etc/coc-layer1/monitor.env
# Approve the current witness link settings so Layer 3 doesn't flag our own setup as tampering.
(set -a; . /etc/coc-layer1/monitor.env; set +a; python3 "$ct105/layer3/l3_config_guard.py" approve)
install -m 0644 "$ct105/layer1/coc-layer1-monitor.service" /etc/systemd/system/coc-layer1-monitor.service

systemctl daemon-reload
systemctl enable --now banking-deploy.timer
systemctl enable coc-layer1-monitor.service
systemctl restart coc-layer1-monitor.service

if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  say "firewall: allow the bank site (3001) from the LAN"
  ufw allow from "${SERVER_IP%.*}.0/24" to any port 3001 proto tcp
fi

say "checks"
curl -fs http://127.0.0.1:8081/health >/dev/null && echo "OK   backend" || echo "FAIL backend"
curl -fs http://127.0.0.1:3001/ >/dev/null && echo "OK   site http://$SERVER_IP:3001" || echo "FAIL site"
curl -fs --max-time 5 "$witness/health" >/dev/null && echo "OK   witness $witness" \
  || echo "FAIL witness $witness (is run-witness.ps1 running and port 8787 allowed in Windows Firewall?)"
systemctl is-active --quiet coc-layer1-monitor && echo "OK   monitor" || echo "FAIL monitor (journalctl -u coc-layer1-monitor)"
