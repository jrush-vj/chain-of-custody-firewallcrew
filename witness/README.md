# Oracle witness service

This small Node.js service stores prepare/commit/abort evidence as an
append-only, SHA-256 hash-chained JSONL ledger. It uses only Node.js built-ins
and is designed to run behind the existing Cloudflare Tunnel on the 1 GB Oracle
VPS. It does not run the banking app or PostgreSQL.

The banking backend sends a minimal event for every deposit, withdrawal,
transfer, and external payment. It omits names, IBANs, references, and account
numbers. A matching HMAC authenticates writes. The HMAC secret is shared with
ct105; therefore root access to ct105 can disclose it and forge new events.
The external witness helps preserve a separate copy of received evidence, but
does not prove that the event producer reported every real-world transaction.

## Oracle deployment

Use the existing Ubuntu Oracle VPS. The existing Python `coc-witness.service`
and its SQLite database under `/var/lib/coc-witness` must remain untouched.
The Node witness runs as a separate system user, on port 8787, with separate
data under `/var/lib/banking-witness`. Keep the existing `cloudflared`
credentials and service intact. Add a hostname-specific ingress rule routing
`witness.jrushvj.dev` to `http://127.0.0.1:8787`; keep the existing
`http://127.0.0.1:8800` fallback rule so other tunnel hosts retain their
current origin. The existing Python service and SQLite data remain on port 8800
but its current public pages/API will no longer be served at this hostname.
Do not expose port 8787 publicly.

Clone or update the repository into a new path without overwriting any existing
checkout. On Oracle, run:

```bash
sudo bash -e -c 'test ! -e /opt/coc-witness-source && git clone https://github.com/jrush-vj/chain-of-custody-firewallcrew.git /opt/coc-witness-source'
```

If that source path already exists, inspect it and do not clone over it. Then
run:

```bash
node --version
```

If Node.js 18 or newer is missing on Ubuntu 24.04:

```bash
sudo apt update
sudo apt install -y nodejs
node --version
```

Then install the service files:

```bash
getent passwd banking-witness >/dev/null || sudo useradd --system --home /opt/banking-witness --shell /usr/sbin/nologin banking-witness
sudo install -d -o root -g root -m 0755 /opt/banking-witness
sudo install -d -o banking-witness -g banking-witness -m 0700 /var/lib/banking-witness
sudo install -m 0644 /opt/coc-witness-source/witness/server.js /opt/banking-witness/server.js
sudo install -m 0644 /opt/coc-witness-source/witness/auditor.html /opt/banking-witness/auditor.html
sudo install -m 0644 /opt/coc-witness-source/witness/store.js /opt/banking-witness/store.js
sudo install -m 0644 /opt/coc-witness-source/witness/reconcile.js /opt/banking-witness/reconcile.js
sudo install -m 0644 /opt/coc-witness-source/witness/package.json /opt/banking-witness/package.json
sudo install -m 0644 /opt/coc-witness-source/witness/banking-witness.service /etc/systemd/system/banking-witness.service
sudo install -d -o root -g root -m 0750 /etc/banking-witness
sudo sh -c 'umask 077; cat > /etc/banking-witness/witness.env' <<'EOF'
WITNESS_NODE_ID=ct105-ai
WITNESS_HMAC_SECRET=REPLACE_WITH_THE_SAME_RANDOM_SECRET_ON_BOTH_HOSTS
WITNESS_BIND_HOST=127.0.0.1
WITNESS_PORT=8787
WITNESS_DATA_PATH=/var/lib/banking-witness/ledger.jsonl
EOF
sudo chown root:banking-witness /etc/banking-witness/witness.env
sudo chmod 0640 /etc/banking-witness/witness.env
sudo systemctl daemon-reload
sudo systemctl enable --now banking-witness.service
sudo systemctl status banking-witness.service --no-pager
curl --fail http://127.0.0.1:8787/health
```

Generate the shared secret on one trusted machine with `openssl rand -hex 32`.
Enter it directly into both protected environment files; never paste it into
chat, a terminal transcript, Git, or the public dashboard. The `node` runtime
must be Node.js 18 or newer. Keep Oracle's host firewall closed for port 8787;
Cloudflare Tunnel connects to the loopback listener. Before changing ingress,
back up `/etc/cloudflared/config.yml`. Add this rule before the existing
catch-all `service: http://127.0.0.1:8800` rule, preserving the tunnel ID,
credentials-file, and all other settings:

```yaml
  - hostname: witness.jrushvj.dev
    service: http://127.0.0.1:8787
```

Validate ingress with `sudo cloudflared tunnel ingress validate`, then restart
`cloudflared.service`. Confirm the
legacy Python service remains active on `127.0.0.1:8800` and verify both local
health (`http://127.0.0.1:8787/health`) and public health
(`https://witness.jrushvj.dev/health`).

## ct105 banking backend

The ct105 `.env` needs these values:

```dotenv
WITNESS_URL=https://witness.jrushvj.dev
WITNESS_NODE_ID=ct105-ai
WITNESS_HMAC_SECRET=THE_SAME_RANDOM_SECRET_AS_ORACLE
```

After adding the values, use mode `0600` for `.env`, then deploy/rebuild the
backend. Verify `curl --fail https://witness.jrushvj.dev/health` from ct105
before enabling witness-required transaction processing.

The Oracle service appends a `prepare` record before the bank database commits.
Once PostgreSQL commits, the backend appends a `commit` record. If the final
acknowledgement is delayed, the API returns HTTP 202 with a pending witness
status, and a PostgreSQL outbox retries the commit. If Oracle cannot prepare
the event, the banking operation is rolled back and returns an error.

The dashboard at `https://witness.jrushvj.dev/` displays received event type,
amount, transaction ID, and witness state. It contains no account numbers or
customer identifiers. Protect the dashboard with Cloudflare Access if it
should not be public.

The witness also polls
`https://bank.jrushvj.dev/api/transactions/witness-reconcile` every 30 seconds
for the current type, amount, and witness event ID of transactions already
committed to its independent ledger. The endpoint only returns rows for the
requested transaction IDs and does not return account or customer data. A
changed or missing row produces a red dashboard alert. If ct105 is unreachable,
the dashboard says reconciliation is unavailable; an outage is not claimed to
be proof of tampering. Root on ct105 can still alter the API to lie or suppress
the check, so this is a demonstration against database-record edits while the
bank API continues to run normally—not guaranteed detection of a fully
compromised host.

The dashboard is the upstream Cybersec auditor UI from the pinned submodule,
served by the existing Node process. Its live `/status`, `/alerts`,
`/timeline`, `/mismatches`, and `/activity?since_id=` routes are projections
of the Node JSONL witness ledger and its existing bank reconciliation result.
The banking `/health`, `/v1/status`, `/v1/events`, and authenticated
`/v1/prepare`, `/v1/commit`, and `/v1/abort` interfaces remain available and
unchanged. No new process, systemd unit, hostname, or port is introduced.

Only the bank-row comparison is live Layer 2 evidence: committed witness
transaction IDs, types, amounts, and event IDs are checked against the
existing `/api/transactions/witness-reconcile` endpoint. This does not run
Cybersec's separate Python agent, heartbeat/challenge checks, balance replay,
or its expected SQLite schema; the existing banking database is PostgreSQL
with a different schema. Layer 3 quarantine is not integrated.
`POST /quarantine/approve` returns HTTP 409 with `dry_run: true` and never
performs system actions. The UI's preview buttons are simulations only and are
visibly marked as not live. No fake heartbeats, Layer 1 alerts, or quarantine
state is generated by the live API. When the bank API is unavailable, the UI
says status is unknown rather than claiming tampering.

Layers 1 and 2 events from the host agents reach the witness through
`POST /v1/layer-events`, signed exactly like `/v1/prepare` (HMAC over
`POST`, path, timestamp, body). Each accepted event is appended to the same
hash-chained ledger as a `layer_event` record, so it survives restarts and is
covered by the startup integrity check. `layer` must be 1 or 2; Layer 2 events
must carry a known `kind` from the auditor's Layer 2 list; Layer 1 events must
not. Only `state: "alert"` events raise alerts. The Layer 1 card reads IDLE
until `WITNESS_LAYER1_ENABLED=1` is set in the witness environment, which
should happen only after the tripwire is installed on the monitored host.

To update the Oracle witness from the repository's `main` branch, first check
that the source checkout is clean. Do not discard local changes. Then run on
Oracle:

```bash
set -e
cd /opt/coc-witness-source
git branch --show-current
git status --short
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain)"
git pull --ff-only origin main
sudo systemctl stop banking-witness.service
sudo install -m 0644 /opt/coc-witness-source/witness/server.js /opt/banking-witness/server.js
sudo install -m 0644 /opt/coc-witness-source/witness/auditor.html /opt/banking-witness/auditor.html
sudo install -m 0644 /opt/coc-witness-source/witness/store.js /opt/banking-witness/store.js
sudo install -m 0644 /opt/coc-witness-source/witness/reconcile.js /opt/banking-witness/reconcile.js
sudo install -m 0644 /opt/coc-witness-source/witness/package.json /opt/banking-witness/package.json
sudo systemctl start banking-witness.service
sudo systemctl status banking-witness.service --no-pager
curl --fail http://127.0.0.1:8787/health
curl --fail https://witness.jrushvj.dev/ | grep -F 'Chain of Custody · Witness'
```

Confirm the branch is `main` and the checkout is clean before pulling. If
`git status --short` prints changes, stop and review them; `git pull --ff-only`
must not be replaced with a reset or forced update. No Cloudflare Tunnel
change is needed when it already routes `witness.jrushvj.dev` to
`127.0.0.1:8787`.

On ct105, update the root checkout and its pinned cybersec submodule using the
existing deployment service; this dashboard-only release does not require a
banking container rebuild. Follow [`../deploy/ct105/README.md`](../deploy/ct105/README.md)
for the safe update commands. Do not recreate or delete the PostgreSQL volume.

## Integrity and limits

- On startup the service verifies sequence continuity and every ledger hash.
  A mismatch starts the service in read-only alert mode: it raises a
  `chain_break` alert on the dashboard, reports unhealthy status, and refuses
  all writes.
  It does not show corrupted events as valid.
- The JSONL hash chain detects accidental or partial modification; an attacker
  with Oracle root access can still rewrite the file and recompute the chain.
  Keep independent offline backups or an external anchor for stronger evidence.
- The two hosts cannot participate in one atomic database transaction. A crash
  between the PostgreSQL commit and the witness commit can leave a pending
  record/outbox item; the API exposes that state and retries finalization.
- HMAC protects the endpoint against unauthenticated network writes, not
  against root on ct105, which can read the shared key and change the producer.
- The dashboard is a view of events received by Oracle. It does not reconcile
  events that were never reported by the producer; a compromised producer can
  suppress events before transmission.
- This is a hackathon/demo witness, not a production financial control or
  compliance system.

## Demonstrating witness-ledger tampering

The demo script changes a selected $1 withdrawal in the Oracle witness ledger
to $100 without updating its record hash. Run these commands on the Oracle VPS,
not ct105. The website will show the red integrity failure alert, the health
endpoint will return HTTP 503, and witness writes will be disabled until the
backup is restored. This demonstrates detection of edits to Oracle's evidence
file; it does not simulate detection of changes made only to ct105's database.

Replace `TRANSACTION_ID` with the ID of a witnessed $1 withdrawal:

```bash
sudo bash /opt/coc-witness-source/witness/demo-ledger-tamper.sh tamper TRANSACTION_ID
```

After observing the alert on `https://witness.jrushvj.dev/`, restore the exact
original ledger:

```bash
sudo bash /opt/coc-witness-source/witness/demo-ledger-tamper.sh restore
```

Wait for `{"status":"ok"}` and refresh the dashboard before resuming demo
transactions. The script refuses to overwrite an existing demo backup or
change anything unless exactly one matching $1 withdrawal is found.

## Demonstrating a ct105 database edit

The witness dashboard independently polls the bank API and compares the
current database row to the committed Oracle evidence. For a demo $1
withdrawal, on ct105 change only the transaction amount (not the account
balance), replacing `TRANSACTION_ID` with that withdrawal's ID:

```bash
sudo docker compose -p banking-system exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "UPDATE transactions SET amount = 100.00 WHERE id = TRANSACTION_ID;"'
```

Within about 30 seconds the dashboard should show `BANK TRANSACTION TAMPERING
DETECTED` and compare the bank's $100 record with the witnessed $1 event.
Restore the demo record on ct105:

```bash
sudo docker compose -p banking-system exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "UPDATE transactions SET amount = 1.00 WHERE id = TRANSACTION_ID;"'
```

After the next polling cycle, the alert should clear. Run only against demo
transactions; changing a transaction record does not adjust the account
balance and must not be represented as an actual reversal. Root can also
modify the API or block Oracle's poll, so an unavailable-source warning is
shown separately.
