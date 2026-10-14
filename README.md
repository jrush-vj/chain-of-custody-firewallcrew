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

The Cybersec submodule remains pinned to upstream revision `73cfe0c` and is
not modified. The Node witness serves its auditor UI and compatible live API
routes on the existing `127.0.0.1:8787` service. The dashboard's Layer 2
live result is the existing comparison between committed witness events and
the PostgreSQL-backed bank reconciliation endpoint.

The upstream repository has no license file. Obtain permission/license
confirmation before redistributing the integrated upstream UI outside this
project.

The Cybersec agent expects a different SQLite schema and is not connected to
the banking PostgreSQL database. Its Layer 1 command tripwire, separate
heartbeat/checksum agent, balance replay, and Layer 3 quarantine are not
active here. Their preview buttons are simulated examples only. The live
dashboard marks these features as unavailable; bank-source outages are
reported as unknown/unavailable, not as tampering. Layer 3 approval is
disabled and dry-run guarded. No new service, daemon, hostname, or port is
required; preserve the existing Node `/health` and `/v1/prepare|commit|abort`
interfaces, ledger, Cloudflare routing, and banking services.

See [`witness/README.md`](./witness/README.md) for the live routes, deployment
update steps, and integration limits.
