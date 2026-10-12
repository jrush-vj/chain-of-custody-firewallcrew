# Red team / blue team report: D5 to D7

Date: 2026-10-10. Reviewer: Claude (red team, then blue team).
Scope: what Antigravity built for D5 (verifier v1), D6 (witness) and D7 (heartbeat client + checkpoint upload): `verifier/`, `witness/`, `sidecar/heartbeat.py`, the `sidecar/main.py` changes and their tests. D0 to D4 fixes from RED_TEAM_D0_D4.md were re-checked and still hold.
Method: same as D0-D4. Read every file, ran each attack as a script against the real code (temp folders, TestClient for the witness), then fixed, added a regression test per finding and re-ran the attack.

Starting point: 124 tests passed. The witness in particular is solid work: strict input checks, insert-only tables enforced by SQLite triggers, its own clock, a lock around a single connection, alert throttling, and a SILENCE sweep with a startup grace period.

Rank key: **BREAKS** = the attack succeeds and defeats a guarantee. **WEAKENS** = makes an attack easier, or a failure silent or noisy. **NITPICK** = hygiene.

## Summary

| ID | Step | Rank | Attack | Before | After |
|----|------|------|--------|--------|-------|
| RT-17 | D5 | BREAKS | Insert a forged entry with seq -1 and a correct hash | verifier says clean | FIXED: `SEQ_GAP` at seq -1 |
| RT-18 | D5 | WEAKENS | Put invalid JSON in one entry's `details` | verifier crashes (exit 2), every other verdict is lost | FIXED: `EDIT` at that seq, other verdicts kept, exit 1 |
| RT-19 | D5 | BREAKS | Re-chain the whole log, then delete `node1.pub` | checkpoint checks silently skipped, clean | FIXED: exit 2 "cannot verify checkpoints", never clean |
| RT-20 | D5 | WEAKENS | Delete the last entries below a signed local checkpoint | clean, though a signed checkpoint proves entries are missing | FIXED: `CHECKPOINT_MISMATCH` "covers 15 entries but only 10 are present" |
| RT-21 | D5 | WEAKENS | Run with `--witness URL` | flag silently ignored, exit 0 "clean" | FIXED: exit 2 "not implemented yet (D8)" |
| RT-22 | D5 | NITPICK | Verify while the sidecar is writing | entries and checkpoints read in separate snapshots | FIXED: one read transaction |
| RT-23 | D6 | WEAKENS | 500 junk heartbeats with random node_ids | 500 alert rows stored (unbounded, unauthenticated) | FIXED: 1 row (one throttled `(unknown)` bucket) |
| RT-24 | D7 | WEAKENS | Witness stores a heartbeat but the reply is lost (timeout), or the sidecar dies right after sending | next pulse raises a false COUNTER_REPLAY | FIXED: no alert; counter never reused |
| RT-25 | D7 | WEAKENS | One DB error ("database is locked") in the heartbeat thread | thread dies for good; sidecar keeps running with no heartbeats and no log line | FIXED: error logged once, thread keeps pulsing |
| RT-26 | D7 | WEAKENS | Witness rejects the sidecar's checkpoints | upload fails forever, logged only at DEBUG | FIXED: WARNING with HTTP status and reply |
| RT-27 | D6 | NITPICK | Huge request body | no size limit | NOT CHANGED: deferred to D10 |

---

## Findings in detail

### RT-17 (D5, BREAKS): a forged entry with seq -1 is invisible
- **Where:** `verifier/checks.py:24-34` (SEQ_GAP only checks `current_seq > expected_seq`), `verifier/checks.py:63-79` (the chain check only runs for `seq > 0` with a previous row), `verifier/checks.py:127-129` (a length mismatch skips the checkpoint check silently).
- **Attack:** with write access to the DB (no key needed), insert a row `seq = -1` with any content and a correctly computed hash. SQLite accepts it, since seq is just an integer key. Ordered by seq it comes first. It is lower than expected, so no SEQ_GAP. Its own hash is right, so no EDIT. Entry 0 is still checked against genesis, so no CHAIN_BREAK. The checkpoint check then finds `tree_size + 1` hashes for `seq < tree_size`, and silently skips. Reproduced: `clean=True`.
- **Why it matters:** "Insert a forged entry" is a D5 gate. Anyone reading the log with `SELECT * ORDER BY seq` sees the forged event first, and the verifier vouches for it.
- **Plan:** any seq that is not exactly the next expected value is a `SEQ_GAP` verdict, including seq below 0 or out of order. Checkpoints only count `seq >= 0`. A checkpoint whose entries are not all present becomes a verdict, not a silent skip (see RT-20).

### RT-18 (D5, WEAKENS): one corrupt row makes the verifier give up
- **Where:** `verifier/checks.py:42` (`json.loads(row["details"])` with no error handling).
- **Attack:** `UPDATE entries SET details='{not json' WHERE seq=3`. The verifier throws, `__main__` prints "verification failed" and exits 2. Reproduced: exit 2.
- **Why it matters:** exit 2 means "the verifier itself failed", not "tampering found". An attacker can turn every tamper report into a tool error, and all other verdicts (for example a real EDIT elsewhere) are lost with it.
- **Plan:** a row whose fields cannot be read or re-hashed is an `EDIT` verdict for that seq, and the walk continues.

### RT-19 (D5, BREAKS): deleting the public key turns off checkpoint checks
- **Where:** `verifier/checks.py:152` (`if public_key_path and public_key_path.exists()`).
- **Attack:** rewrite every entry and re-chain (no key needed). With the `.pub` file present, the verifier correctly reports `CHECKPOINT_MISMATCH`. Then delete `data/node1.pub`: the verifier skips all checkpoint checks and reports **clean**. Reproduced.
- **Why it matters:** checkpoints are the only offline defence against a full re-chain. The attacker can switch them off by deleting one file they control.
- **Plan:** fail closed. If the configured public key file is missing, the verifier cannot do its job: exit 2 with a clear error, never a "clean".

### RT-20 (D5, WEAKENS): tail truncation below a signed checkpoint is ignored
- **Where:** `verifier/checks.py:126` (`if total_entries >= tree_size:`, else nothing).
- **Attack:** a checkpoint signed for 15 entries exists. Delete entries 10 to 14. The verifier sees 10 clean entries and skips the checkpoint. Reproduced: `clean=True`.
- **Why it matters:** DEFENCE_STEPS says truncation is invisible offline in general (that is D8's job). But here a validly signed local checkpoint proves the log once had 15 entries, so the evidence is already on disk. The attacker has to remember to delete checkpoints too. Make them.
- **Plan:** if the entries a validly signed checkpoint covers are not all present, report `CHECKPOINT_MISMATCH` with that range ("checkpoint covers 15 entries, 10 present").

### RT-21 (D5, WEAKENS): `--witness` is silently ignored
- **Where:** `verifier/__main__.py:15` (parsed, never used).
- **Why it matters:** someone runs `python -m verifier --witness http://...` expecting TRUNCATION/FORK/SILENCE checks and gets exit 0 "clean" from offline checks only. That is false assurance. Reproduced: exit 0, witness never contacted.
- **Plan:** until D8 implements it, `--witness` exits 2 with "witness checks are not implemented yet (D8)". D8 replaces this.

### RT-22 (D5, NITPICK): no consistent snapshot
- **Where:** `verifier/checks.py:148-155`. Entries and checkpoints are separate reads.
- **Why it matters:** with the sidecar running, a checkpoint created between the two reads covers entries the first read did not see. Harmless today (RT-20 made it skip). After the RT-20 fix it could become a false `CHECKPOINT_MISMATCH`.
- **Plan:** run all verifier reads inside one read transaction (`BEGIN` ... `COMMIT`) so they see one snapshot.

### RT-23 (D6, WEAKENS): unauthenticated alert flood
- **Where:** `witness/app.py:40-44` and `:91`. Alerts are throttled per (node_id, code, detail), but the node_id comes from the attacker.
- **Attack:** anyone who can reach the witness posts well-formed heartbeats with random node_ids and a junk signature. Each one is a new node_id, so the throttle never fires. Reproduced: 500 requests, 500 alert rows.
- **Why it matters:** an unauthenticated client can grow the witness DB without limit (disk fill), and `GET /alerts` for those ids returns noise. The witness is the one component the attacker must not be able to break.
- **Plan:** alerts for a node_id not in `nodes_file` are stored under a single bucket `(unknown)`, which can never be a real node id because the id regex forbids parentheses, with a fixed detail. The throttle then caps them at one per 10 s. The claimed id still goes to the witness log, and the caller still gets its BAD_SIGNATURE response.

### RT-24 (D7, WEAKENS): lost reply or crash after send gives a false COUNTER_REPLAY
- **Where:** `sidecar/heartbeat.py:120-125`. On an unacknowledged send, the next pulse reuses the same counter (the DEFENCE_STEPS hiccup advice).
- **Attack / failure:** the witness stores heartbeat #1, but the reply is lost (timeout, network drop, or the sidecar is killed right after sending). The sidecar thinks #1 failed and sends a new heartbeat (new head, new signature) with counter 1 again. The witness correctly sees a counter that is not greater than the last one and raises COUNTER_REPLAY. Reproduced with a transport that delivers the request and drops the reply: `alerts=['COUNTER_REPLAY']`.
- **Why it matters:** false alarms train people to ignore COUNTER_REPLAY, which is the alert that catches replayed or cloned heartbeats. An attacker who can slow the network can produce them at will.
- **Plan:** every attempt uses a new counter: persist N+1, then send. A failed send leaves a gap, which the witness accepts (it only alerts on "not greater than"). Remove the ack flag. **Contract note:** CONTRACT section 5 says `hb_counter` "increases by 1 per heartbeat". With this fix it increases by 1 per *attempt*, so the witness may see gaps. The witness rules are unchanged. If you want the wording to say "strictly increases (gaps allowed after failed sends)", that is a contract change for the change protocol.

### RT-25 (D7, WEAKENS): heartbeat thread dies on one DB error
- **Where:** `sidecar/heartbeat.py:120-125` run outside the `try`. `run_heartbeat_loop` has no guard.
- **Attack:** hold a lock on the sidecar DB for more than SQLite's busy timeout (or any error in `get_last_entry`). `set_persisted_counter` raises, the thread dies, and ingest keeps going with no heartbeats. The witness raises SILENCE after about 75 s, but the sidecar itself never says why, and heartbeats never come back without a restart. Reproduced: thread dead after one error.
- **Why it matters:** the D7 gate is "kill the heartbeat thread: does anyone notice?" The witness does notice. But one transient error should not be enough to kill heartbeats permanently.
- **Plan:** guard each pulse in the loop: log the error once per failure streak and carry on.

### RT-26 (D7, WEAKENS): rejected checkpoint uploads are silent
- **Where:** `sidecar/heartbeat.py:102-106` (break, no log), `:136-137` (exceptions at DEBUG).
- **Attack / failure:** the witness rejects the checkpoints (wrong key in `nodes_file`, or checkpoints signed by a different key). Uploads stall forever and nothing reaches the sidecar log. Reproduced: uploaded tree size 0, zero warnings.
- **Why it matters:** D8's FORK check depends on the witness holding checkpoints. A sidecar that silently uploads none gives the attacker a much bigger window.
- **Plan:** log a WARNING with the witness's status and reply when a checkpoint is not stored, and when the upload throws.

### RT-27 (D6, NITPICK): no request body limit
- **Where:** `witness/app.py` (FastAPI and uvicorn defaults).
- **Plan:** not changed here. Put a body-size limit in front of the witness (reverse proxy or uvicorn `--limit-concurrency`) at D10. Recorded so it is not forgotten.

---

## Accepted, not fixed (by design or later steps)
- **Attacker swaps `node1.pub` for their own key and re-signs every checkpoint:** the offline verifier trusts the key file on the attacker's host, so it cannot tell. The witness pins the real key in its own `nodes_file`, so D8 (compare with the witness's checkpoints and heads) is the answer. Recommended for D8: verify local checkpoints against the witness's copy, or pass the trusted key to the verifier.
- **Attacker deletes every local checkpoint and re-chains:** offline clean by construction. D8 compares with the witness.
- **Window between heartbeats (D8 gate, now sized):** each heartbeat pins the head hash, and through `prev_hash` every entry before it. Entries ingested after the last acknowledged heartbeat are not pinned at the witness. The window is about `interval_s` (30 s) plus the send timeout (2.5 s), or longer while the witness is unreachable (SILENCE fires at `2 * interval_s + 15` = 75 s).
- **Attacker with the node key sends heartbeats with a huge counter or head_seq:** the real sidecar then trips COUNTER_REPLAY or SEQ_ROLLBACK on every pulse. That is loud, so it counts as detection, not evasion.
- **Heartbeat thread writes `ingest_state` from its own connection:** it only touches its own keys (`hb_counter`, upload position), and SQLite's busy timeout serialises it with ingest. RT-25 makes a lock timeout survivable.

---

## What changed (blue team)
| File | Change | Fixes |
|------|--------|-------|
| `verifier/checks.py` | rewritten around the same functions. Any out-of-place seq is `SEQ_GAP`. An unreadable row is `EDIT` (no crash). Checkpoints only count `seq >= 0`; missing covered entries and unreadable hashes are `CHECKPOINT_MISMATCH`. A missing key file fails closed. All reads happen in one snapshot | RT-17 to RT-20, RT-22 |
| `verifier/__main__.py` | `--witness` exits 2 until D8 | RT-21 |
| `witness/app.py`, `witness/checks.py` | alerts for untrusted node_ids go to one throttled `(unknown)` bucket; the claimed id is logged | RT-23 |
| `sidecar/heartbeat.py` | new counter on every attempt (ack flag removed); each pulse guarded in the loop; rejected or failed checkpoint uploads logged at WARNING | RT-24 to RT-26 |
| `tests/test_heartbeat.py` | removed the ack-flag asserts; the witness-down test now expects counters 2, 3 to fail and 4 to be accepted with no alert | RT-24 |
| `tests/test_redteam_d5_d7.py` | one regression test per finding (12 tests) | all |

No new modules. No contract change, but see the RT-24 wording note.

## Verification: did the fixes work?
1. **Test suite:** `pytest` gives **136 passed** (124 before + 12 new). Every existing D5 to D7 test still passes, except the one RT-24 deliberately changed.
2. **Original attack scripts, unchanged, against the fixed code:**
   - RT-17 forged seq -1: `clean=False`, `SEQ_GAP`.
   - RT-18 bad details: exit 1 (tampering found), not 2.
   - RT-19 pub deleted: `FileNotFoundError`, exit 2.
   - RT-20 truncation below checkpoint: `clean=False`.
   - RT-21 `--witness`: exit 2.
   - RT-23 flood: 1 alert row from 500 requests.
   - RT-24 lost reply: no alerts.
   - RT-25 thread alive after the DB error.
   - RT-26 one warning logged.
3. **End-to-end with real processes** (witness on uvicorn, `python -m sidecar.main`, generator, verifier; interval_s 2, every_n 50):
   - Live run: 120 entries, heartbeats arriving with head_seq 119, witness holds checkpoints 50, 102 and 120, no alerts. Verifier: exit 0, clean.
   - Sidecar **hard-killed and restarted**: counters 6, 7, 8, 9 continue, **no COUNTER_REPLAY** (D7 "Done when").
   - **Witness killed**: the sidecar stays alive and keeps ingesting (150 entries). Witness restarted: pulses resume at counters 11, 12, 13 (a gap where a send failed), **no alerts** (D7 "Done when").
   - **Tail truncated** to 140 entries and the sidecar restarted: the witness raises **SEQ_ROLLBACK**. The offline verifier reports **CHECKPOINT_MISMATCH** ("signed checkpoint covers 150 entries...", RT-20) with exit 1.
   - **Sidecar stopped 26 s** (window 2 x 2 + 15 = 19 s): the witness raises **SILENCE**.

## Red-team gate status (my view; Jeev ticks in HANDOFF.md)
- **D5:**
  - Edit -> EDIT: **pass**.
  - Delete middle -> SEQ_GAP: **pass**.
  - Reorder -> sensible code at the right seq: **pass** (Antigravity's test plus the chain check).
  - Insert forged -> detected: **pass** after RT-17.
  - One tamper, one clear first verdict: **pass** (EDIT suppresses the follow-on CHAIN_BREAK).
  - Re-chain after K -> CHECKPOINT_MISMATCH: **pass**, provided the key file is present; RT-19 now refuses to run otherwise.
  - Crash or bad DB -> exit 2, never false clean: **pass**.
- **D6:**
  - BAD_SIGNATURE, COUNTER_REPLAY, SEQ_ROLLBACK and FORK: **pass** (Antigravity's tests; SEQ_ROLLBACK also seen end-to-end).
  - Forged vs missed heartbeat handled differently: **pass**.
  - Insert-only: **pass** (SQLite triggers, tested).
  - Alert flooding: **pass** after RT-23.
  - Own clock: **pass**.
- **D7:**
  - Tail truncation -> SEQ_ROLLBACK: **pass** (end-to-end).
  - Kill sidecar -> SILENCE: **pass** (end-to-end). Kill only the heartbeat thread: the witness still raises SILENCE, and after RT-25 a transient error no longer kills it.
  - Restart without COUNTER_REPLAY: **pass**.
  - Witness down: ingest continues, no crash, one warning per failure streak: **pass**.
  - Shared connection: **pass**. The heartbeat thread uses its own connection, touches only its own state keys, and the busy timeout serialises writes.
- **Carry to D8:**
  - Window = about 30 s plus the 2.5 s timeout.
  - Use the witness's pinned key or checkpoints to beat the swapped-`.pub` attack.
  - Replace the RT-21 stub.
