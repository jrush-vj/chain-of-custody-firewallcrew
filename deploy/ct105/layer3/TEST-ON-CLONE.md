# Test the full lockout on a clone before touching the real host

This is item 5 of the full-lockout rollout: prove the lockout and the unlock both work, on a copy,
before `full-lockout.sh --real` ever runs against the real ct105. Do this from the Proxmox host
(`pve`), not from inside ct105.

## 1. Clone ct105

```bash
# on pve
pct clone 105 199 --full --hostname ct105-test
pct start 199
pct enter 199
```
(Pick any unused container id in place of `199`.) Inside the clone, update anything that would
otherwise collide with the real ct105 — it should not share ct105's public hostname/tunnel, and
should not point at the real banking database if you want a fully safe test; cloning the repo and
pointing `APP_DIR`/`COC_PG_CONTAINER` at the clone's own copies is enough for this test, since we
are only testing the OS-level lockout, not the banking app itself.

## 2. Dry run first, from inside the clone

```bash
cd /opt/chain-of-custody/deploy/ct105/layer3
python3 l3_full_lockout.py users              # confirm who it would lock: root + any demo accounts
python3 l3_full_lockout.py lock "clone test"  # dry run (no --real): prints every command, changes nothing
```
Confirm the printed plan looks right: `touch /etc/nologin`, `passwd -l` and `usermod --expiredate 1`
per user, the login-session list, and the site-down commands — before doing it for real.

## 3. Cut the clone's network and lock it for real

```bash
# inside the clone (199), simulate the network cut the real trigger responds to
sudo iptables -I OUTPUT -d <witness-ip> -j DROP   # or just pct's own network config, whatever cuts it

# still inside 199, run the real lockout
COC_I_HAVE_VERIFIED_RECOVERY=1 bash full-lockout.sh "clone test" --real
# type: LOCK OUT ROOT
```

## 4. Confirm it actually locked you out

From a separate machine, try SSH into the clone — it should fail. From `pve`, try:
```bash
pct exec 199 -- whoami    # or: ssh into 199 the normal way
```
Both should now be refused by the guest's own login path (password locked, `/etc/nologin` present).

## 5. Confirm the recovery path actually works

Still from `pve` (not depending on 199's network):
```bash
pct enter 199
```
This should succeed and drop you into a root shell inside the clone — if it does not, the recovery
path is not real, and `RECOVERY.md`'s checklist should stay unchecked.

## 6. Unlock it and confirm access is restored

From that `pct enter 199` session:
```bash
cd /opt/chain-of-custody/deploy/ct105/layer3
bash full-unlock.sh --real
```
Then confirm SSH into the clone works again normally, from a separate machine, without using
`pct enter`.

## 7. Clean up

```bash
# on pve, once you're done
pct stop 199
pct destroy 199
```

Only after all of steps 3–6 pass, exactly as described, should `COC_I_HAVE_VERIFIED_RECOVERY=1` be
set on the real ct105 and `full-lockout.sh --real` run there.
