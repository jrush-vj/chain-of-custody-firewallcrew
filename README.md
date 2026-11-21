# Banking System
LIVE DEMO LINKS: https://drive.google.com/file/d/1MV2-rjPuCopbqM5QGP-h4Y-8WtaXvhjr/view?usp=drive_link

This repository contains the banking application from
[`jtr-0901/Banking-system-fullstack`](https://github.com/jtr-0901/Banking-system-fullstack).
The former defense and hacker-agent components have been removed.

## Run the application

See [`banking-system/README.md`](./banking-system/README.md) for application
setup. Configure secrets in `banking-system/.env` before starting the app.
Never commit `.env` or real credentials.

To run the full demo (bank, witness, attack lab and IBM Bob) on one laptop, follow
[`deploy/local/QUICKSTART.md`](./deploy/local/QUICKSTART.md).

## Run the pieces locally

Banking app (`banking-system/`, uses PostgreSQL from its `.env`):

```bash
cd banking-system
npm install
npm start
```

Witness (`witness/`, Node, no database):

```bash
cd witness
npm install
npm test     # 133 tests, no key and no Docker needed
npm start    # auditor view at http://localhost:8787/
```

`WITNESS_PORT` changes the witness port (default 8787). The banking backend
reads `PORT` from `banking-system/.env` (default 5000). Layers 1, 2 and 3 run
against the bank in the lab container started by `deploy/local/test-stack.sh`
(see the quickstart); the Python tests for each layer run with
`bash deploy/local/test-stack.sh unit`. Demo recordings are listed in
[`Videos/LINK.md`](./Videos/LINK.md); the video files are not stored in git.

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
repository is not included in this repo. It was a Git submodule pinned to
`73cfe0c`; that submodule has been removed. The Node witness serves the integration-owned `witness/auditor.html`
page (including its existing "Restore to normal" control) and compatible live API
routes on the existing `127.0.0.1:8787` service. The dashboard's Layer 2
live result is the existing comparison between committed witness events and
the PostgreSQL-backed bank reconciliation endpoint.

The upstream repository has no license file. Obtain permission/license
confirmation before redistributing the integrated upstream UI outside this
project.

The upstream Cybersec agent itself is not used here: it expects a different
SQLite schema and is not connected to the banking PostgreSQL database. Its
detections are re-implemented for this bank in this repository and are active
(in the lab container started by `deploy/local/test-stack.sh`, and on ct105):

- **Layer 1**, the command tripwire and file watcher: `deploy/ct105/layer1/monitor.py`.
- **Layer 2**, the read-only bank reader and the witness's reconciliation of
  committed records: `deploy/ct105/layer2/` and `witness/`.
- **Layer 3**, quarantine on a changed witness link: `deploy/ct105/layer3/`. It is
  a dry run by default (it records the response and executes none of it). The
  full lockout is built but not enabled; see `deploy/ct105/layer3/RECOVERY.md`.
- **Guard** (off unless `GUARD_ENABLED=1`): alarm classification, soft
  containment with human approval, and incident reports. See `witness/guard/README.md`.

Bank-source outages are reported as unknown/unavailable, not as tampering. No new
service, daemon, hostname, or port is required; preserve the existing Node
`/health` and `/v1/prepare|commit|abort` interfaces, ledger, Cloudflare routing,
and banking services.

See [`witness/README.md`](./witness/README.md) for the live routes, deployment
update steps, and integration limits.

## How the chain of custody works

Three pieces, each with one job:

- **Platform** — the thing being protected (the banking app). It is not modified for this to work;
  a read-only database role and one small adapter config are the only things added to it.
- **Agent** — a small program on the same machine as the platform (`deploy/ct105/layer1/monitor.py`
  on ct105). It reads new transactions, puts a tamper-evident seal on each one, and sends the seal
  away. Think of it as a notary stamping every entry and keeping a copy of the stamp.
- **Witness** — a separate machine the platform's own admin cannot reach into (the Oracle VPS). It
  receives the stamps and checks them. Think of it as an auditor who keeps the stamps in a locked
  box no one else holds the key to.

**How the agent reads the platform's data.** A database role (`coc_reader`) can only `SELECT` a
fixed, narrow list of columns — never write anything, never read customer names, IBANs, account
numbers, or free-text fields. It's a window into the ledger, not a key to the vault. Which table
and columns to read is the only platform-side configuration; the platform's own code is untouched.

**How the seal works.** Each transaction is turned into a fingerprint and signed with the agent's
private key, which never leaves the platform machine — the witness only ever gets the matching
public key, which can check a signature but not create one. Each seal also carries the fingerprint
of the previous seal, so the records form a chain: changing one entry breaks every seal after it.

**What the witness does.** It stores the seals (never passwords, never customer details), checks
every signature and the chain, and compares selected settled transaction IDs against the bank's
read-only reconciliation endpoint. It checks fresh records, heartbeat-flagged suspects, and one
random settled record every 30 seconds, within a 60-call/15-minute budget below the bank's
100-call/IP limit. On the Layer 2 graph an up spike is the witness asking, a down spike is the bank
answering, `?` means no answer, and heartbeats remain dots.

**What "the platform locks itself down" means, and the two ways this is built here.** If the
witness hasn't heard from the platform for 45 seconds, the platform assumes its own network was cut
to hide something. Two different responses exist for this, on purpose kept separate:

- **The live one, used for demos:** locks out one dedicated, non-privileged demo account only.
  Never root, never any other login. See [`deploy/ct105/layer3/README.md`](./deploy/ct105/layer3/README.md).
- **The full design** — locking out every user including root, site down, every banking session
  revoked — is built (`deploy/ct105/layer3/l3_full_lockout.py`) but **not enabled** on the real
  host. Locking out root removes SSH access too, so a verified way back in that does not depend on
  the guest's own network or login system has to exist first. See
  [`deploy/ct105/layer3/RECOVERY.md`](./deploy/ct105/layer3/RECOVERY.md) and
  [`deploy/ct105/layer3/TEST-ON-CLONE.md`](./deploy/ct105/layer3/TEST-ON-CLONE.md) for exactly what
  has to be proven, on a clone, before that changes.

**Setting this up on a new platform, in order:**
1. Create the read-only database user.
2. Fill in the adapter config with that platform's table and column names.
3. Install the agent.
4. Register it with a witness.
5. Test it: make a transaction, watch it show up as verified on the witness.
