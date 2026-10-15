# Automatic deployment on ct105-ai

This repository is the source of truth. A systemd timer on ct105-ai fetches
`main` every two minutes and rebuilds the banking stack only when files under
`banking-system/` have changed.

The timer runs on ct105-ai, not Oracle. It does not stop Docker, alter
Cloudflare Tunnel configuration, deploy the v2 Worker prototype, or delete the
PostgreSQL volume. Oracle is not used for banking builds; keep that 1 GB host
lightweight.

## One-time server setup

If the previous `/opt/chain-of-custody` checkout still exists, inspect it
before proceeding. The cleanup requested earlier may already have removed it.
Do not clone over an existing checkout.

On ct105-ai, after the new GitHub repository has a `main` branch:

```bash
sudo bash -e -c 'test ! -e /opt/chain-of-custody && git clone https://github.com/jrush-vj/chain-of-custody-firewallcrew.git /opt/chain-of-custody'
cd /opt/chain-of-custody/banking-system
sudo cp .env.example .env
sudo nano .env
sudo chmod 600 .env
```

Set unique strong values for `DB_PASSWORD`, `JWT_SECRET`,
<<<<<<< HEAD
`DATA_ENCRYPTION_KEY`, and `EXTERNAL_PAYMENTS_API_KEY`. Do not use sample
values, and do not put `.env` in Git. `DATA_ENCRYPTION_KEY` must be at least 32
characters.
If the repository is private, configure a read-only GitHub deploy key for the
clone/service account before installing the polling timer.

=======
`DATA_ENCRYPTION_KEY`, `EXTERNAL_PAYMENTS_API_KEY`, and `WITNESS_HMAC_SECRET`.
Do not use sample values, and do not put `.env` in Git.
`DATA_ENCRYPTION_KEY` and `WITNESS_HMAC_SECRET` must each be at least 32
characters. Set `WITNESS_URL=https://witness.jrushvj.dev` and
`WITNESS_NODE_ID=ct105-ai`. Configure exactly the same witness HMAC secret in
the Oracle witness service. Do not paste the secret into chat or commit it.
If the repository is private, configure a read-only GitHub deploy key for the
clone/service account before installing the polling timer.

Follow [`../../witness/README.md`](../../witness/README.md) to deploy the
Oracle witness first. Do not deploy the banking witness integration until
`https://witness.jrushvj.dev/health` succeeds from ct105 and all three
`WITNESS_*` values are set in `.env`.

>>>>>>> firewallcrew-publish
Validate and initially start the application:

```bash
sudo docker compose config --quiet
sudo docker compose up -d --build postgres backend frontend
curl --fail http://127.0.0.1:8081/health
curl --fail http://127.0.0.1:3001/
```

The frontend is bound at `127.0.0.1:3001`, matching the existing
`bank.jrushvj.dev` Cloudflare Tunnel origin. Verify the existing tunnel still
points there; do not replace its credentials or DNS record. Once the local
curl checks work, test `https://bank.jrushvj.dev`.

## Enable automatic deployment

```bash
sudo install -m 0644 /opt/chain-of-custody/deploy/ct105/banking-deploy.service \
  /etc/systemd/system/banking-deploy.service
sudo install -m 0644 /opt/chain-of-custody/deploy/ct105/banking-deploy.timer \
  /etc/systemd/system/banking-deploy.timer
sudo systemctl daemon-reload
sudo systemctl enable --now banking-deploy.timer
sudo systemctl start banking-deploy.service
sudo systemctl status banking-deploy.timer --no-pager
sudo journalctl -u banking-deploy.service -n 80 --no-pager
```

The service refuses to overwrite local tracked changes and only accepts
fast-forward updates. Failed builds/health checks leave the commit marked
undeployed, so a later timer run retries. Check status and logs before pushing
another release.

<<<<<<< HEAD
=======
## Applying a repository release on ct105

For a dashboard-only Oracle release, ct105 only needs the new root commit and
the submodule revision pinned by it; no banking containers need rebuilding.
On ct105, first confirm the checkout is clean. Then pause the timer while the
deployment service advances the checkout and the submodule:

```bash
sudo git -C /opt/chain-of-custody branch --show-current
sudo git -C /opt/chain-of-custody status --short
test "$(sudo git -C /opt/chain-of-custody branch --show-current)" = main
test -z "$(sudo git -C /opt/chain-of-custody status --porcelain)"
sudo systemctl stop banking-deploy.timer
trap 'sudo systemctl start banking-deploy.timer' EXIT
sudo systemctl start banking-deploy.service
sudo git -C /opt/chain-of-custody submodule update --init --recursive
sudo git -C /opt/chain-of-custody status --short
sudo systemctl start banking-deploy.timer
trap - EXIT
sudo systemctl status banking-deploy.timer --no-pager
curl --fail https://witness.jrushvj.dev/health
```

If the initial status check shows local changes, do not pull over them; inspect
and preserve them first. The deployment service will rebuild the banking
stack only if `banking-system/` changed, and the submodule update checks out
the exact cybersec commit recorded by the root repository. Do not run `docker
compose down`, remove volumes, or rebuild PostgreSQL for an Oracle dashboard
change.

The transaction API requires a successful Oracle `prepare` acknowledgement
before committing deposits, withdrawals, transfers, and external payments.
If the witness is unavailable at that stage, PostgreSQL rolls back the
transaction. If the witness becomes unavailable after PostgreSQL commits, the
API returns HTTP 202 with `witness_status: "pending"` and retries finalization
from the PostgreSQL outbox. Do not resubmit a transaction with a pending or
uncertain response until you have checked transaction history.

>>>>>>> firewallcrew-publish
After editing and testing locally, push to the repository's `main` branch.
Within two minutes, ct105 fetches the commit, builds changed banking services,
restarts the Compose stack, and verifies both local health endpoints. Follow
the process with:

```bash
sudo journalctl -u banking-deploy.service -f
sudo docker compose -f /opt/chain-of-custody/banking-system/docker-compose.yml ps
```

## Rollback

Revert the faulty source change and push the revert to `main`. The polling
deployment then fast-forwards and redeploys that version. Do not reset the
server checkout or edit its tracked files by hand.
