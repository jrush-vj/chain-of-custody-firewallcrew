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
sudo install -m 0644 /opt/coc-witness-source/witness/store.js /opt/banking-witness/store.js
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
