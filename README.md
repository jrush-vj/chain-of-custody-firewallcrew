# Banking System

This local-only repository now contains the banking application from
[`jtr-0901/Banking-system-fullstack`](https://github.com/jtr-0901/Banking-system-fullstack).
The former defense and hacker-agent components have been removed.

## Run the application

See [`banking-system/README.md`](./banking-system/README.md) for application
setup. Configure secrets in `banking-system/.env` before starting the app.
Never commit `.env` or real credentials.

## Existing Cloudflare Tunnel

The `bank.jrushvj.dev` tunnel configuration on ct105-ai is intended to remain
unchanged. The Compose frontend is mapped to `127.0.0.1:3001`, the same local
origin the tunnel already targets. Backend and PostgreSQL host ports are
loopback-only and do not need public DNS records.

On the server, start only the banking services:

```bash
cd /opt/chain-of-custody/banking-system
cp .env.example .env
# Edit .env and set unique production secrets before starting.
docker compose up -d postgres backend frontend
```

The demo banking service will be unavailable while its old deployment is
removed, and until this replacement is configured and started on ct105-ai.

## Local version control

This checkout is intentionally detached from a Git remote. Changes can still
be tracked with local commits; do not push this repository to a remote.
