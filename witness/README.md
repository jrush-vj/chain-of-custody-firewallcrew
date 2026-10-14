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

Use the existing Ubuntu Oracle VPS. Inspect the current Cloudflare Tunnel and
systemd services before changing anything; keep the tunnel credentials and
existing tunnel service intact. Route `witness.jrushvj.dev` to
`http://127.0.0.1:8787`. Do not expose port 8787 publicly.

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
getent passwd coc-witness >/dev/null || sudo useradd --system --home /opt/coc-witness --shell /usr/sbin/nologin coc-witness
sudo install -d -o root -g root -m 0755 /opt/coc-witness
sudo install -d -o coc-witness -g coc-witness -m 0700 /var/lib/coc-witness
sudo install -m 0644 /opt/coc-witness-source/witness/server.js /opt/coc-witness/server.js
sudo install -m 0644 /opt/coc-witness-source/witness/store.js /opt/coc-witness/store.js
sudo install -m 0644 /opt/coc-witness-source/witness/banking-witness.service /etc/systemd/system/banking-witness.service
sudo install -d -o root -g root -m 0750 /etc/coc-witness
sudo sh -c 'umask 077; cat > /etc/coc-witness/witness.env' <<'EOF'
WITNESS_NODE_ID=ct105-ai
WITNESS_HMAC_SECRET=REPLACE_WITH_THE_SAME_RANDOM_SECRET_ON_BOTH_HOSTS
WITNESS_BIND_HOST=127.0.0.1
WITNESS_PORT=8787
WITNESS_DATA_PATH=/var/lib/coc-witness/ledger.jsonl
EOF
sudo chown root:coc-witness /etc/coc-witness/witness.env
sudo chmod 0640 /etc/coc-witness/witness.env
sudo systemctl daemon-reload
sudo systemctl enable --now banking-witness.service
sudo systemctl status banking-witness.service --no-pager
curl --fail http://127.0.0.1:8787/health
```

Generate the shared secret on one trusted machine with `openssl rand -hex 32`.
Enter it directly into both protected environment files; never paste it into
chat, a terminal transcript, Git, or the public dashboard. The `node` runtime
must be Node.js 18 or newer. Keep Oracle's host firewall closed for port 8787;
Cloudflare Tunnel connects to the loopback listener.

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

## Integrity and limits

- On startup the service verifies sequence continuity and every ledger hash.
  A mismatch prevents it from starting, rather than silently accepting altered
  data.
- The JSONL hash chain detects accidental or partial modification; an attacker
  with Oracle root access can still rewrite the file and recompute the chain.
  Keep independent offline backups or an external anchor for stronger evidence.
- The two hosts cannot participate in one atomic database transaction. A crash
  between the PostgreSQL commit and the witness commit can leave a pending
  record/outbox item; the API exposes that state and retries finalization.
- HMAC protects the endpoint against unauthenticated network writes, not
  against root on ct105, which can read the shared key and change the producer.
- The dashboard is a view of events received by Oracle. It does not reconcile
  those events against PostgreSQL or prove that every bank transaction was
  reported; a compromised producer can suppress events before transmission.
- This is a hackathon/demo witness, not a production financial control or
  compliance system.
