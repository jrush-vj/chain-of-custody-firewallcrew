# Validate full Layer 3 lockout on a disposable clone

Never use the real ct105 for this test. Full mode remains disabled on the real host.

## 1. Clone ct105 from the Proxmox host

```bash
pct clone 105 199 --full --hostname ct105-test
pct start 199
pct enter 199
```

Choose an unused container ID. Ensure the clone cannot access the real banking database or use
ct105's public hostname/tunnel.

## 2. Prepare the clone

Inside the clone:

```bash
cd /opt/chain-of-custody-firewallcrew/deploy/ct105/layer3
bash setup-break-glass.sh
COC_L3_MODE=full bash generate-unlock-keys.sh /root/coc-layer3-full-keys.txt
```

Copy the generated keys to a secure location outside the clone. The command prints only hashes.
Before a full run, configure a non-root monitor identity with the required privileged action path;
the current root-run monitor service is deliberately refused by the full-mode guard.

## 3. Verify the recovery path before triggering

From the Proxmox host, confirm you can still enter the clone directly:

```bash
pct enter 199
```

Do not proceed if this does not work independently of the clone's SSH/network login.

## 4. Trigger only on the clone

After the monitor identity and full-mode configuration have been reviewed on the clone, set
`COC_L3_MODE=full` and `COC_L3_FULL_CONFIRM=I_UNDERSTAND_ROOT_LOCKOUT` in the clone's monitor
environment. Disconnect only the clone's witness network and wait for the configured timeout
(default 45 seconds), or use the guarded manual entry point:

```bash
COC_L3_MODE=full COC_L3_FULL_CONFIRM=I_UNDERSTAND_ROOT_LOCKOUT \
  bash full-lockout.sh "clone recovery test"
```

Confirm the evidence directory contains the `ps`, `ss`, `who`, and bank-log-hash captures. Confirm
the site-down command, account states, session termination, and break-glass availability in the
saved state. Full mode does not reboot.

## 5. Recover through the Proxmox console

From the Proxmox host:

```bash
pct enter 199
cd /opt/chain-of-custody-firewallcrew/deploy/ct105/layer3
COC_L3_MODE=full bash unlock.sh "KEY-ONE" "KEY-TWO"
```

Verify that `passwd -S` and `chage -l` match the pre-lock values for each account recorded in the
saved state. Verify `/etc/nologin` is gone, and confirm the script did not restart the frontend.

## 6. Remove the clone

After recording the result:

```bash
pct stop 199
pct destroy 199
```

Do not enable full mode on real ct105 based only on a dry run or unit tests.
