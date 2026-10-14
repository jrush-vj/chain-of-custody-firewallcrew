# Layer 3: quarantine

Two things are built here, and they are deliberately separate:

1. **The full response** (`l3_quarantine.py`) — site down, every banking customer session revoked,
   restore settings, reboot ct105 — stays a **dry run**. It is recorded and reported to the witness,
   nothing is executed. This never changes regardless of what triggers it.
2. **A real, narrow demonstration** (`l3_lockout.py`) — pushes one dedicated demo account out for
   real: ends its login sessions and disables its login. It is hard-scoped to that one account and
   can never touch root, your own login, or any other account, no matter what environment variable
   is set or what triggers it (`resolve_demo_user()` checks this three independent ways every time
   it runs; see `test_l3_lockout.py`'s `SafetyGuardTests`).

## One-time setup

```bash
sudo bash setup-demo-account.sh
```

Creates `coc-demo-intruder` (no sudo, uid >= 1000, password printed once). This is the *only* account
the real lockout script will ever act on.

## Demo flow

Terminal A (ct105, as root):
```bash
# show the 3 fixed demo unlock keys ahead of time if you want to display them first
bash generate-unlock-keys.sh

# trigger the lockout directly (for a snappy demo, instead of waiting for the automatic trigger)
bash lockout.sh "manual demo"
```

Terminal B (ct105, as the demo "intruder"), to have a session to actually push out:
```bash
su - coc-demo-intruder
```
Running `lockout.sh` in Terminal A ends that session and disables the account's login; Terminal B
gets dropped.

Unlock, needs any 2 of the 3 printed keys:
```bash
bash unlock.sh "SOC-7F3A-9C21-LEAD" "AUD-4B88-E015-CHEK"
```

## Automatic trigger

`monitor.py` already runs on ct105 as a service watching for either cause: the approved witness link
settings changing, or no contact with the witness for `QUARANTINE_AFTER_S` (default 45s) — the two
causes `attack-layer3.sh config` / `attack-layer3.sh cut` simulate. When it fires, it calls
`respond_to_layer3()`, which does the real demo-account lockout (same `l3_lockout.lock()` as above)
and prints the 3 unlock keys to the monitor's log. Set `COC_LAYER3_REAL_LOCKOUT=0` in the monitor's
environment to fall back to the pure dry-run report instead (e.g. on a host with no demo account set
up yet — the monitor also falls back to the dry run by itself if the demo account is missing or unsafe,
it never crashes or silently does nothing).

## What the witness page shows

The Layer 3 card plays a ~2 second "disconnecting" animation (a red sweep, "DISCONNECTING…", the top
connection pill reading "NETWORK OFFLINE") the moment it first sees the quarantine, then settles on
"QUARANTINED". The panel below lists what was really done (✓) separately from what is still only
planned (•), and states plainly that only the demo account was touched.

The page's own "Approve" buttons (2-of-3 holder clicks) are a **cosmetic record of a vote** — the
witness cannot reach back into ct105 to unlock anything. For a real lockout, clicking them records
the approval but says so explicitly; the account is only actually restored by running `unlock.sh` on
ct105 with the real keys.

## "Restore to normal"

The website's "Restore to normal" button (via `monitor.py`'s poll of `/v1/restore-pending`) restores
Layer 1 files, Layer 2 rows, and Layer 3's approved witness-link settings — but it does **not** touch
the demo account's lock state. That is intentional: it would otherwise let anyone on the public page
bypass the "needs 2 of 3 keys" demonstration with one click.
