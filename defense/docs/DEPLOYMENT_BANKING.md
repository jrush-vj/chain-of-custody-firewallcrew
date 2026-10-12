# Banking demo deployment

## Topology

```text
Vercel
  └── defense dashboard / public status page

Ubuntu banking VPS
  ├── Banking API + PostgreSQL
  ├── backend/tools/coc-audit-spooler.js
  └── Chain of Custody sidecar (spool mounted read-only)

Separate trusted host
  └── Railway witness service + persistent volume
```

The defense is split into two roles:

- The sidecar runs beside the bank on Ubuntu and continuously sends signed
  checkpoints and heartbeats.
- The witness stores those signed records outside the bank VPS trust boundary.

The current witness is a stateful FastAPI process backed by SQLite. It is not
safe to deploy unchanged as a Vercel function: function instances are
ephemeral, local files are not durable, and there is no permanent process to
run the heartbeat/silence monitor. Vercel can host a public defense dashboard,
but the witness runs on Railway with a persistent volume.

## Ubuntu VPS

1. Run the banking migration once by starting the backend. It creates the
   `coc_audit` table and the transaction trigger.
2. Create a database role that can only read `coc_audit`.
3. Start the spooler with `COC_DB_USER`, `COC_DB_PASSWORD`, `COC_SPOOL_PATH`,
   and `COC_AUDIT_STATE_PATH`.
4. Start the sidecar with a profile whose `spool_path` points to the same
   `events.jsonl`. Mount that spool read-only.
5. Run the verifier from an operator host, passing the node id explicitly.

The spooler is the only writer. It appends one RawEvent per audit row and
persists its audit offset. The sidecar chains those events and stops if the
spool is shrunk, replaced, or changes behind its saved offset.

## Witness placement

The witness must be outside the banking VPS trust boundary. If an attacker has
root on the VPS, no local process can guarantee that the attacker cannot stop
or replace it. The remote witness makes missing heartbeats and divergent
checkpoints visible to the operator and keeps the signed history outside the
attacker's write access.

## Ubuntu VPS: install the banking system

```bash
sudo apt update
sudo apt install -y git docker.io docker-compose-plugin nodejs npm python3-venv
sudo systemctl enable --now docker
sudo mkdir -p /opt/banking /opt/banking-security-demo/defense
sudo chown -R "$USER:$USER" /opt/banking /opt/banking-security-demo/defense
git clone <BANKING_REPOSITORY_URL> /opt/banking
git clone <DEFENSE_REPOSITORY_URL> /opt/banking-security-demo/defense
```

Create `/opt/banking/.env` with production secrets. Do not commit this file:

```dotenv
JWT_SECRET=<long-random-value>
DATA_ENCRYPTION_KEY=<long-random-value>
POSTGRES_PASSWORD=<long-random-value>
CORS_ORIGINS=https://your-bank-frontend.example
```

Update the PostgreSQL password in `docker-compose.yml` or, preferably, move
the values into the compose environment. Start the banking stack:

```bash
cd /opt/banking
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8080/health
```

The first backend start creates the `coc_audit` table and transaction trigger.

## Ubuntu VPS: generate evidence and run the sidecar

Create a directory that only the spooler can write and the sidecar can read:

```bash
sudo mkdir -p /srv/chain-of-custody/spool /srv/chain-of-custody/data
sudo chown -R "$USER:$USER" /srv/chain-of-custody
```

Create a read-only PostgreSQL role from the database container:

```bash
docker exec -it banking-postgres psql -U postgres_username -d bankingsystem
```

Run:

```sql
CREATE ROLE coc_reader LOGIN PASSWORD '<different-random-password>';
GRANT CONNECT ON DATABASE bankingsystem TO coc_reader;
GRANT USAGE ON SCHEMA public TO coc_reader;
GRANT SELECT ON coc_audit TO coc_reader;
\q
```

Copy the defense profile and set its paths:

```bash
cd /opt/banking-security-demo/defense
cp config.example.toml config.toml
mkdir -p spool data
```

Set `spool_path = "/srv/chain-of-custody/spool/events.jsonl"` and use a unique
`node_id`. Generate the node key:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -c "from pathlib import Path; from sidecar.keys import load_or_generate_keypair; print(load_or_generate_keypair(Path('data/node1.key'), Path('data/node1.pub'))[1])"
```

Add the printed public key to the trusted-node file on the witness host. Do
not put the witness database or private key on the banking VPS.

## Railway: host the witness

Railway is the simple external host for the existing witness. It runs the
long-lived FastAPI process and stores its SQLite database on a persistent
volume. The Railway service is outside the banking VPS, so a root attacker on
the bank cannot edit the witness database.

1. Create a Railway project and choose **Deploy from GitHub repo**.
2. Select the `banking-security-demo/defense` repository/folder.
   Railway will use the committed `railway.toml` and
   `deploy/railway/Dockerfile`.
3. Add a Railway volume mounted at `/data`.
4. Add these Railway variables:

```text
WITNESS_NODE_ID=node-1
WITNESS_NODE_PUBLIC_KEY=<contents of /opt/banking-security-demo/defense/data/node1.pub>
```

5. Generate a public Railway domain from the service's Networking settings.
6. Confirm the service is listening on Railway's assigned `PORT`.

The `start.sh` script creates `/data/witness_nodes.toml` from the variables and
stores the witness database at `/data/witness.db`. The public key is not a
private secret; never upload the node private key to Railway.

Copy the Railway HTTPS domain into the banking VPS `config.toml`:

```toml
[heartbeat]
interval_s = 30
witness_url = "https://your-service.up.railway.app"
```

Restart the sidecar and confirm heartbeats:

```bash
curl "https://your-service.up.railway.app/heartbeats?node_id=node-1&limit=5"
curl "https://your-service.up.railway.app/alerts?node_id=node-1&limit=20"
```

For a public hackathon demo, treat those query endpoints as observable status
endpoints and do not store real customer data. For a production deployment,
put authentication or a dashboard API in front of them.

Run the banking spooler with the read-only role:

```bash
cd /opt/banking/backend
export DB_HOST=127.0.0.1
export DB_PORT=5432
export DB_NAME=bankingsystem
export COC_DB_USER=coc_reader
export COC_DB_PASSWORD='<coc-reader-password>'
export COC_SPOOL_PATH=/srv/chain-of-custody/spool/events.jsonl
export COC_AUDIT_STATE_PATH=/srv/chain-of-custody/spool/.audit-offset
npm run coc:spool
```

Run the sidecar in another service/process:

```bash
cd /opt/banking-security-demo/defense
. .venv/bin/activate
python -m sidecar.main --config config.toml
```

For production, put both commands in systemd services with
`Restart=always`, `WorkingDirectory`, and an environment file. Do not run them
from an SSH terminal only.

## Demonstrating tampering

This is a controlled demo procedure on a disposable test VPS. Stop the
spooler/sidecar before editing test data, then create a transaction and let the
sidecar checkpoint it. Make a copy of the spool and alter one JSON field or
delete one complete line. Run:

```bash
cd /opt/banking-security-demo/defense
. .venv/bin/activate
python -m verifier --config config.toml --node-id node-1 --witness https://<witness-host>
```

The verifier should report a changed entry, truncation, deletion, fork, or
rollback. Never use real customer data for this demonstration.

## Vercel deployment options

### Recommended

Deploy a separate defense dashboard to Vercel that reads a protected,
read-only status endpoint exposed by the Railway witness. Keep the witness on
Railway with the `/data` persistent volume. This preserves the security
property: root on the banking VPS cannot edit the witness history.

### If Vercel must host the witness

The current Python witness cannot be deployed safely unchanged. It must be
adapted to:

1. use an external durable database such as Neon/Postgres, not SQLite;
2. expose the FastAPI app through a Vercel Python function;
3. move silence monitoring from its in-process background loop to a scheduled
   job;
4. keep the trusted node public keys in durable configuration/secret storage;
5. protect query endpoints with authentication and rate limits.

Until that rewrite is completed, do not claim that Vercel is the witness. Use
Vercel for the dashboard and a separate durable host for the witness.
