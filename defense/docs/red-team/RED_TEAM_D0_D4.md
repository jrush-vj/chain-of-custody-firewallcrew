# Red team / blue team report: D0 to D4

Date: 2026-10-10. Reviewer: Claude (red team, then blue team on Jeev's green light).
Scope: everything Antigravity built for D0 to D4 (sidecar/, tools/, tests/), reviewed before D5 starts.
Method: read every file, then ran each suspected attack as a script against the real code in a temp folder (not a guess: every BREAKS/WEAKENS below was reproduced). Then fixed, added a regression test per finding, and re-ran the attack.

Rank key: **BREAKS** = the attack succeeds and defeats a guarantee. **WEAKENS** = makes an attack easier or a failure silent. **NITPICK** = hygiene.

## Summary

| ID | Step | Rank | Attack | Before | After |
|----|------|------|--------|--------|-------|
| RT-01 | D0 | BREAKS | Run on Python 3.11 (stated minimum) | crashes at startup | FIXED: `isolation_level=None`; simulated-3.11 test passes |
| RT-02 | D1/D3 | BREAKS | Lone surrogate `"\ud800"` in a field | passes validator, event silently dropped at ingest | FIXED: rejected by validator, ingest continues |
| RT-03 | D1/D3 | BREAKS | Deeply nested JSON in one spool line | validator crashes; sidecar retries the same line forever, logging stops | FIXED: reported as bad JSON, ingest continues |
| RT-04 | D1 | WEAKENS | Duplicate JSON key (`"actor":"asha","actor":"mallory"`) | accepted, last value wins | FIXED: `duplicate key` error at any depth |
| RT-05 | D3 | BREAKS | Crash between storing an entry and saving the offset | event stored twice after restart | FIXED: one transaction, crash leaves nothing; restart stores it once |
| RT-06 | D3 | BREAKS | Storing an entry fails (disk full, DB locked) | offset advanced anyway, event lost | FIXED: offset unchanged, line retried, stored once |
| RT-07 | D3 | BREAKS | Replace the spool with a different, longer file | sidecar ingests the new file from the old offset, no alarm | FIXED: sidecar stops with exit 1, nothing ingested |
| RT-08 | D3 | WEAKENS | Start a second sidecar on the same DB | both ingest the same lines, duplicates | FIXED: second writer gets `IngestStopError`, no duplicates |
| RT-09 | D3 | NITPICK | Control characters in a bad line; error matched by string | raw line logged as-is; stop logic depends on the word "shrunk" | FIXED: `%r` logging, `IngestStopError` type |
| RT-10 | D4 | BREAKS | Run the sidecar and wait for checkpoints | none are ever created (not wired into main.py) | FIXED: running sidecar signs checkpoints (end-to-end run) |
| RT-11 | D4 | WEAKENS | Delete a middle row, then let a checkpoint run | signs a tree_size/head_seq that do not match the entries | FIXED: refuses to sign, raises |
| RT-12 | D4 | WEAKENS | Delete the `.pub` or the `.key` file | private key silently replaced, node identity rotated | FIXED: key never overwritten, pub derived, refuses on missing key |
| RT-13 | D4 | WEAKENS | Signature or key that is not a hex string (null, number) | verify_payload raises TypeError instead of returning False | FIXED: returns False |
| RT-14 | D4 | NITPICK | Uppercase or space-padded entry hash | Merkle accepts it, same root as the real hash | FIXED: ValueError on non-canonical hash |
| RT-15 | D4 | NITPICK | Merkle tree shape for sizes 6 to 8 | test only checks roots differ, not that they are right | FIXED: hand-built tree test for 3, 5, 6, 7, 8 leaves |
| RT-16 | D0 | NITPICK | Rebuild the venv next month | requirements.txt unpinned | NOT CHANGED (see below) |

---

## Findings in detail

### RT-01 (D0, BREAKS): code does not run on Python 3.11
- **Where:** `sidecar/store.py:42`, `sqlite3.connect(..., autocommit=True, ...)`.
- **Why the red team got in:** the `autocommit` argument was added in Python 3.12. AGENTS.md says 3.11+, and D10 will build a Docker image. On 3.11 every sidecar start fails with `TypeError: 'autocommit' is an invalid keyword argument`. The tests pass only because the venv is 3.14.
- **Plan:** use `isolation_level=None`, which works from 3.6 onward and gives the same behaviour: no implicit transactions, our explicit `BEGIN IMMEDIATE` controls them. Add a test that simulates a 3.11 `sqlite3.connect` signature.

### RT-02 (D1/D3, BREAKS): a lone surrogate passes the validator, then the event vanishes
- **Where:** `tools/validate_spool.py:80` (parse), `sidecar/store.py:118` (canonical encode), `sidecar/ingest.py:71-74`.
- **Attack:** a line with `"actor":"\ud800"` (a JSON escape for half of a UTF-16 pair). It is valid JSON text, so `json.loads` accepts it, and the validator reports no errors. Then the canonical JSON step (`.encode("utf-8")`) raises `UnicodeEncodeError`, the ingest loop logs a warning, advances the offset and drops the event.
- **Why it matters:** the validator is the acceptance test for every platform. It said "OK" to an event the defence cannot hash. Worse, once RT-06 is fixed (no more silent drops), this line would block ingest forever. Reproduced: validator errors `[]`, entries after ingest `0`.
- **Plan:** the validator runs the exact canonical encoding used for hashing on every event and rejects anything that does not encode. If the validator says OK, the sidecar can hash it.

### RT-03 (D1/D3, BREAKS): one deeply nested line stops all logging
- **Where:** `tools/validate_spool.py:80` and `find_floats` (recursive), `sidecar/ingest.py:61`, `sidecar/ingest.py:88-91`.
- **Attack:** one spool line whose `details` holds 100,000 nested `[`. `json.loads` raises `RecursionError`, which is not a `ValueError`, so the validator crashes instead of reporting an error. In the sidecar, the exception escapes `ingest_batch`, `follow_spool` logs it and retries the same offset every 0.2 s, forever. Nothing after that line is ever logged.
- **Why it matters:** this is a logging kill switch. Anyone who can put one line into the spool (a compromised adapter, or any user-controlled string the platform copies into `details` as raw JSON) silences the audit trail for everything that follows. Reproduced: `RecursionError`.
- **Plan:** treat `RecursionError` as "bad JSON: nested too deeply" in the validator. As a backstop, ingest treats any unexpected validator exception as an invalid line (logged and skipped), so no single line can halt ingest.

### RT-04 (D1, WEAKENS): duplicate keys are silently merged
- **Where:** `tools/validate_spool.py:80`.
- **Attack:** `{"source":"app",...,"actor":"asha","actor":"mallory",...}`. Python keeps the last value. Another JSON reader (the platform team's tooling, a SIEM, a human reading the spool) may keep the first. The spool then says one thing and the chain says another.
- **Why it matters:** the original d0 gate: "malformed or extra field, silent accept = fail". Reproduced: validator errors `[]`.
- **Plan:** parse with an `object_pairs_hook` that rejects duplicate keys at any depth. One parse function (`parse_line`) is used by both the validator and ingest, so there is a single parser.

### RT-05 (D3, BREAKS): crash between append and offset save duplicates an event
- **Where:** `sidecar/ingest.py:69-74`. `append_entry` commits its own transaction, then `set_state` saves the offset as a separate write.
- **Attack:** kill the sidecar (or power loss) between the two writes. On restart the offset still points before the line, so it is appended again with a new seq.
- **Why it matters:** the D3 "Done when" is "no duplicates, no missed lines after restart". A duplicate also looks like a real second event (for example two money transfers). Reproduced: 1 line, 2 entries.
- **Plan:** store the entry and the new offset in one `BEGIN IMMEDIATE` transaction. Either both land or neither does.

### RT-06 (D3, BREAKS): a failed append loses the event
- **Where:** `sidecar/ingest.py:71-74`. `except Exception: logger.warning(...)`, then `set_state` advances the offset regardless.
- **Attack:** make the DB write fail (fill the disk, hold a lock on the DB file). Every event during that time is skipped forever with only a warning.
- **Why it matters:** an attacker who can briefly lock the DB gets an unlogged window. Reproduced: entries after a failed append and a retry, `0`.
- **Plan:** never advance the offset past a line that was not stored. A failed write rolls back, `ingest_batch` raises, `follow_spool` logs it and retries the same line on the next poll.

### RT-07 (D3, BREAKS): a replaced spool is ingested from the wrong place
- **Where:** `sidecar/ingest.py:28-31`. Only `size < offset` is checked.
- **Attack:** replace the spool with different content that is at least as long as the saved offset. The sidecar seeks to the old offset inside the new file and ingests whatever is there. Reproduced: actors after replacement `['a', 'a', 'mallory']`, no error.
- **Why it matters:** DEFENCE_STEPS D3 asks for a loud stop when the spool is replaced. A same-or-larger replacement is the easy way around a size check (log rotation also does this by accident).
- **Plan:** save the length and SHA-256 of the last consumed line next to the offset. On every poll, re-read that line and compare. A mismatch (or a shrink) raises `IngestStopError` and the sidecar stops loudly.

### RT-08 (D3, WEAKENS): two sidecars on one DB duplicate events
- **Where:** `sidecar/ingest.py:25`. The offset is read outside any transaction.
- **Attack:** start a second `sidecar.main` with the same profile (by mistake or on purpose). Both read offset X, both append the same lines.
- **Why it matters:** CLAUDE.md requires a single writer. `BEGIN IMMEDIATE` stops a broken chain, but not duplicates.
- **Plan:** inside the same transaction, check the stored offset is still the one this batch started from (compare-and-set). If another writer moved it, raise `IngestStopError`.

### RT-09 (D3, NITPICK): log injection and a stop rule based on a string
- **Where:** `sidecar/ingest.py:63` (`%s` of the raw line), `sidecar/ingest.py:92` (`"shrunk" in str(exc)`).
- **Why it matters:** a bad line can carry `\r` or terminal escape codes into the sidecar log, and renaming an error message would silently stop the sidecar from halting.
- **Plan:** log bad lines with `%r`, cut to 200 characters. Use a dedicated `IngestStopError` exception type.

### RT-10 (D4, BREAKS): checkpoints are never created at runtime
- **Where:** `sidecar/main.py`. It never loads keys or calls `create_checkpoint`.
- **Why it matters:** D4's build says "create a signed checkpoint every `every_n` entries or `every_s` seconds". The functions exist and are unit-tested, so tasks.md shows D4 ticked, but a running sidecar produces zero checkpoints. D5's `CHECKPOINT_MISMATCH` and D7's checkpoint upload would have nothing to work with.
- **Plan:** main.py loads (or creates) the key pair and passes a checkpoint tick to `follow_spool`, which runs after each ingest poll in the same thread (single writer). Logic lives in `checkpoint.make_checkpoint_tick` so it is testable.

### RT-11 (D4, WEAKENS): checkpoint signs a tree that does not match the table
- **Where:** `sidecar/checkpoint.py:21-35`. `tree_size = COUNT(*)`, then hashes of `seq < tree_size`.
- **Attack:** delete seq 2 of 5. COUNT is 4, so the checkpoint says tree_size 4, head_seq 3, while seq 4 exists and the root covers only 3 hashes. Reproduced: signed `(4, 3)` with max seq 4.
- **Why it matters:** the sidecar should never put its signature on a state it can see is inconsistent. That signature is evidence later.
- **Plan:** `tree_size = MAX(seq) + 1`. If the number of rows is not exactly `tree_size`, refuse to sign and raise.

### RT-12 (D4, WEAKENS): deleting a key file rotates the node identity
- **Where:** `sidecar/keys.py:50-60`.
- **Attack 1:** delete `node1.pub`. The next start generates a new pair and overwrites `node1.key`. The old private key is gone.
- **Attack 2:** delete `node1.key`. A new identity is created silently.
- **Also:** the public key is read from its file, not derived from the private key, so a swapped `.pub` is believed.
- **Why it matters:** the witness trusts one public key per node. Silent rotation either breaks every later heartbeat or, if someone then updates the witness, lets an attacker who deleted the key start a clean new history. Reproduced both.
- **Plan:** never overwrite an existing private key (create it with `O_EXCL`, mode 0600). Derive the public key from the private key. If `.pub` is missing, rewrite it from the private key. If it mismatches, raise. If `.key` is missing but `.pub` exists, refuse to start.

### RT-13 (D4, WEAKENS): verify_payload crashes on non-string input
- **Where:** `sidecar/keys.py:86`. Only `InvalidSignature` and `ValueError` are caught.
- **Attack:** a checkpoint row or heartbeat with `"signature": null` or a number. `bytes.fromhex(None)` raises `TypeError`. Reproduced.
- **Why it matters:** in D5 (verifier) and D6 (witness) this function reads attacker-controlled data. A crash gives exit 2 or a 500 instead of a `BAD_CHECKPOINT_SIGNATURE` / `BAD_SIGNATURE` verdict.
- **Plan:** also catch `TypeError` and return False.

### RT-14 (D4, NITPICK): Merkle accepts non-canonical hex
- **Where:** `sidecar/merkle.py:7`. `bytes.fromhex` accepts uppercase and spaces.
- **Why it matters:** a checkpoint should only be signed over hashes exactly as the contract writes them (64 lowercase hex). The verifier's EDIT check would catch an uppercase hash, but the sidecar should not sign one.
- **Plan:** require `^[0-9a-f]{64}$` in the leaf function, raise ValueError otherwise.

### RT-15 (D4, NITPICK): the Merkle size 1 to 8 test does not check the shape
- **Where:** `tests/test_merkle_and_keys.py::test_merkle_tree_sizes_1_to_8`.
- **Why it matters:** DEFENCE_STEPS D4 warns that the usual bug shows up at 3 or 5 leaves. The test only checks the 8 roots are different. A wrong split rule would still pass for sizes 6 to 8.
- **Plan:** add a test that builds the trees for 3, 5, 6, 7 and 8 leaves by hand from the contract rule and compares.

### RT-16 (D0, NITPICK): unpinned requirements
- **Where:** `requirements.txt`.
- **Plan:** not changed in this pass. Pinning to the venv's versions (built on 3.14) could pick versions that dropped 3.11. Recommend pinning once the Docker image (D10) proves which versions work on 3.11.

---

## Accepted, not fixed (by design or later steps)
- **Platform spoofs `actor` / `ts`:** the defence proves logs were not changed after ingest. It cannot prove the platform told the truth. Recorded in the HANDOFF trust model.
- **Admin appends forged lines to the spool:** same reason. The spool is platform-writable.
- **Admin rewrites and re-chains the entries since the last checkpoint:** no key is needed for entries not yet covered by a checkpoint, and the next checkpoint will then sign the forged version. Only D7 heartbeats to the witness narrow this window. Size the window in D8.
- **Admin reads `data/node1.key` and re-signs everything:** local checkpoints alone are not proof against the host admin. The witness copy (D6 to D8) is the defence.
- **No line size or nesting limit in the contract:** a huge line is held in memory. A real limit needs a CONTRACT change (change protocol).
- **One SQLite connection shared across threads (`check_same_thread=False`):** fine today (one thread). Re-check in D7 when the heartbeat thread arrives.
- **Persistent DB errors log once per poll (0.2 s):** noisy, but loud is safer than silent. Revisit with D7's "log once per failure streak".
- **Spool edits that leave the last consumed line unchanged (found while verifying RT-07):** not detected. The check guards the offset (no misaligned ingest), not the spool's history. Lines already ingested are protected by the chain, not by the spool, so this is by design. The spool is not evidence.
- **A spool line that keeps failing to store (not a bad line, a DB error):** ingest retries it forever and stops there. Correct for transient errors (disk full). With RT-02/RT-03 fixed, no known valid line causes it.

---

## What changed (blue team)
| File | Change | Fixes |
|------|--------|-------|
| `tools/validate_spool.py` | `parse_line()` is the single parser for the validator and ingest. It rejects duplicate keys, catches `RecursionError`, and runs the canonical encoding on every event | RT-02, RT-03, RT-04 |
| `sidecar/store.py` | `isolation_level=None`; `write_transaction()` context manager; `insert_entry()` (no commit) used by `append_entry()` and ingest | RT-01, RT-05 |
| `sidecar/ingest.py` | entry + offset + last-line fingerprint in one transaction with an offset compare-and-set; never advances past an unstored line; `IngestStopError`; `%r` logging; `on_tick` hook | RT-05 to RT-09, RT-10 |
| `sidecar/checkpoint.py` | `tree_size = MAX(seq)+1`, refuse to sign if rows do not match; `make_checkpoint_tick()` | RT-10, RT-11 |
| `sidecar/keys.py` | `public_key_hex()` derives the public key; `O_EXCL` + 0600 private key write; refuse on missing key or mismatched pub; `TypeError` caught in verify | RT-12, RT-13 |
| `sidecar/merkle.py` | entry hash must be 64 lowercase hex | RT-14 |
| `sidecar/main.py` | loads keys, runs the checkpoint tick in the ingest thread, exits 1 on `IngestStopError` | RT-10 |
| `tests/test_redteam_d0_d4.py` | one regression test per finding (26 tests) | all |

No contract change. No new modules. All modules are under 200 lines. The existing D0 to D4 tests pass unchanged.

## Verification: did the fixes work?
1. **Test suite:** `pytest` gives **77 passed** (51 original + 26 new).
2. **Original attack scripts re-run against the fixed code:**
   - RT-02 surrogate: validator now reports `not encodable as UTF-8`.
   - RT-03 deep nesting: `bad JSON: nested too deeply`, no crash.
   - RT-04 duplicate key: `bad JSON: duplicate key 'actor'`.
   - RT-05 crash mid-commit: 1 entry after restart (was 2).
   - RT-06 failed append: 1 entry after retry (was 0).
   - RT-07 replaced spool: `IngestStopError` (was silent ingest of forged lines).
   - RT-11 gapped table: `Refusing to sign` (was a signed bad checkpoint).
   - RT-12 deleted `.pub`: same private key kept. Deleted `.key`: refuses to start (was silent rotation).
   - RT-13 `None` signature: `False` (was TypeError).
   - RT-14 uppercase hash: ValueError (was the same root).
3. **End-to-end with the real `python -m sidecar.main` and generator** (temp profile, every_n 50, every_s 2):
   - Run 1: 120 spool lines, 120 entries, seq 0..119, checkpoints at 36, 96, 120. Then a **hard kill** (no clean shutdown).
   - 80 more events written while the sidecar was down.
   - Run 2: 200 spool lines, 200 entries, seq 0..199, new checkpoint at 200. **No duplicates, no missed lines** (D3 "Done when" holds).
   - Spool swapped for a new, larger file (rotation style): sidecar logged `STOPPING INGEST: Spool file shrunk or replaced`, exited with code 1, still 200 entries.
4. **Python 3.11:** not run on a real 3.11 (only 3.10 and 3.14 are installed). Covered by a test that simulates 3.11's `sqlite3.connect` signature and a scan for other 3.12+ only APIs or syntax (none found). Confirm for real when the D10 Docker image is built on 3.11.

## Red-team gate status (my view; Jeev ticks in HANDOFF.md)
- **D0:** gitignore gate **passes** (no keys, DBs or config.toml tracked; `CLAUDE.local.md` added). Python 3.11 gate **passes by simulation**; real check at D10.
- **D1:** malformed/extra/wrong type **passes**; duplicate keys, NaN, floats, non-UTF-8, `\r\n`, blank **pass**; allow-list **passes**; actor/ts spoofing **documented** in the HANDOFF trust model.
- **D2:** same-bytes collision: **passes** (duplicate keys rejected; sorted keys, fixed separators; different values give different bytes). Modified old field: stored hash stops matching (**passes**; flagging it is D5). Re-chain after edit: **expected gap**, noted. Two writers: **passes** (RT-08).
- **D3:** all five **pass** (RT-05, RT-06, RT-07, half line, forged lines documented).
- **D4:** vectors and shape **pass**; forge without key **passes** (Ed25519); key storage **documented** above (host admin can read it; witness is the answer); key never logged or committed **passes** (only the public key is logged); replay/delete of a local checkpoint: **expected no**, needs D6/D8.
