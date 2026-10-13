# Operations and Troubleshooting

## Daily health checks

### Banking host

```bash
docker compose -f /opt/chain-of-custody/banking-system/docker-compose.yml ps
sudo systemctl is-active cloudflared
sudo systemctl is-active coc-spooler
sudo systemctl is-active coc-sidecar
```

Check the local endpoints:

```bash
curl http://127.0.0.1:8081/health
curl -I http://127.0.0.1:3001
```

### Oracle witness

```bash
sudo systemctl is-active coc-witness
sudo systemctl is-active cloudflared
curl -I http://127.0.0.1:8800
```

Check remote evidence:

```bash
curl "https://witness.jrushvj.dev/heartbeats?node_id=node-1&limit=5"
curl "https://witness.jrushvj.dev/alerts?node_id=node-1&limit=20"
```

The dashboard is available at:

```text
https://witness.jrushvj.dev
```

## Logs

```bash
sudo journalctl -u coc-spooler -n 100 --no-pager
sudo journalctl -u coc-sidecar -n 100 --no-pager
sudo journalctl -u coc-witness -n 100 --no-pager
sudo journalctl -u cloudflared -n 100 --no-pager
docker logs --tail 100 banking-backend
```

## Common issues

### Spooler is restarting

Look for PostgreSQL authentication errors:

```bash
sudo journalctl -u coc-spooler -n 100 --no-pager
```

The password in `/etc/chain-of-custody/banking.env` must match the password
for `coc_reader`. Test the read-only query:

```bash
PGPASSWORD='reader-password' psql \
  -h 127.0.0.1 -U coc_reader -d bankingsystem \
  -c "SELECT COUNT(*) FROM coc_audit;"
```

### Spool directory is empty

Check that the audit table and trigger exist:

```bash
docker exec banking-postgres psql -U postgres_username -d bankingsystem \
  -c "SELECT COUNT(*) FROM coc_audit;"

docker exec banking-postgres psql -U postgres_username -d bankingsystem \
  -c "SELECT tgname FROM pg_trigger WHERE tgrelid = 'transactions'::regclass AND NOT tgisinternal;"
```

Create a demo deposit or transfer and wait a few seconds.

### Sidecar stops with `STOPPING INGEST`

This means the sidecar detected that the already-consumed spool history changed,
was truncated, or was replaced. Do not delete the sidecar database to make the
message disappear; that would destroy local evidence. Follow the restoration
procedure in [TAMPERING_DEMO.md](./TAMPERING_DEMO.md).

### Witness shows `SILENCE`

`SILENCE` means the witness has not received a fresh valid heartbeat for the
configured window. Check, in order:

1. `coc-sidecar` status and logs on the banking host.
2. `cloudflared` status on both hosts.
3. `curl https://witness.jrushvj.dev`.
4. The witness service and database on Oracle.

Historical alerts remain in the witness database by design.

### Run the spool-versus-record check

The defense branch includes a read-only local check that compares newly
tracked spool lines with the values retained in the sidecar hash chain:

```bash
cd /opt/chain-of-custody/defense
./.venv/bin/python -m coc.check --config config.toml
```

After a controlled edit, it reports both values, for example:
`details.amount recorded 5000, spool now 5`. Entries consumed before line
tracking was deployed are reported as older, untracked entries.

### Dashboard shows `Not Found`

The dashboard is served by the witness root route `/`. Pull the latest
repository version on Oracle and restart `coc-witness`:

```bash
cd /opt/chain-of-custody
sudo git -c safe.directory=/opt/chain-of-custody pull origin main
sudo systemctl restart coc-witness
```

### Docker ports are already in use

Inspect the owners before stopping anything:

```bash
ss -ltnp | grep -E ':(3000|3001|8080|8081|5432)\b'
```

Keep existing services such as Open WebUI and llama-server running; use
alternative localhost mappings in Compose instead.

## Backups

Back up the following separately:

- PostgreSQL volume or database dump.
- `/var/lib/coc-witness/witness.db` on Oracle.
- Sidecar private key on the banking host.
- Cloudflare tunnel credential files.
- Production `.env` files and systemd environment files.

Never commit these files to Git.
