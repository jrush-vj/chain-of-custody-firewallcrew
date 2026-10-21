#!/usr/bin/env bash
# Setup script for Lenovo LOQ server laptop (192.168.31.77)
# Run with: bash setup-lenovo-server.sh
# This installs Docker, the banking stack, Layer 1/2/3 agents, and auto-deploy

set -Eeuo pipefail

echo ""
echo "=== Lenovo LOQ Server Setup (192.168.31.77) ==="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[*]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err() { echo -e "${RED}[X]${NC} $*"; exit 1; }

# Must match witness.bat's COC_HMAC_SECRET exactly -- fixed on purpose so the two scripts
# never need manual syncing. This is a demo secret, not a production one.
COC_HMAC_SECRET="7caf507e97c2c37e8e5e286fca914ba0ad1412deb1f2b0f36779d7ebe7d70c09"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  err "This script must be run as root (use: sudo bash setup-lenovo-server.sh)"
fi

log "Checking system requirements..."

# Update package manager
log "Updating package lists..."
apt-get update -q || err "Failed to update package lists"

# Install required packages
log "Installing Docker, Git, Python3, OpenSSL..."
apt-get install -y -q git curl python3 openssl docker.io docker-compose-v2 2>&1 | grep -v "^Setting up\|^Processing\|^Unpacking" || true

# Enable Docker
systemctl enable --now docker >/dev/null 2>&1 || true

log "Setting hostname to ct105-ai..."
hostnamectl set-hostname ct105-ai >/dev/null 2>&1 || true
grep -q 'ct105-ai' /etc/hosts || echo '127.0.1.1 ct105-ai' >> /etc/hosts

# Clone the repository
REPO_DIR="/opt/chain-of-custody"
if [ ! -d "$REPO_DIR/.git" ]; then
  log "Cloning repository to $REPO_DIR..."
  git clone --branch local-test https://github.com/jrush-vj/chain-of-custody-firewallcrew.git "$REPO_DIR" || err "Failed to clone repository"
else
  log "Repository already exists at $REPO_DIR"
fi

git config --global --add safe.directory "$REPO_DIR" 2>/dev/null || true

# Setup banking environment. DB_PASSWORD etc are generated once and kept on reruns (Postgres
# already has that password baked into its data volume -- changing it later breaks login).
# WITNESS_HMAC_SECRET is always forced to COC_HMAC_SECRET so it can never drift from witness.bat.
APP_DIR="$REPO_DIR/banking-system"
if [ ! -f "$APP_DIR/.env" ]; then
  log "Creating banking-system/.env with fresh random secrets..."
  umask 077
  cat > "$APP_DIR/.env" <<EOF
DB_NAME=bankingsystem
DB_USER=bank
DB_PASSWORD=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 24)
DATA_ENCRYPTION_KEY=$(openssl rand -hex 24)
NODE_ENV=production
EXTERNAL_PAYMENTS_API_KEY=$(openssl rand -hex 24)
WITNESS_NODE_ID=ct105-ai
WITNESS_RECONCILE_AUTH=required
WITNESS_URL=http://192.168.31.29:8787
WITNESS_HMAC_SECRET=$COC_HMAC_SECRET
WITNESS_ALLOW_LAN_HTTP=1
COOKIE_SECURE=false
CORS_ORIGINS=http://192.168.31.77:3001
FRONTEND_BIND=0.0.0.0
EOF
  chmod 600 "$APP_DIR/.env"
else
  log "banking-system/.env already exists; keeping it, just checking the witness secret..."
  grep -q "^WITNESS_HMAC_SECRET=$COC_HMAC_SECRET$" "$APP_DIR/.env" \
    || sed -i "s/^WITNESS_HMAC_SECRET=.*/WITNESS_HMAC_SECRET=$COC_HMAC_SECRET/" "$APP_DIR/.env"
fi

# Build and start the bank
log "Building and starting banking stack..."
cd "$APP_DIR"
docker compose up -d --build postgres backend frontend || err "Failed to start banking stack"

# Wait for services to be healthy
log "Waiting for services to be healthy..."
for i in {1..60}; do
  if curl -fs http://127.0.0.1:8081/health >/dev/null 2>&1; then
    log "Backend is healthy"
    break
  fi
  sleep 2
done

log "Setting up auto-deploy timer..."
install -m 0644 "$REPO_DIR/deploy/ct105/banking-deploy.service" /etc/systemd/system/banking-deploy.service
install -m 0644 "$REPO_DIR/deploy/ct105/banking-deploy.timer" /etc/systemd/system/banking-deploy.timer

log "Setting up Layer 1/2/3 agents..."
mkdir -p /var/log/bank-demo
[ -f /var/log/bank-demo/app.log ] || echo -e "txn 1 ok\ntxn 2 ok" > /var/log/bank-demo/app.log

bash "$REPO_DIR/deploy/ct105/layer1/install-wrappers.sh" >/dev/null 2>&1 || warn "Layer 1 setup had issues"
bash "$REPO_DIR/deploy/ct105/layer2/create-reader-role.sh" >/dev/null 2>&1 || warn "Layer 2 setup had issues"
bash "$REPO_DIR/deploy/ct105/layer3/setup-demo-account.sh" >/dev/null 2>&1 || warn "Layer 3 setup had issues"

log "Setting up monitor environment..."
mkdir -p /etc/coc-layer1
cat > /etc/coc-layer1/monitor.env <<EOF
WITNESS_URL=http://192.168.31.29:8787
WITNESS_NODE_ID=ct105-ai
WITNESS_HMAC_SECRET=$COC_HMAC_SECRET
WITNESS_STATUS_URL=http://192.168.31.29:8787/status
WITNESS_MISMATCHES_URL=http://192.168.31.29:8787/mismatches
WITNESS_HEALTH_URL=http://192.168.31.29:8787/health
PYTHONUNBUFFERED=1
EOF
chmod 600 /etc/coc-layer1/monitor.env

log "Enabling services..."
systemctl daemon-reload
systemctl enable --now banking-deploy.timer
systemctl enable coc-layer1-monitor.service
systemctl restart coc-layer1-monitor.service

log "Running health checks..."
echo ""
curl -fs http://127.0.0.1:8081/health >/dev/null && echo -e "${GREEN}[OK]${NC} Backend" || echo -e "${RED}[FAIL]${NC} Backend"
curl -fs http://127.0.0.1:3001/ >/dev/null && echo -e "${GREEN}[OK]${NC} Frontend at http://192.168.31.77:3001" || echo -e "${RED}[FAIL]${NC} Frontend"
systemctl is-active --quiet coc-layer1-monitor && echo -e "${GREEN}[OK]${NC} Monitor service" || echo -e "${RED}[FAIL]${NC} Monitor service"
echo ""

log "=== Server Setup Complete ==="
echo ""
echo "Bank site: http://192.168.31.77:3001"
echo "Logs: journalctl -u banking-deploy.service"
echo "Monitor: journalctl -u coc-layer1-monitor"
echo ""
echo "To run attacks from another terminal:"
echo "  sudo bash /opt/chain-of-custody/deploy/ct105/coc.sh status"
echo "  sudo bash /opt/chain-of-custody/deploy/ct105/coc.sh attack 1"
echo "  sudo bash /opt/chain-of-custody/deploy/ct105/coc.sh restore"
echo ""
