# DEFENCE STEPS (Jeev): base model

You build: sidecar/, witness/, verifier/, tests/, tools/. The defence is standalone and platform-agnostic: same code for every platform, only the profile (`config.toml`) differs. No platform-specific code anywhere.
Read CONTRACT.md first. Every step has: Build, Done when, Hiccups.

## How to use this file with Claude or Antigravity
Open the repo as the workspace and start each step with:

> Read AGENTS.md, CLAUDE.md, docs/CONTRACT.md and docs/DEFENCE_STEPS.md. We are on Step N. Explain what it needs and why, then wait for me to write it.

When stuck, paste: the step number, the exact error, what you expected. Ask the agent to explain the cause before any fix.

## Working separately: how this stays compatible
- The defence never depends on a specific platform. Until a real spool exists, your own generator (Step 1) feeds the sidecar.
- The demo platform (bank-style clone) lives in its own repo and is just the first integration. See INTEGRATION.md for what any platform must do.
- Integration check A: the platform team commits real events to their repo; run `python -m tools.validate_spool <their file>` against them. Any difference from the contract goes through the change protocol.
- Integration check B: write a profile for the platform, point `spool_path` at its real spool. If the validator passes and the verifier says clean, it is integrated, with zero code changes.
- Commit often. Merge to main at integration checks.

---

## D0: Repo and environment
Build:
- Python 3.11+ virtualenv. Install `cryptography fastapi uvicorn httpx pytest`. Save `requirements.txt`.
- Copy `config.example.toml` to `config.toml`. Add `config.toml`, `data/`, `spool/*.jsonl`, `*.key` to `.gitignore`.
- Create empty packages: `sidecar/__init__.py`, `witness/__init__.py`, `verifier/__init__.py`, `tools/__init__.py`.

Done when: `pytest` runs (zero tests is fine) and `python -c "import tomllib; print(tomllib.load(open('config.toml','rb')))"` prints the config.

Hiccups:
- `tomllib` missing: your Python is older than 3.11. Check `python --version`.
- On Windows use `py -3.11 -m venv .venv`. Paths in config use forward slashes.

## D1: Fake event generator and spool validator
Build:
- `tools/gen_events.py`: writes valid RawEvents (CONTRACT section 2) to the spool path at a configurable rate. Mix of sources and event types like the sample file, plus some non-standard snake_case event types to prove the defence is platform-agnostic.
- `tools/validate_spool.py`: reads a spool file and reports every line that breaks the contract (bad JSON, missing field, wrong type, unknown source, bad timestamp, event_type not snake_case, a float anywhere in `details`). With `--config`, also enforce the profile's `event_types` allow-list if it is non-empty. Runnable as `python -m tools.validate_spool <path> [--config config.toml]`. Exit code 0 if all lines pass.
- The validator is the acceptance test for any platform integration. Share it with every integrator.

Done when: the validator passes on `samples/events.sample.jsonl` and on a 1,000 line generated file, fails on a file where you break a line on purpose, and with an allow-list profile rejects an event type not on the list.

Hiccups:
- Timestamp check: require the trailing `Z` and seconds precision. `datetime.fromisoformat` handles `Z` only from Python 3.11.
- Floats: walk `details` recursively and reject any `float`. This covers money fields on every platform without knowing their names. Note `bool` is not a float, and integers are allowed.

## D2: Canonical JSON and the hash-chained store
Build:
- `sidecar/canon.py`: canonical JSON function and `sha256_hex`.
- `sidecar/store.py`: SQLite table `entries(seq PRIMARY KEY, ts, source, actor, event_type, details, prev_hash, hash, received_at)`. A function to append a RawEvent: read the last entry, set `seq` and `prev_hash`, compute `hash`, insert. Turn on WAL mode.

Done when: a test reproduces the five entry hashes in CONTRACT section 3 from the first five sample lines, and appending 100 entries gives an unbroken chain when re-read.

Hiccups:
- Hash differs from the contract vector: print the canonical bytes and compare with the contract string character by character. The usual causes are key order, spaces in separators, or `ensure_ascii` left at its default.
- `details` stored as text: store the canonical JSON string and parse it on read. Do not hash a re-serialised dict that was built differently.
- Two writers corrupt the chain: there must be exactly one process appending. Use `BEGIN IMMEDIATE` around read-last-then-insert.

## D3: Ingest from the spool file
Build:
- `sidecar/ingest.py`: follow the spool file and append new lines as entries. Keep the byte offset in a small state table so a restart neither repeats nor skips lines.
- `sidecar/main.py`: `python -m sidecar.main --config config.toml` starts ingest (checkpoints and heartbeat come in later steps).

Done when: run the generator and the sidecar together. Entry count grows with the spool line count. Stop and restart the sidecar: no duplicates, no missed lines.

Hiccups:
- A half-written last line: read in binary and only consume up to the last `\n`.
- A bad line in the spool: log it, skip it, keep going. Never crash the sidecar on one bad line. Use the same checks as the validator (including the profile allow-list), so behaviour is identical on every platform.
- Spool file replaced or shrunk: for the base model, print a loud error and stop. Handling it properly is later work.

## D4: Merkle tree, keys and signed checkpoints
Build:
- `sidecar/merkle.py`: root from a list of entry hashes, as in CONTRACT section 4.
- `sidecar/keys.py`: generate an Ed25519 key pair if missing; save the private key to `private_key_path` and the public key (hex) to `public_key_path`; sign and verify helpers over canonical JSON.
- `sidecar/checkpoint.py`: create a signed checkpoint every `every_n` entries or `every_s` seconds. Store it in a `checkpoints` table.

Done when: the five Merkle root test vectors match, a checkpoint signature verifies with the public key, and changing any one entry changes the root.

Hiccups:
- Wrong root for 3 or 5 leaves: you are probably pairing leaves from the left and duplicating the last one. The contract uses the recursive split at the largest power of two below `n`. Test sizes 1 to 8.
- Hash the 32 raw bytes of the entry hash, not the hex text, when building leaves.
- Keep `data/*.key` out of git. If it was committed once, rotate the key.

## D5: Verifier v1 (offline)
Build:
- `verifier/checks.py` and `verifier/__main__.py`: read the SQLite file and report `EDIT`, `CHAIN_BREAK`, `SEQ_GAP`, `CHECKPOINT_MISMATCH`, `BAD_CHECKPOINT_SIGNATURE` as in CONTRACT section 6. Print JSON, set the exit code.

Done when: for each verdict there is a test that copies the database, applies one tamper with plain SQL, and asserts the exact code and range. A clean database returns `clean: true`, exit 0.

Hiccups:
- One edit gives several verdicts (an edit also breaks the next entry's chain): decide an order and report the first break clearly. A clean list matters more than a long one.
- Deleting the last entries produces no verdict here. That is expected and it is the reason Step 8 exists.

## D6: Witness service
Build:
- `witness/app.py` (FastAPI), `witness/store.py` (SQLite, insert-only tables for heartbeats, checkpoints, alerts), `witness/checks.py` (the five alert rules).
- `data/witness_nodes.toml` with the node's public key.
- A background task for `SILENCE` with a startup grace period.

Done when: tests with `httpx` or FastAPI's TestClient send crafted heartbeats and each of `BAD_SIGNATURE`, `COUNTER_REPLAY`, `SEQ_ROLLBACK`, `FORK`, `SILENCE` is raised exactly when it should and a normal sequence raises nothing.

Hiccups:
- False `SILENCE` at startup: give a grace period after the service starts and after the first heartbeat.
- Do not trust the client's `ts`. Record the witness's own receive time next to it.
- Never update or delete rows in the witness tables. Insert only.

## D7: Heartbeat client and checkpoint upload
Build:
- `sidecar/heartbeat.py`: every `interval_s` send a signed heartbeat; persist `hb_counter` in the sidecar database. Also upload each new checkpoint to `POST /checkpoint`.
- Run it in its own thread or async task so it can never block ingest.

Done when: sidecar and witness run together and the witness shows live pulses. Kill the witness: ingest keeps working, retries do not crash anything. Restart the witness: pulses resume with no `COUNTER_REPLAY`.

Hiccups:
- `COUNTER_REPLAY` after a sidecar restart: the counter was not persisted, or it was persisted before the send succeeded. Persist, then send, and handle a failed send by retrying the same counter on the next pulse.
- Witness unreachable: use short timeouts (2 to 3 seconds), log once per failure streak, do not spam.

## D8: Verifier v2 (with witness)
Build:
- Add `--witness URL`: fetch heartbeats and checkpoints and report `TRUNCATION`, `FORK` and `SILENCE`.

Done when: tests with a running test witness show: deleting the last N entries gives `TRUNCATION`; rewriting from entry K and re-chaining gives `FORK`; stopping the sidecar for longer than the silence window gives `SILENCE`.

Hiccups:
- After a legitimate full reset the new chain looks like a fork. That is correct behaviour for the base model: say so in the README.
- Compare by `seq`: the witness holds `head_hash` per `head_seq`. Look up your own entry at that `seq`.

## D9: Self-test tampering suite
Build:
- `tests/test_tampering.py`: edit, delete in the middle, truncate the tail, reorder two entries, fork-and-rewrite. For each: expected verdict code. Print one table: attack, verdict, pass or fail.
- This is only your base self-test. The red team builds the real attack set later.

Done when: all five are detected with the right code, and a clean run is clean.

Hiccups:
- Reorder: swapping two rows' contents usually shows as `EDIT` or `CHAIN_BREAK`. Assert on the code you actually get, then check it is sensible.
- A test that never fails proves nothing: break the verifier on purpose once and watch it go red.

## D10: Docker packaging
Build:
- `sidecar/Dockerfile` and `witness/Dockerfile` (small Python images), and a standalone `defence-compose.yml` with two services: `sidecar` (mounts a spool folder read-only, `./data`, and the profile `config.toml`) and `witness` (its own volume, port 8800).
- The spool folder and profile are the only things that change per platform. Any platform's compose file can include or reference `defence-compose.yml` unchanged.

Done when: `docker compose -f defence-compose.yml up` starts both, the generator (run on the host) feeds the spool, and the verifier on the host reports clean. Swapping in a second profile needs no rebuild.

Hiccups:
- File permissions on mounted volumes (Linux): run the container with your user id or `chmod` the folder.
- Inside Compose the witness URL is `http://witness:8800`, not `localhost`.
- Publish the compose file and image names in INTEGRATION.md as soon as they build.

---

## Done with the base model when
- All of D0 to D10 pass their checks.
- `pytest` is green.
- The README quickstart is true.
- Integration check B passes on the demo platform with zero defence code changes, and the red team has access.

## Integration-ready steps (I0 to I4)
Goal: any platform plugs in with a profile only. Same code, different profile. Docker only (no pip): the `coc` wrapper runs the CLI inside the image. The witness runs on a second laptop.

## I0: Contract and ownership (no code)
Build:
- AGENTS.md: collectors move from platform side to defence side; `coc/` and `collectors/` added to the structure.
- CONTRACT v0.3 draft on branch `contract-change-collectors`: `[[collectors]]` (section 7), RT-24 `hb_counter` wording (section 5), RT-28 verifier mapping (section 6), guarantees (section 8).
- Jeev messages Jaganath with the diff, asking to approve v0.2 and v0.3 together.

Done when: Jaganath says OK. I1 and I2 do not depend on it; I3 waits for it.

## I1: `coc init` and `coc check`
Build:
- New package `coc/`: `cli.py` (argument parsing, `python -m coc <command>`), `init.py`, `check.py`, `profile.py`.
- `coc/profile.py`: one schema for the whole profile (every section and key in CONTRACT section 7, with types and defaults). Loads `config.toml` and returns either the parsed profile or a list of errors. Unknown keys are errors (a typo like `intervl_s` must not be silently ignored). `coc check` and `sidecar.main` both use it, so a profile that passes the check also starts the sidecar.
- `coc init [--node-id ID] [--spool PATH] [--witness-url URL] [--force]`:
  - Writes `config.toml` from `config.example.toml` with the flags filled in.
  - Generates the Ed25519 key pair at the profile's key paths. This replaces the long one-liner in INTEGRATION.md section 5.
  - Writes `data/witness_nodes.toml` with `node_id = "<public key hex>"`.
  - Prints next steps: the exact line to put in `witness_nodes.toml` on the witness laptop, the witness URL to set, then `coc check`.
  - Second run: anything that already exists is left alone and reported; only missing pieces are created. `--force` regenerates, but is refused while the sidecar DB exists (a new key against an existing chain looks like a fork to the witness, and silent key rotation is what RT-12 closed).
  - Private key: `chmod 600` on Linux and macOS. On Windows, print that file permissions are not enforced. The key is never printed.
- `coc check [--config config.toml]`. Layers, cheapest first; a failing layer stops the later ones that depend on it:
  1. Profile: TOML syntax (with line number, from `tomllib`), then types, missing and unknown keys, by key path (`heartbeat.interval_s: expected integer, got string`). No stack traces.
  2. Paths: key files exist and match each other, data folder writable, spool readable. A missing or empty spool is a WARNING, not a failure (on a fresh install the platform has not written yet).
  3. Spool: lines follow CONTRACT section 2 (reuse `tools.validate_spool`).
  4. Witness: `GET /heartbeats?node_id=<id>` with a 3 s timeout. Unreachable: explain what to check (the witness laptop's IP, port 8800, its firewall, both laptops on the same network or hotspot). Reachable but no heartbeats yet for this node: WARNING, plus a reminder that the node's key must be in the witness's `witness_nodes.toml`.
  5. Collectors: placeholder, filled in by I3.
  - Read only: `coc check` never creates or changes the DB, spool, offsets or keys, and never POSTs to the witness (a heartbeat would use up an `hb_counter` value).
  - Output: one line per check (PASS, WARN, FAIL). Exit 0 if nothing failed, 1 if a check failed, 2 if the tool itself crashed (same meaning as the verifier).
- `coc.ps1` and `coc.sh` in the repo root: run `docker run --rm -v <current folder>:/work -w /work <sidecar image> python -m coc <args>`.
- Fix on the witness side: refuse to start, with a clear message, if `nodes_file` is missing or is a folder (Docker creates a folder when the file is missing).

Done when:
- On a fresh clone, `coc init` and then `coc check` pass with no manual edits (with the witness running; spool warnings allowed).
- A broken profile gives one clear error each for: a typo'd key, a wrong type, a missing key file, a TOML syntax error.
- With the witness laptop off or unreachable, `coc check` fails within about 5 s with the network checklist, never hangs.
- Each of the above is a pytest test.

Hiccups:
- `tomllib` gives line numbers only for syntax errors. For type errors, the key path is enough; do not add a TOML library for line numbers.
- Paths inside the wrapper: the container sees the current folder as `/work`, so keep profile paths relative (as `config.example.toml` does). Windows paths with a drive letter will not resolve inside the container.
- Do not reuse `init_db` in `coc check`: it creates the DB if it is missing. Open SQLite read-only (`file:...?mode=ro`, `uri=True`).

## I2: Split compose and publish images (outline, detail before starting)
- `sidecar-compose.yml` runs next to the platform; `witness-compose.yml` runs on the witness laptop. Images use `image:` from GitHub Container Registry, not `build:`.
- Done when: on the second laptop, only the witness compose file, the `coc` wrapper and `witness_nodes.toml` are needed; the platform laptop needs no clone of this repo.

## I3: Collectors (outline, waits for CONTRACT v0.3 OK)
- `collectors/` with `json_lines`, `access_log`, `db_audit` as in CONTRACT section 7, run by `coc collect` as the single spool writer. `coc check` layer 5 tests each collector against real data.
- Done when: Jaganath's platform is protected by a profile alone, with zero defence code changes.
- Known from the platform (docs/PLATFORM_HANDOVER.md): PostgreSQL 15 (add `psycopg` to requirements), access log in combined format once written to a file, no app log file.
- Hiccup: parse JSONB/NUMERIC as `Decimal` (psycopg returns exact values; `json.loads` must use `parse_float=Decimal`), then turn them into strings. Going through `float` loses money precision and breaks the no-floats rule.

## I4: Attack harness against the hacker repo (outline)
- Every attack script takes its targets as arguments. One script brings the system up, runs each attack, runs the verifier and asserts the expected code.
- Done when: every attack either gets the right verdict or is logged in HANDOFF.md as outside the trust model, and every attack that got through has a fix and a regression test.

## Later (do not start yet)
Key ratchet and per-entry MAC; external anchor; tamper forensics report; erasure support; dashboard; multi-node; rotation handling.
