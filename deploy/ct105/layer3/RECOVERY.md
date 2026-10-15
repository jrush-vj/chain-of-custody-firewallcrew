# Recovery path for a full Layer 3 lockout

Full mode can lock root and creates `/etc/nologin`. If the witness network is also unavailable,
SSH is not a recovery method. Do not enable full mode on ct105 until this path has been tested on a
disposable clone.

## Recovery from the Proxmox console

ct105 is an LXC container. From the Proxmox host, enter the container directly:

```bash
pct enter 105
```

This path does not depend on ct105's SSH daemon, network, PAM, or interactive account status.
Inside the container, use the protected copy of any two full-mode keys and run:

```bash
cd /opt/chain-of-custody-firewallcrew/deploy/ct105/layer3
COC_L3_MODE=full bash unlock.sh "KEY-ONE" "KEY-TWO"
```

`unlock.sh` verifies two distinct key hashes, reads the saved state file, removes `/etc/nologin`,
and restores only the accounts recorded in that file. It restores the prior password-lock and
account-expiry state. It does not restart the banking frontend or any other service.

Keep the key file and break-glass password in a secure location outside ct105. The key generator
prints hashes only, not key material. Website approvals do not replace the local two-key unlock.

## Before relying on this path

- Test entry with `pct enter` after a real full lockout on a disposable clone.
- Test that two keys restore every saved account to its previous `passwd -S` and `chage -l` state.
- Verify that the break-glass account remains available and that monitor/agent processes and their
  parent processes were not terminated.
- Ensure access to the Proxmox host itself does not depend on the network path being cut.

The installed monitor service currently runs as root. Full mode intentionally refuses to run when
the monitor account is root; a separate non-root monitor identity with the required privileged
full-action path must be configured and tested before full mode can execute automatically.

If any recovery step is uncertain, keep `COC_L3_MODE=demo` (the default). Demo mode only disables
the dedicated `coc-demo-intruder` account and cannot lock out root.
