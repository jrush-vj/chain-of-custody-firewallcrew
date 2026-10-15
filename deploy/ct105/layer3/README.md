# Layer 3: quarantine and recovery

Layer 3 has two modes. The configuration selects the scope; `demo` is the default.

| Mode | Effect |
| --- | --- |
| `demo` (default) | Locks only `coc-demo-intruder`, ends that account's login sessions, and uses the existing 2-of-3 demo keys. If the account is missing or unsafe, the monitor reports a dry run. |
| `full` | Captures and seals evidence, stops the configured site service, creates `/etc/nologin`, locks every interactive login account including root, ends their login sessions, saves recovery state, and reports the quarantine event. It never reboots. |

The full mode is off unless `COC_L3_MODE=full` **and**
`COC_L3_FULL_CONFIRM=I_UNDERSTAND_ROOT_LOCKOUT` are both set. Full mode also refuses to run unless
the break-glass account and full-mode unlock-key hashes are present. Keep the break-glass account
in `COC_KEEP_ACCOUNTS`; the implementation also protects that account and the monitor account from
the lockout.

**Full mode has not been enabled or deployed on ct105.** The current Layer 1 systemd service runs as
root, so the full-mode guard refuses to run there: the monitor must run under a separate non-root
identity, and the full action must still have the required root privileges. Configure and test that
operational setup on a clone before enabling the full confirmation. This change does not modify the
systemd deployment or the banking application.

## Demo mode setup and recovery

On ct105, create the dedicated demo account:

```bash
sudo bash setup-demo-account.sh
```

The account has no administrative groups and is the only target in demo mode. In a second terminal,
open a session as `coc-demo-intruder`, then trigger the lockout from the first terminal:

```bash
su - coc-demo-intruder
# In the first terminal:
sudo bash lockout.sh "manual demo"
```

Generate the demo key file without printing key material to the terminal or monitor log:

```bash
sudo bash generate-unlock-keys.sh /root/coc-layer3-demo-keys.txt
```

The command prints SHA-256 hashes only. The file is mode `0600`; use the two required keys from that
file to recover:

```bash
sudo bash unlock.sh "KEY-ONE" "KEY-TWO"
```

## Full-mode prerequisites

1. Test the lockout and recovery on a disposable ct105 clone; see [RECOVERY.md](./RECOVERY.md) and
   [TEST-ON-CLONE.md](./TEST-ON-CLONE.md). The recovery path must use the Proxmox console, not SSH
   or the public witness website.
2. Create the dedicated, non-admin break-glass account on the clone:

   ```bash
   sudo bash setup-break-glass.sh
   ```

   The generated long password is displayed once and is not saved in plaintext. The Linux shadow
   database retains its password hash. Keep the account password login enabled and store the
   password securely off-host; this account is exempt from full lockout.
3. Generate the full-mode 2-of-3 keys to a protected file. The file contains the key material;
   terminal output contains only hashes. Preserve a protected copy outside ct105:

   ```bash
   sudo env COC_L3_MODE=full bash generate-unlock-keys.sh /root/coc-layer3-full-keys.txt
   ```

   The implementation uses three independent random keys and accepts any two matching hashes; it
   does not require `pycryptodome` or Shamir secret sharing.
4. Configure the monitor environment only after the separate non-root monitor identity and
   privileged full-action path have been implemented and verified on the clone:

   ```ini
   COC_L3_MODE=full
   COC_L3_FULL_CONFIRM=I_UNDERSTAND_ROOT_LOCKOUT
   COC_KEEP_ACCOUNTS=coc-break-glass
   COC_L3_BREAK_GLASS_ACCOUNT=coc-break-glass
   ```

   The default site-down command is `docker compose -f <bank-compose-file> stop frontend`.
   Override it with `COC_SITE_DOWN_CMD` only after reviewing the exact command. The state and
   evidence directory defaults to `/var/lib/coc-layer3`; bank log hashing defaults to
   `/var/log/bank-demo`.

## Automatic trigger

The monitor's trigger is unchanged: an approved witness-link configuration change or no successful
witness contact for `QUARANTINE_AFTER_S` seconds (default 45). In `demo`, this keeps the existing
demo-account response. In `full`, the full action is attempted only with the exact confirmation and
all prerequisites; a refusal is logged and reported as a dry run. No unlock key is printed to the
monitor log.

## Full-mode recovery

Website approvals are not accepted by the full lockout script. Approve buttons are votes only for
the witness workflow; full-mode recovery requires running `unlock.sh` on ct105 from the Proxmox
console or a usable break-glass session, with any two of the three full-mode keys:

```bash
sudo bash unlock.sh "KEY-ONE" "KEY-TWO"
```

The script reads the saved full-lockout state, removes `/etc/nologin`, restores each account's
previous password-lock and account-expiry state, and does not restart services. The saved state—not
a newly discovered account list—is the source of accounts to restore. The banking frontend remains
stopped for deliberate operator review. A failed lock or unlock action is recorded as partial and
keeps the recovery pointer in place; use the evidence/state file and retry recovery rather than
treating a partial result as success.

## Witness and banking boundaries

Layer 3 reports through the existing monitor event path. This change does not modify the Cybersec
submodule, the Node witness, Cloudflare configuration, or anything under `banking-system/`. The
existing Cybersec witness approval implementation is therefore unchanged; do not treat its signed
unlock workflow as the recovery path for this separate full-lockout mode.

The public witness cannot directly unlock ct105. The 2-of-3 website votes and the full-mode local
keys are separate controls; only the local `unlock.sh` verifies the full-mode keys and restores the
saved account state. The upstream Cybersec frontend is integrated unchanged; it does not currently
display the local break-glass account status or this local recovery rule. Do not enable full mode
until that UI limitation is resolved without changing the upstream source.
