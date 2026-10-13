# Deployment Guide

This guide describes the current deployment: banking on the homelab, witness
on Oracle, and Cloudflare Tunnel in front of both services.

## Prerequisites

- A Linux homelab container or VM with at least 4 GB RAM recommended for the
  banking Docker stack.
- A separate Oracle VPS for the witness.
- A Cloudflare-managed zone for `jrushvj.dev`.
- Git, Docker Compose, Python 3, Node.js/npm, and `cloudflared`.

The witness should not share the same host as the banking application when the
demo is intended to model a root-level attacker.

## 1. Banking host

Clone the repository on the homelab:

```bash
sudo mkdir -p /opt/chain-of-custody
sudo git clone https://github.com/jrush-vj/chain-of-custody.git \
  /opt/chain-of-custody
```

Create the banking environment file from the example and set production
secrets:

```bash
cd /opt/chain-of-custody/banking-system
cp .env.example .env
nano .env
```

The public origin should be:

```dotenv
CORS_ORIGINS=https://bank.jrushvj.dev
FRONTEND_PUBLIC_API_URL=
SWAGGER_SERVER_URLS=https://bank.jrushvj.dev
```

Start only the banking services:

```bash
docker compose up -d postgres backend frontend
docker compose ps
```

The current homelab port mappings are:

```text
127.0.0.1:3001 → frontend container port 80
127.0.0.1:8081 → backend container port 8080
127.0.0.1:5432 → PostgreSQL container port 5432
```

Verify locally:

```bash
curl -I http://127.0.0.1:3001
curl http://127.0.0.1:8081/health
```

Do not start the optional Nginx Proxy Manager service when using Cloudflare
Tunnel:

```bash
docker compose up -d postgres backend frontend
```

## 2. Banking Cloudflare Tunnel

The banking tunnel runs on the homelab:

```yaml
ingress:
  - hostname: bank.jrushvj.dev
    service: http://127.0.0.1:3001
  - service: http_status:404
```

Install it as a service:

```bash
sudo cloudflared --config /root/.cloudflared/config.yml service install
sudo systemctl enable --now cloudflared
```

Verify:

```bash
curl -I https://bank.jrushvj.dev
sudo systemctl status cloudflared --no-pager
```

## 3. Oracle witness

On Oracle, install the repository and create a Python environment:

```bash
sudo git clone https://github.com/jrush-vj/chain-of-custody.git \
  /opt/chain-of-custody
cd /opt/chain-of-custody/defense
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Create persistent witness storage outside the Git checkout:

```bash
sudo mkdir -p /var/lib/coc-witness /etc/coc-witness
sudo chown -R coc-witness:coc-witness /var/lib/coc-witness
```

Configure `/etc/coc-witness/witness_nodes.toml` with the banking node's public
key:

```toml
[nodes]
node-1 = "BANKING_NODE_PUBLIC_KEY"
```

Configure the witness database path:

```toml
[witness]
db_path = "/var/lib/coc-witness/witness.db"
port = 8800
nodes_file = "/etc/coc-witness/witness_nodes.toml"
```

Run the witness with systemd and bind it locally:

```text
127.0.0.1:8800
```

The complete unit template is in
[defense/deploy/systemd](../defense/deploy/systemd/README.md).

## 4. Witness Cloudflare Tunnel

The Oracle tunnel routes:

```yaml
ingress:
  - hostname: witness.jrushvj.dev
    service: http://127.0.0.1:8800
  - service: http_status:404
```

Install it as a service:

```bash
sudo cloudflared --config /root/.cloudflared/config.yml service install
sudo systemctl enable --now cloudflared
```

Verify:

```bash
curl -I https://witness.jrushvj.dev
sudo systemctl status coc-witness --no-pager
sudo systemctl status cloudflared --no-pager
```

## 5. Sidecar and spooler

On the banking host:

1. Create the read-only `coc_reader` PostgreSQL role.
2. Create `/etc/chain-of-custody/banking.env`.
3. Set the sidecar `witness_url` to
   `https://witness.jrushvj.dev`.
4. Generate the node key pair.
5. Put only the public key in Oracle's `witness_nodes.toml`.
6. Enable `coc-spooler` and `coc-sidecar`.

Verify:

```bash
sudo systemctl is-active coc-spooler
sudo systemctl is-active coc-sidecar
curl "https://witness.jrushvj.dev/heartbeats?node_id=node-1&limit=5"
```

## Updates

Pull code separately on each host, then restart only the relevant service:

```bash
cd /opt/chain-of-custody
sudo git -c safe.directory=/opt/chain-of-custody pull origin main
```

Keep `/var/lib/coc-witness/witness.db`, local node keys, `.env`, and service
environment files outside source control.
