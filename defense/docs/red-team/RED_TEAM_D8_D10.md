# Red team / blue team report: D8 to D10

Date: 2026-10-10. Reviewer: Claude (red team, then blue team).
Scope: what Antigravity built for D8 (verifier `--witness`), D9 (self-test tampering suite) and D10 (Dockerfiles, `defence-compose.yml`, docs), plus the two items carried over to D10 (RT-16, RT-27). Earlier fixes (RT-01 to RT-26) were re-checked by the full test run.
Method: same as before. Read every changed file, ran each D8 attack as a script against the real verifier and a real witness app (TestClient), then fixed, added a regression test per finding and re-ran the attack. **Docker is not installed on this machine**, so the D10 findings come from reading the files plus a run of the sidecar and witness laid out the way the containers see their files (see Verification). The images themselves were not built.

Starting point: 146 tests passed. The D8 core idea is right: TRUNCATION from the highest witnessed head, FORK by comparing the local hash at each witnessed `seq`. That already defeats the attack left open after D7 (swapped `node1.pub` plus a full re-sign) and truncate-then-regrow.

Rank key: **BREAKS** = the attack succeeds and defeats a guarantee. **WEAKENS** = makes an attack easier, or a failure silent or noisy. **NITPICK** = hygiene.

## Summary

| ID | Step | Rank | Attack | Before | After |
|----|------|------|--------|--------|-------|
| RT-28 | D8 | BREAKS | With the stolen node key: rewrite from seq K, re-sign, then send the forged head to the witness as a new heartbeat and checkpoint | verifier with witness says clean | FIXED: FORK ("witness holds 2 different head_hash values" plus the witness's FORK alert) |
| RT-29 | D8 | BREAKS | Rewrite the log, then change `node_id` in `config.toml` to a name the witness never saw | verifier with witness says clean | FIXED: exit 2 "witness has no heartbeats or checkpoints for node_id 'ghost'"; `--node-id` added |
| RT-30 | D8 | WEAKENS | Run the verifier while the sidecar is live (the normal demo) | false TRUNCATION if a heartbeat lands mid-run | FIXED: clean |
| RT-31 | D10 | BREAKS | `docker compose up` with the example profile | spool mounted at `/spool`, sidecar reads `/app/spool`: nothing is ever ingested, no error | FIXED: spool at `/app/spool:ro` |
| RT-32 | D10 | BREAKS | `docker compose up` | witness looks for `data/witness_nodes.toml` inside its empty volume and cannot start | FIXED: `--nodes-file` + read-only mount outside the volume |
| RT-33 | D10 | BREAKS | `docker compose up` | sidecar sends heartbeats to `localhost:8800`, which is itself: no heartbeats, SILENCE | FIXED: `--witness-url http://witness:8800` in compose |
| RT-34 | D10 | WEAKENS | Build the images | no `.dockerignore`: keys, DBs and `config.toml` are sent to the builder, one `COPY . .` away from being baked in | FIXED: `.dockerignore` |
| RT-16 | D0 (carried) | WEAKENS | Supply chain / "works on my machine" | `requirements.txt` unpinned | FIXED: exact pins, checked to resolve for Python 3.11 Linux |
| RT-27 | D6 (carried) | NITPICK | Huge request bodies to the witness | no size limit | FIXED: 413 over 16 KiB declared; chunked read stops at 16 KiB (400) |
| RT-35 | D10 | WEAKENS | Admin on the Docker host edits the witness volume | demo compose runs the witness on the same host as the sidecar | ACCEPTED for demo, documented |
| RT-36 | D8 | NITPICK | Read a SILENCE verdict | no time, `seq_from`/`seq_to` meaningless; `node_id` put in the URL unescaped | FIXED |
| RT-37 | D9/D10 | NITPICK | Hygiene | README link is an absolute `file:///c:/Users/...` path; unused imports in `tests/test_tampering.py` | FIXED |
| RT-38 | D10 | WEAKENS | Linux host: containers run as root | host user may not be able to open the root-owned DB to verify | DOCUMENTED, not tested (no Docker here) |

---

## Findings in detail

### RT-28 (D8, BREAKS): a stolen key can overwrite the witness's view
- **Where:** `verifier/checks.py` `verify_witness`: `w_heads = {head_seq: head_hash for x in heartbeats + checkpoints}`. A dict keeps one hash per seq, the last one in the list. Alerts other than SILENCE are ignored.
- **Attack:** the trust model says the attacker is admin on the platform host, so they have `data/node1.key`. Rewrite from seq 2, re-chain, re-sign the local checkpoint. The verifier now reports FORK (the witness has the old head). Then send the witness one forged heartbeat and one forged checkpoint for the same head_seq, signed with the stolen key. The witness raises a FORK alert and stores both (insert-only, correct). The verifier's dict now holds the newest hash, which is the forged one, so the comparison matches. Reproduced: `P1a FORK -> P1c CLEAN`.
- **Why it matters:** this is the D8 gate "rewrite the whole chain and re-sign with the stolen local key -> FORK". The witness noticed, but the verifier threw that evidence away.
- **Plan:** keep every hash the witness has for each seq. If the witness has two different hashes for one seq, that is FORK on its own (the node key signed two histories). Also turn the witness's own stored FORK alerts into FORK verdicts and SEQ_ROLLBACK alerts into TRUNCATION verdicts, since both are records of the node claiming a different history.

### RT-29 (D8, BREAKS): pointing the verifier at an empty node
- **Where:** `verifier/__main__.py` reads `node_id` from `config.toml`; `verifier/checks.py` falls back to `"node-1"` and treats an empty witness history as "nothing to compare".
- **Attack:** `config.toml` is on the attacker's host. Rewrite and re-sign the log, set `node_id = "ghost"`. The witness has no rows for "ghost", so there is nothing to compare and offline checks pass (re-signed with the stolen key). Reproduced: `node-1 -> FORK, ghost -> CLEAN`.
- **Why it matters:** one edited line in a file the attacker owns switches off every witness check.
- **Plan:** fail closed. If the witness has no heartbeats and no checkpoints for the node, the verifier exits 2 ("witness has no records for node_id X"), never clean. Remove the silent `"node-1"` default. Add `--node-id` so an auditor can give the node id themselves instead of trusting the host's config.

### RT-30 (D8, WEAKENS): false TRUNCATION on a live system
- **Where:** `verifier/checks.py` `verify`: the local read snapshot starts at `verify_entries`, the witness is queried afterwards.
- **Attack / failure:** the sidecar appends and sends a heartbeat while the verifier is checking entries. The witness now has a head the snapshot cannot see. Reproduced: `P3 -> TRUNCATION` on an untouched log.
- **Why it matters:** the demo runs the verifier next to a live sidecar. A false alarm in front of judges, and false alarms teach people to ignore real ones.
- **Plan:** query the witness first, then open the local snapshot. The sidecar commits an entry before any heartbeat can report it, so everything the witness saw is already in the snapshot.

### RT-31 (D10, BREAKS): the sidecar container never sees the spool
- **Where:** `defence-compose.yml` mounts the spool at `/spool`; the profile's `spool_path = "spool/events.jsonl"` resolves to `/app/spool/events.jsonl` (working dir `/app`). The ingest loop waits quietly for a missing file.
- **Attack / failure:** `up` works, the sidecar logs "following spool/events.jsonl" and ingests nothing, forever. Nobody notices until the verifier shows 0 entries.
- **Plan:** mount the spool folder at `/app/spool:ro`, so a relative `spool/...` path means the same thing on the host and in the container. Document that in Docker the profile's paths must stay under `spool/` and `data/`.

### RT-32 (D10, BREAKS): the witness container cannot start
- **Where:** `defence-compose.yml` witness volume `witness-data:/app/data`; the profile's `nodes_file = "data/witness_nodes.toml"` points into that new, empty volume.
- **Failure:** `FileNotFoundError` at startup, restart loop.
- **Plan:** bind-mount the host's `data/witness_nodes.toml` read-only to a path outside the witness volume and pass it with a new `--nodes-file` flag on `witness.app`. The witness DB stays alone in its volume. Document the key bootstrap order (create the node key, write `witness_nodes.toml`, then `up`).

### RT-33 (D10, BREAKS): heartbeats go to the wrong place
- **Where:** the shared profile has `witness_url = "http://localhost:8800"`, which inside the sidecar container is the sidecar itself.
- **Failure:** every heartbeat fails, the witness raises SILENCE, the verifier never reports clean.
- **Plan:** add `--witness-url` to `sidecar.main` (overrides the profile) and set it to `http://witness:8800` in the compose file. The profile stays the same file for host and container.

### RT-34 (D10, WEAKENS): no `.dockerignore`
- **Where:** build context is the repo folder, which holds `data/` (keys, DBs), `config.toml`, `spool/`, `.venv`.
- **Why it matters:** the Dockerfiles copy only named folders today, so nothing is baked in yet, but secrets are shipped to the builder and a later `COPY . .` would put the node key in an image. The D10 gate says no keys, DBs or `config.toml` in images.
- **Plan:** add `.dockerignore` excluding `data/`, `spool/`, `config.toml`, `*.key`, `*.db`, `.venv`, caches, `.git`.

### RT-16 (carried from D0, WEAKENS): unpinned requirements
- **Plan:** pin exact versions (the ones the 146 tests pass on).

### RT-27 (carried from D6, NITPICK): no request body limit on the witness
- **Plan:** reject request bodies over 16 KiB with 413 (real heartbeats and checkpoints are under 1 KiB), for both `Content-Length` and chunked bodies.

### RT-35 (D10, WEAKENS, accepted for the demo): witness on the same host
- The trust model puts the witness out of the attacker's reach. One compose file on one host breaks that: a host admin can stop the witness or edit its volume. For the demo this is fine and expected; for real use the witness runs on another machine. Documented in INTEGRATION.md; packaging for a separate witness is part of "After D10" A2.

### RT-36 (D8, NITPICK): SILENCE verdict detail, URL building
- **Plan:** put the witness's receive time in the SILENCE detail; build queries with `params=` so the node id is escaped.

### RT-37 (D9/D10, NITPICK): hygiene
- **Plan:** relative README link; remove unused imports in `tests/test_tampering.py`.

### RT-38 (D10, WEAKENS, documented): root-owned files on Linux
- Containers run as root, so on a Linux host `data/sidecar.db` is root-owned and a normal user cannot open it read-only in WAL mode (needs the `-shm` file). Docker Desktop on Windows/macOS is not affected. Not tested here (no Docker).
- **Plan:** document `user:` / `chmod` in INTEGRATION.md, as DEFENCE_STEPS D10 already hints.

---

## Accepted
- The window between heartbeats: entries appended after the last heartbeat the witness stored can be deleted or rewritten without a witness verdict. Upper bound: `interval_s` + send timeout = 30 s + 2.5 s of events by default (offline checks still catch edits that are not re-chained). Shorter `interval_s` shrinks it.
- SILENCE stays in the report for good once raised. That is the contract ("the witness raised a silence alert in the checked period"); a planned maintenance stop will show up and has to be explained by a human.
- Witness alerts BAD_SIGNATURE and COUNTER_REPLAY are not turned into verdicts: they record attempts against the witness, not a change to the local log, and the contract has no verdict code for them. They are still visible via `GET /alerts`.

## What changed
- `verifier/checks.py`: split into `fetch_witness` (HTTP, `params=` escaping, fails closed on an empty history) and `verify_witness` (comparison). Keeps every witness hash per seq; two hashes at one seq is FORK. Witness FORK alerts become FORK verdicts, SEQ_ROLLBACK alerts become TRUNCATION, SILENCE carries the witness's receive time. `verify` fetches from the witness before opening the local snapshot. No `"node-1"` default: `--witness` without a node id is an error.
- `verifier/__main__.py`: `--node-id` (overrides the config's `node_id`).
- `sidecar/main.py`: `--witness-url` (overrides `[heartbeat] witness_url`).
- `witness/app.py`: `--nodes-file` / `create_app(nodes_file=...)`; `BodyLimit` middleware (16 KiB).
- `defence-compose.yml`: spool at `/app/spool:ro`, sidecar `--witness-url http://witness:8800`, witness gets `data/witness_nodes.toml` read-only at `/etc/coc/` plus `--nodes-file`; header comments on paths and the demo-only co-location.
- `.dockerignore` (new), `requirements.txt` pinned.
- `INTEGRATION.md` section 5: mounts, first-start order (key, nodes file, up, verify), Linux permissions, separate witness, auditors pass `--node-id`. `README.md`: relative link, `--node-id` in the verify line.
- `tests/test_tampering.py`: unused imports removed.
- `tests/test_redteam_d8_d10.py` (new, 11 tests): one or more per finding.

Not changed: Antigravity's `sidecar/store.py` edit (WAL pragma moved to `init_db`, `timeout=10`) is fine: WAL mode is stored in the DB file, so connections opened later still use it, and the busy timeout makes "database is locked" rarer. The Dockerfiles are fine as written (Python 3.11-slim, copy only code folders). Copying `verifier/` into the sidecar image is not needed by the sidecar but lets you run the verifier inside the container; harmless, left in.

## Verification
- Attack scripts re-run against the fixed code: RT-28 (forged heartbeat + checkpoint with the stolen key) now FORK; RT-29 (`node_id = "ghost"`) now exit 2; RT-30 (append + heartbeat mid-run) now clean. Swapped `node1.pub` + full re-sign: FORK with the witness (offline alone still clean, as accepted). Truncate then regrow past the old head: FORK.
- D9 gate check (for Jeev to confirm): sabotaged the verifier in memory (EDIT never fires, witness checks return nothing). The suite went red on 4 of 6 rows (edit, truncate, reorder, fork); restored, all 6 pass.
- End to end in the container layout (no Docker here, so real processes laid out the way the containers see files): sidecar run from a host folder with relative `spool/` and `data/`, witness from its own folder with an empty `data/` and `--nodes-file` outside it, sidecar given `--witness-url`. Node key created with the INTEGRATION.md command. 40 generated events: verifier with `--witness --node-id node-1` exit 0 clean, 40 entries; `--node-id ghost` exit 2; witness DB only in the witness folder. Stopped the sidecar and deleted seq >= 35: exit 1, TRUNCATION + CHECKPOINT_MISMATCH. After 25 s (window 21 s): SILENCE added.
- Pinned requirements: `pip download --python-version 3.11 --platform manylinux` resolves every package with 3.11 wheels.
- pytest: 157 passed (146 before + 11 new). Ran 10 times: 9 clean, 1 run had a single failure I could not capture (it did not repeat). Likely one of the timing-based heartbeat-thread tests on a slow run; worth watching.
- Not verified: building the images and `docker compose up` (Docker is not installed here). Do this once on a machine with Docker before the demo, and on Linux check RT-38.

## Gate status (for Jeev to tick)
My view, you tick:
- D8 "Delete the last N entries -> TRUNCATION": passes (tests + e2e).
- D8 "Rewrite the whole chain and re-sign with the stolen local key -> FORK": passes after RT-28, including the variant where the attacker also feeds the forged head to the witness.
- D8 "Sidecar stopped past the silence window -> SILENCE": passes (e2e: 25 s stop with a 21 s window).
- D8 "Window between heartbeats": write down **interval_s + 2.5 s** (32.5 s at the default 30 s) of newest events can be removed or rewritten with no witness verdict.
- D9 "Break the verifier on purpose once: the suite goes red": passes (see Verification); you may want to do it yourself once.
- D10 "Spool mounted read-only": passes (`/app/spool:ro`).
- D10 "No keys, DBs or config.toml baked into images": passes by reading (Dockerfiles copy only code folders, `.dockerignore`), not by building.
- D10 "Witness data on its own volume, not reachable from the sidecar container": passes by reading (`witness-data` only mounted in the witness). Note RT-35: on one demo host, the host admin can still reach it.
- D10 "Done when" (`docker compose up` + verifier clean): not run, no Docker here.
