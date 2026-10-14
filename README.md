# Banking System

This repository contains the banking application from
[`jtr-0901/Banking-system-fullstack`](https://github.com/jtr-0901/Banking-system-fullstack).
The former defense and hacker-agent components have been removed.

## Run the application

See [`banking-system/README.md`](./banking-system/README.md) for application
setup. Configure secrets in `banking-system/.env` before starting the app.
Never commit `.env` or real credentials.

## Existing Cloudflare Tunnel

The `bank.jrushvj.dev` Cloudflare Tunnel configuration on ct105-ai should
continue to target `http://127.0.0.1:3001`. Compose maps the frontend to that
loopback address; backend and PostgreSQL host ports are also loopback-only.
Cloudflare DNS and tunnel credentials are not stored in this repository.

## Deploy on ct105-ai

On the server, clone this repository to `/opt/chain-of-custody`, create
`banking-system/.env` from the example, and set unique strong secrets. Then
start only the banking services:

```bash
cd /opt/chain-of-custody/banking-system
cp .env.example .env
nano .env
docker compose up -d postgres backend frontend
```

Install the optional systemd polling timer to fetch `main` and redeploy the
banking Compose services after banking files change:

```bash
sudo install -m 0644 deploy/ct105/banking-deploy.service /etc/systemd/system/
sudo install -m 0644 deploy/ct105/banking-deploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now banking-deploy.timer
sudo systemctl start banking-deploy.service
```

The timer checks every two minutes. It builds/restarts the banking containers
only when the deployed commit contains changes under `banking-system/`.
Follow deployment logs with:

```bash
sudo journalctl -u banking-deploy.service -f
```

## v2 defense methodology

[`v2_docs/README.md`](./v2_docs/README.md) records how the v2 three-layer plan
is being adapted to the current hosting limits. Defense features in those
documents are plans/prototypes, not part of this banking deployment.
