# Recovery path — read this before you ever run `full-lockout.sh --real`

The full lockout can disable root. The condition that triggers Layer 3 in the first place is
usually a network cut — which is also exactly when SSH access disappears. If both happen together
and there is no way back in that works **without the guest's own network or login system**, the
host stays locked, permanently, with no page or terminal that can undo it. This is not a
hypothetical: `l3_full_lockout.py`'s whole job is to make that true.

**Do not run `full-lockout.sh --real` or set `COC_I_HAVE_VERIFIED_RECOVERY=1` until the path below
is actually tested**, on a clone (see `TEST-ON-CLONE.md`), not assumed.

## The path this setup already has: the Proxmox host

ct105 runs as an LXC container on a Proxmox host (seen in this project as `root@pve:~#`, entering
the container with `pct enter 105`). That command attaches to the container's process namespace
directly through the Proxmox host's container runtime — it is not a network login and does not go
through the guest's sshd, PAM, `/etc/nologin`, or account lock state. In principle that means it
keeps working even after `full-lockout.sh --real` has locked out root and cut `sshd` access inside
the guest.

**That "in principle" is exactly what must be verified, not trusted:**

1. Is the Proxmox host (`pve`) itself reachable on a network path that is independent of ct105's
   own network — i.e. does cutting ct105's network (which is what triggers Layer 3) also cut your
   path to `pve`? If `pve` is reachable only through the same uplink ct105 uses, this is not a real
   recovery path.
2. Who has credentials to `pve`, and is that access itself reliable (not, for example, behind a
   VPN that routes through the same link)?
3. Does `pct enter 105` actually still work after `full-lockout.sh --real` has run — confirmed by
   testing it on a clone, with root really locked, not guessed from how LXC is documented to work.

## What "verified" means here

Before setting `COC_I_HAVE_VERIFIED_RECOVERY=1` anywhere, you should be able to say yes to all of:

- [ ] I ran `full-lockout.sh --real` against a **clone** of ct105 (`TEST-ON-CLONE.md`), with its
      network cut, and confirmed SSH into the clone stopped working and root was really locked.
- [ ] From a session that does **not** depend on the clone's own network, I got back in — in this
      setup, that means `pct enter <clone-id>` run from the Proxmox host itself, reached over a
      path independent of the clone's network.
- [ ] From that session, `full-unlock.sh --real` (or the manual commands it runs) actually restored
      login.
- [ ] I know exactly who has access to the Proxmox host today, and that it does not depend on ct105
      or the clone being reachable.

If any of those is unverified or "probably", the recovery path is unverified. Do not enable the
full lockout on the real host.

## If there is no verified recovery path

Keep using the demo-account-only lockout (`lockout.sh` / `unlock.sh`) for anything live. It only
ever touches one account that was created for this purpose, never root, and can always be reversed
with the 2-of-3 keys from the same terminal session you're already in — it needs no recovery path
because it never removes your own access in the first place.
