# systemd installation

These units assume:

- the banking repo is at `/opt/banking`;
- this repo is at `/opt/banking-security-demo/defense`;
- the runtime user is `coc`;
- the spool is `/srv/chain-of-custody/spool`.

Create the user and directories:

```bash
sudo useradd --system --home /opt/banking-security-demo/defense --shell /usr/sbin/nologin coc
sudo install -d -o coc -g coc /srv/chain-of-custody/spool
sudo install -d -o coc -g coc /opt/banking-security-demo/defense/data
sudo install -d -o root -g coc -m 0750 /etc/chain-of-custody
```

Create `/etc/chain-of-custody/banking.env`:

```dotenv
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=bankingsystem
COC_DB_USER=coc_reader
COC_DB_PASSWORD=replace-me
COC_SPOOL_PATH=/srv/chain-of-custody/spool/events.jsonl
COC_AUDIT_STATE_PATH=/srv/chain-of-custody/spool/.audit-offset
```

Create `/etc/chain-of-custody/sidecar.env`:

```dotenv
PYTHONUNBUFFERED=1
```

Copy both unit files to `/etc/systemd/system/`, then:

```bash
sudo chmod 600 /etc/chain-of-custody/*.env
sudo chown root:coc /etc/chain-of-custody/*.env
sudo systemctl daemon-reload
sudo systemctl enable --now coc-spooler coc-sidecar
sudo systemctl status coc-spooler coc-sidecar
sudo journalctl -u coc-spooler -u coc-sidecar -f
```

Install the sidecar virtual environment and ensure `config.toml` points to the
same spool path before starting the units. The witness is intentionally not
included here; run it on a separate trusted host.
