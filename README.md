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
documents are plans/prototypes, not part of this banking deployment. The
separate [`witness/`](./witness/) service is a lightweight Oracle-hosted demo
receiver; deploy it before deploying the witness-required banking transaction
integration.

## Cybersec detection project

The upstream [`JeevikaS-19/cybersec`](https://github.com/JeevikaS-19/cybersec)
repository is linked as the [`cybersec/`](./cybersec/) Git submodule. Initialize
it after cloning with:

```bash
git submodule update --init --recursive
```

It is kept as an unmodified upstream component rather than copied into this
repository. No license file is present upstream, so obtain the owner's
permission/license before modifying or redistributing its source. Its README
describes a prototype built around a SQLite demo bank: Checks A-C are
implemented, while Layer 1 is listed as next and Layer 3 as planned. Its agent
does not directly support this app's PostgreSQL schema.

The currently deployable PostgreSQL-row comparison is the independent
reconciliation in `witness/reconcile.js` plus the bank API endpoint
`/api/transactions/witness-reconcile`. For the dashboard alert to appear, both
must be deployed: install `reconcile.js` and the updated Node witness on
Oracle, and rebuild the backend from this repository's `main` on ct105. Keep
ct105's local Compose port mappings and PostgreSQL volume. Confirm the
dashboard shows a bank-reconciliation status before running a demo tamper
test. A dashboard that only shows ledger integrity and recent events is
running an older witness build and cannot show database mismatch alerts.
