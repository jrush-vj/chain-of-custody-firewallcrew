# Tampering Demonstration

This procedure is for a disposable hackathon demonstration only. Use demo
data, not real customer information.

## What the demo proves

```text
Edit an old local evidence line
  → sidecar detects the changed history
  → sidecar sends SPOOL_TAMPER
  → witness dashboard shows the detail
  → sidecar stops
  → witness later raises SILENCE
```

The witness does not directly read the banking file. It receives signed
messages from the sidecar, which keeps the trust boundary meaningful.

## Before starting

Confirm the following on the banking host:

```bash
sudo systemctl is-active coc-spooler
sudo systemctl is-active coc-sidecar
test -s /srv/chain-of-custody/spool/events.jsonl
```

Open the witness dashboard:

```text
https://witness.jrushvj.dev
```

## One-block tamper script

Run this on the homelab or banking host. It changes only the first matching
`"amount":5000` in the evidence spool and preserves a rollback copy:

```bash
set -eu

SPOOL="/srv/chain-of-custody/spool/events.jsonl"
BACKUP="${SPOOL}.before-tamper"

sudo test -f "$SPOOL"
sudo grep -q '"amount":5000' "$SPOOL"
sudo systemctl stop coc-spooler
sudo cp -p "$SPOOL" "$BACKUP"
sudo sed -i 's/"amount":5000/"amount":5/' "$SPOOL"
sudo grep -o '"amount":[0-9]*' "$SPOOL"
echo "Tamper written. Watch: sudo journalctl -u coc-sidecar -f"
echo "Dashboard: https://witness.jrushvj.dev"
```

Keep the sidecar running while the edit occurs. It should stop itself after
detecting the changed line and report a signed `SPOOL_TAMPER` alert.

Expected dashboard detail:

```text
log changed: transaction amount 5000 -> 5
```

The witness may also show `SILENCE` after approximately 75 seconds because the
sidecar no longer sends heartbeats. That is a second, remote indication.

## Restore after the demo

```bash
sudo systemctl stop coc-sidecar
sudo cp -p \
  /srv/chain-of-custody/spool/events.jsonl.before-tamper \
  /srv/chain-of-custody/spool/events.jsonl
sudo rm -f /srv/chain-of-custody/spool/events.jsonl.before-tamper
sudo systemctl start coc-spooler
sudo systemctl start coc-sidecar
sudo systemctl is-active coc-spooler
sudo systemctl is-active coc-sidecar
```

The alert remains visible after recovery because the witness is append-only
and preserves historical security events.
