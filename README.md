<<<<<<< HEAD
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
=======
# Chain of Custody

Hackurity 2026 submission by Firewall Crew (REVA University). Licence: MIT ([LICENSE](LICENSE)).

## Problem (PS-6, Track C: Blockchain)

Tamper-evident logging that stops, detects and contains attacks on the evidence itself.
An attacker with admin root can edit, truncate, or silence the logs of a banking system, and
the SIEM then cannot tell. This project makes such edits detectable at the exact record they
touch, and keeps an independent copy outside the attacked machine.

Scope is one banking system (`banking-system/`) on one host (ct105-ai), with a separate witness
service on an Oracle VPS. The write-up states which core deliverables are working, partial, or not
done: [docs/writeup.pdf](docs/writeup.pdf).

## What it does

- **Layer 1, command capture (partial, detect only).** Honeypot wrappers replace `rm`, `sed`,
  `vi`, `truncate` and similar commands on the log host. Any call that touches the watched log
  path is written to a spool and forwarded to the witness. The command still runs; it is not
  blocked.
- **Layer 2a, heartbeat (working).** ct105 sends a signed heartbeat to the witness every 30 s
  (adaptive, 15–120 s). Missed heartbeats raise a silence alert on the witness, never on ct105.
- **Layer 2b, hash-chained witness ledger (working).** The witness stores each event as an
  append-only JSONL record with a SHA-256 `prev_hash` link. A modified record is rejected on
  startup.
- **Layer 2c, bank-to-witness reconciliation (working, tested).** The witness keeps copies of
  the bank's transaction rows and checks the bank against them, including bounded random
  rechecks. Layer 2 demo attacks: change an amount, flip a type, change a status.
- **Layer 3, containment (partial).** Demo mode locks one demo account and uses a 2-of-3 demo key
  unlock. A full root-capable lockout is built but gated and **not enabled** on ct105. Witness
  quarantine runs as a dry run for a broken bank-to-witness link.
- **Witness dashboard (working).** `witness/auditor.html` shows the layer events, heartbeats,
  reconciliation status, and a "Restore to normal" control.

What it does not do yet is listed in [docs/writeup.pdf](docs/writeup.pdf), section 3.

## Architecture

```
  Bank app (ct105, Docker)  --rows, heartbeats, HMAC-signed-->  Witness (Oracle VPS, Node, port 8787)
        |                                                          |  hash-chained ledger (JSONL)
  Layer 1 wrappers -> monitor --events-->                          |  reconciliation + dashboard
  Layer 2 heartbeat/reader ------------------------------------>   |
  Layer 3 lockout (demo account)                                   |  alerts shown here only
```

Full diagram: [docs/writeup.pdf](docs/writeup.pdf), section 2.

The witness is the only place alerts are shown. The attacked host does not hold the alert state.

## How to run it

**Witness (Node 18 or later, no npm packages):**

```bash
cd witness
npm test                       # 33 tests, all passing on Node 24.15.0
WITNESS_HMAC_SECRET=<32+ random chars> npm start
```

Environment variables are listed in [witness/README.md](witness/README.md).
Open `http://127.0.0.1:8787/` for the dashboard.

**Banking application (Docker Compose):**

```bash
cd banking-system
cp .env.example .env           # then set unique secrets; never commit .env
docker compose up -d postgres backend frontend
```

Full setup, and the ct105 deployment, is in [banking-system/README.md](banking-system/README.md)
and [deploy/ct105/README.md](deploy/ct105/README.md). The original repository README is kept at
[docs/archive/README-original.md](docs/archive/README-original.md).

**Not yet verified from a clean machine.** The Layer 1 and Layer 2 scripts assume the ct105 host
(root, PostgreSQL, the log path). They are not runnable on a laptop.

## How to run the demo

The demo runs against the ct105 banking stack and the Oracle witness.

1. Start the banking stack and the witness (above).
2. Normal run: `witness` dashboard shows all layers green.
3. Layer 1: run `rm` or `sed -i` on the watched log path through the wrapper. The attempt
   appears on the witness.
4. Layer 2: `sudo deploy/ct105/layer2/attack-layer2.sh` makes three reversible changes to
   committed transactions. The witness flags each one. Restore with `restore-layer2.sh`.
5. Layer 3 (demo mode): `deploy/ct105/layer3/` lockout of `coc-demo-intruder`, then 2-of-3 unlock.

Demo video: link to be added at submission (see [docs/writeup.pdf](docs/writeup.pdf)).

## Tech stack

- Witness: Node.js (built-ins only), JSONL ledger, SHA-256, HMAC-SHA-256
- Banking app: Node.js / Express backend, React frontend, PostgreSQL, Docker Compose
- ct105 scripts: Python 3 (standard library), bash, systemd timers
- Dashboard: static HTML and JavaScript (`witness/auditor.html`)
- Pitch deck: `docs/pitch-deck.pdf`

## Team members

- Jeevika
- Jerush (jrush-vj)
- Jaganath

## AI tools used

Named as required by the rules. Use per part of the work:

- **Claude Code** (Anthropic): code and test writing, refactoring, and this documentation.
  Commit trailers show Claude Haiku 5.5, Claude Sonnet 5, and Claude Sonnet 5.5.
- **GitHub Copilot**: code completion in the same repository (commit trailers show Copilot).

Every part of the solution is explained by the team in the live demo. The architecture and
design decisions were made by the team.

## Credits and licence

Third-party repositories, libraries and data, with links and licences: [docs/CREDITS.md](docs/CREDITS.md).
Team code is under the MIT licence: [LICENSE](LICENSE).

The `cybersec/` submodule is an upstream project with **no licence file**. Its redistribution
needs the author's permission. It is not modified here.

## Submission documents

- Technical write-up (PDF, 2 pages): [docs/writeup.pdf](docs/writeup.pdf)
- Pitch deck: [docs/pitch-deck.pdf](docs/pitch-deck.pdf)
- Original repository README: [docs/archive/README-original.md](docs/archive/README-original.md)
>>>>>>> firewallcrew-publish
