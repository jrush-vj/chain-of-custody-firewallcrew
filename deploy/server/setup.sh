#!/usr/bin/env bash
# One-time setup, run from this laptop's Git Bash. The laptop is the witness; the Ubuntu server runs the bank.
#
#   bash deploy/server/setup.sh <ssh-user>@<server-ip> <laptop-lan-ip>
#   e.g. bash deploy/server/setup.sh jerush@192.168.31.77 192.168.31.50
#
# Safe to re-run (e.g. when the laptop's IP changes). Afterwards:
#   - witness edits on this laptop apply instantly (witness/run-witness.ps1 uses node --watch)
#   - push to this branch (the one checked out now, or DEPLOY_BRANCH) and the server rebuilds the bank / restarts the monitor within 2 minutes
set -Eeuo pipefail
target="${1:?usage: setup.sh <ssh-user>@<server-ip> <laptop-lan-ip>}"
laptop_ip="${2:?usage: setup.sh <ssh-user>@<server-ip> <laptop-lan-ip>}"
server_ip="${target#*@}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
wenv="$repo/witness/.env"

# Witness config on the laptop; the shared secret is created once and reused on re-runs.
if [ -f "$wenv" ]; then
  secret="$(grep '^WITNESS_HMAC_SECRET=' "$wenv" | cut -d= -f2- | tr -d '\r')"
else
  secret="$(openssl rand -hex 32)"
fi
cat > "$wenv" <<EOF
WITNESS_NODE_ID=ct105-ai
WITNESS_HMAC_SECRET=$secret
WITNESS_BIND_HOST=0.0.0.0
WITNESS_PORT=8787
WITNESS_DATA_PATH=$HOME/.coc-witness/ledger.jsonl
BANK_RECONCILE_URL=http://$server_ip:3001/api/transactions/witness-reconcile
WITNESS_ALLOW_LAN_HTTP=1
WITNESS_LAYER1_ENABLED=1
EOF
if command -v cygpath >/dev/null 2>&1; then
  sed -i "s|^WITNESS_DATA_PATH=.*|WITNESS_DATA_PATH=$(cygpath -m "$HOME")/.coc-witness/ledger.jsonl|" "$wenv"
fi
echo "wrote $wenv"

# Copy the server script and its vars (secret included, mode 600), run with sudo, then delete both.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
( umask 077; cat > "$tmp/vars" <<EOF
WITNESS_SECRET=$secret
LAPTOP_IP=$laptop_ip
SERVER_IP=$server_ip
REPO_URL=$(git -C "$repo" remote get-url origin)
BRANCH=${DEPLOY_BRANCH:-$(git -C "$repo" branch --show-current)}
EOF
)
scp -q "$here/server-setup.sh" "$tmp/vars" "$target:/tmp/"
ssh -t "$target" 'sudo bash /tmp/server-setup.sh /tmp/vars; rc=$?; rm -f /tmp/server-setup.sh /tmp/vars; exit $rc'

ps1="$(cygpath -w "$repo/witness/run-witness.ps1" 2>/dev/null || echo "$repo/witness/run-witness.ps1")"
cat <<EOF

Server done. One-time on this laptop, in PowerShell **as Administrator**:

  New-NetFirewallRule -DisplayName 'CoC witness' -Direction Inbound -Protocol TCP -LocalPort 8787 -RemoteAddress $server_ip -Action Allow -Profile Any
  Register-ScheduledTask -TaskName 'CoC witness' -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Action (New-ScheduledTaskAction -Execute powershell.exe -Argument '-WindowStyle Hidden -ExecutionPolicy Bypass -File "$ps1"') -RunLevel Limited
  Start-ScheduledTask -TaskName 'CoC witness'

Then:  bank http://$server_ip:3001   witness dashboard http://localhost:8787
Keep the laptop awake: with the witness down, bank transactions are refused.
EOF
