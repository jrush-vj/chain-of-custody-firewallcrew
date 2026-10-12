# HANDOFF: Defence side (PS-6 Chain of Custody)

Owner: Jeev. The demo platform is a separate, standalone repo owned by Jaganath. This repo never contains or depends on platform code; the only shared thing is CONTRACT.md.
Stages are the D steps in DEFENCE_STEPS.md (build details live there). This file adds a red-team gate to each step and tracks state between agents.
Rule: a step is DONE only when its "Done when" check (DEFENCE_STEPS.md) AND its red-team gate are ticked. Only Jeev ticks red-team boxes.
Status key: [ ] todo, [~] in progress, [x] done, [!] red team broke it, needs fix

## Current state
- Current step: D0-D10 built (red-team gates await Jeev's ticks; D10 compose still never run; handed to a teammate via docs/DOCKER_HANDOVER.md). Now: I0 (waiting for Jaganath) and I1 (ready for Antigravity)
- Last agent: Claude (I0 drafts on branch `contract-change-collectors`: CONTRACT v0.3, AGENTS.md ownership; I0-I4 written into DEFENCE_STEPS.md with gates below. Before that: moved docs into docs/)
- Layout: README, AGENTS.md, CLAUDE.md stay at the root (agents load them there); .antigravity/tasks.md stays where Antigravity reads it
- Last commit reviewed: 4c32d6b plus Antigravity's uncommitted D8-D10 work; D8-D10 and fixes in 29141c8 (pushed); pytest 157 passed (one unexplained single failure in 10 runs, did not repeat)
- Open bugs: none known. Not yet verified: image build and compose up (no Docker on the review machine), Linux file ownership (RT-38)
- Contract notes RT-24 (hb_counter per send attempt) and RT-28 (verifier reports witness FORK / SEQ_ROLLBACK alerts): folded into the CONTRACT v0.3 draft
- New CLI flags (deployment overrides, profile keys unchanged): verifier `--node-id`, sidecar `--witness-url`, witness `--nodes-file`
- Window between heartbeats: newest interval_s + 2.5 s of events (32.5 s at default) can be removed or rewritten with no witness verdict
- Interface assumptions about the platform: only CONTRACT.md v0.2. RawEvents arrive as JSONL in the spool file at `[paths] spool_path`; fields `source, ts, actor, event_type, details`; checked by `tools/validate_spool.py`.

## Trust model (what the red team may assume)
- The attacker has admin on the platform host: can edit the sidecar SQLite file, the spool file and anything under data/ on that host.
- The attacker does not control the witness machine.
- The platform is trusted for the content of events it writes (actor, ts, details). The defence proves logs were not changed after ingest; it cannot prove the platform told the truth.

---

## D0: Repo and environment
- [x] Build ("Done when" passes)

Red-team gate
- [ ] config.toml, data/, spool/*.jsonl, *.key and CLAUDE.local.md are gitignored and none are tracked
- [ ] Code runs on the stated minimum Python (3.11), not just the venv's version

## D1: Event generator and spool validator (the contract boundary)
- [x] Build

Red-team gate
- [ ] Malformed line, missing field, extra field, wrong type: rejected, never silently accepted
- [ ] Duplicate JSON keys, NaN/Infinity, floats at any depth, non-UTF-8, `\r\n`, blank lines: rejected
- [ ] Event type outside the profile allow-list: rejected when the list is non-empty
- [ ] Spoofed `actor` / `ts` from the platform: confirm this is documented as out of the defence's power (trust model), not silently assumed

## D2: Canonical JSON and hash-chained store
- [x] Build

Red-team gate
- [ ] Two different-looking entries that serialize to the same canonical bytes?
- [ ] Modify one field of an old entry: does the stored hash stop matching? (detection itself is D5)
- [ ] Recompute the whole chain after editing: nothing stops this yet. Expected; D4 checkpoints + D8 witness catch it. Note it, do not fail D2 for it
- [ ] Two writers at once: can the chain fork or skip a seq?

## D3: Ingest from the spool file
- [x] Build (RT-05 to RT-09 fixed)

Red-team gate
- [ ] Crash between storing an entry and saving the spool offset: duplicate or missed event after restart?
- [ ] An append that fails: is the event lost silently?
- [ ] Spool truncated or replaced while running: loud stop, no silent re-ingest
- [ ] Half-written last line: never ingested until complete
- [ ] Forged lines appended to the spool by the attacker: inherent (spool is platform-writable), confirm it is documented

## D4: Merkle tree, keys and signed checkpoints
- [x] Build (checkpoints wired into main.py, RT-10 to RT-15 fixed)

Red-team gate
- [ ] Merkle roots match CONTRACT section 4 vectors for n=1..5, and sizes 1..8 are sane
- [ ] Attacker with write access to the DB but not the key: can they forge a checkpoint?
- [ ] Key storage decided and documented: private key on the platform host is readable by its admin, so local checkpoints alone are not proof. State this
- [ ] Is the key ever logged, printed or committed?
- [ ] Replay or delete an old validly signed checkpoint: detected? (local only: expected no; witness copy in D6/D8)

## D5: Verifier v1 (offline)
- [x] Build (RT-17 to RT-22 fixed)

Red-team gate
- [ ] Edit one field of a middle entry -> EDIT
- [ ] Delete a middle entry -> SEQ_GAP
- [ ] Swap two entries (reorder) -> a sensible code at the right seq
- [ ] Insert a forged entry -> detected
- [ ] One tamper gives one clear first verdict, not a flood
- [ ] Rewrite and re-chain everything after seq K: caught by CHECKPOINT_MISMATCH if a checkpoint covers K
- [ ] Verifier crash or bad DB gives exit 2, never a false "clean"

## D6: Witness service
- [x] Build (RT-23 fixed)

Red-team gate
- [ ] Heartbeat from a node not in nodes_file, or bad signature -> BAD_SIGNATURE
- [ ] Replay an old valid heartbeat -> COUNTER_REPLAY
- [ ] Lower head_seq -> SEQ_ROLLBACK; same head_seq, different hash -> FORK
- [ ] Forged heartbeat vs missed heartbeat: handled differently (BAD_SIGNATURE vs SILENCE)
- [ ] Witness tables are insert-only: no UPDATE/DELETE path in the code
- [ ] Alert flooding: can junk requests bury a real alert?
- [ ] Witness trusts its own clock, not the client's ts

## D7: Heartbeat client and checkpoint upload
- [x] Build (RT-24 to RT-26 fixed; "Done when" checked end-to-end)

Red-team gate
- [ ] Tail truncation: drop the last N entries and keep sending heartbeats -> SEQ_ROLLBACK at the witness
- [ ] Kill the heartbeat thread or the whole sidecar -> SILENCE
- [ ] Sidecar restart: no COUNTER_REPLAY (counter persisted correctly)
- [ ] Witness down: ingest keeps going, no crash, no log spam
- [ ] Shared SQLite connection between ingest and heartbeat threads: safe?

## D8: Verifier v2 (with witness)
- [x] Build (RT-28 to RT-30, RT-36 fixed)

Red-team gate
- [ ] Delete the last N entries -> TRUNCATION
- [ ] Rewrite the whole chain and re-sign with the stolen local key -> FORK
- [ ] Sidecar stopped past the silence window -> SILENCE
- [ ] Window between heartbeats: how much can be tampered undetected? Write the number down

## D9: Self-test tampering suite
- [x] Build (RT-37 nitpick fixed)

Red-team gate
- [ ] Break the verifier on purpose once: the suite goes red

## D10: Docker packaging
- [~] Build (RT-31 to RT-34, RT-16, RT-27 fixed; images not built yet, no Docker on the review machine)

Red-team gate
- [ ] Spool mounted read-only in the sidecar container
- [ ] No keys, DBs or config.toml baked into images
- [ ] Witness data on its own volume, not reachable from the sidecar container

## Integration checks (platform repo, separate)
- [ ] Check A: real platform events pass `tools.validate_spool`
- [ ] Check B: profile written, real spool feeds the sidecar, verifier clean, zero defence code changes
- [ ] Check C: full red-team run with the teammate against the integrated system; every successful attack logged below with its fix

## Integration-ready steps (I0 to I4, build details in DEFENCE_STEPS.md)
Decisions (Jeev, 2026-10-10): collectors move into the defence (CONTRACT v0.3); Docker only, no pip; `coc` wrapper script runs the CLI in the image; new `coc/` package approved; witness runs on a second laptop.

## I0: Contract and ownership
- [x] AGENTS.md updated, CONTRACT v0.3 drafted on `contract-change-collectors`
- [x] Merged to main (2026-10-10, Jeev's call: this repo is defence-only, so main does not wait for the platform)
- [ ] Jaganath approves v0.2 + v0.3 and updates his pinned copy; then drop "DRAFT" from the CONTRACT title

## I1: `coc init` and `coc check`
- [ ] Build

Red-team gate
- [ ] Fresh clone: `coc init` then `coc check` pass with no manual edits
- [ ] Broken profile (typo'd key, wrong type, missing key file, TOML syntax error): one clear error each, no stack trace
- [ ] Witness laptop off: `coc check` fails in about 5 s with the network checklist, never hangs
- [ ] `coc init` run twice changes nothing; `--force` is refused while the sidecar DB exists
- [ ] After `coc check`, the DB, spool, offsets and keys are byte-identical and the witness has no new rows
- [ ] The private key never appears in any output, log or error message
- [ ] Witness refuses to start when `nodes_file` is missing or a folder

## I2: Split compose and publish images
- [ ] Build (detail before starting)

## I3: Collectors (waits for I0 approval)
- [ ] Build (detail before starting)

## I4: Attack harness against the hacker repo
- [ ] Build (detail before starting; needs the hacker repo link)
- [ ] Record the hacker repo commit tested; every attack that gets through goes in the findings log with a fix and a regression test

### Open questions
- [x] Distribution: Docker only (pip after the hackathon, if the project continues)
- [x] Generic collectors in the defence: yes, via CONTRACT v0.3
- [x] Witness for the demo: second laptop (same hotspot, firewall open on 8800, clocks synced)
- [ ] Platform repo link (Jeev gives it once I1/I2 are in place)
- [ ] Hacker repo link
- [x] Platform database: PostgreSQL 15 (`postgres` driver added to the v0.3 draft). Logs: morgan combined, errors only, stdout only; nginx access log to stdout only
- [ ] Jaganath's replies and platform changes: docs/PLATFORM_HANDOVER.md

## Later (out of scope for the base model, see AGENTS.md)
- Per-entry MAC / key ratchet, external anchoring, forensics/evidence report, dashboard, innovation layer.
- Red-team questions to answer when these start: does it add attack surface? Can the attacker write to the anchor store? Does the report itself prove integrity?

---

## Red-team findings log
| Step | Attack | Result | Fix commit |
|------|--------|--------|------------|
| D0 | RT-01 Run on Python 3.11 | BREAKS: `autocommit=` needs 3.12 | 4960b95 |
| D1 | RT-02 Lone surrogate (`\ud800` escape) | BREAKS: passed validator, dropped at ingest | 4960b95 |
| D1 | RT-03 Deeply nested JSON line | BREAKS: validator crash, ingest stalls forever | 4960b95 |
| D1 | RT-04 Duplicate JSON key | WEAKENS: accepted, last wins | 4960b95 |
| D3 | RT-05 Crash between append and offset save | BREAKS: duplicate entry on restart | 4960b95 |
| D3 | RT-06 Append fails (disk full) | BREAKS: event lost | 4960b95 |
| D3 | RT-07 Replace spool with a longer file | BREAKS: forged lines ingested from old offset | 4960b95 |
| D3 | RT-08 Second sidecar on same DB | WEAKENS: duplicates | 4960b95 |
| D4 | RT-10 Run sidecar, wait for checkpoints | BREAKS: none ever created | 4960b95 |
| D4 | RT-11 Delete middle row, then checkpoint | WEAKENS: signs inconsistent tree | 4960b95 |
| D4 | RT-12 Delete .pub or .key | WEAKENS: private key replaced, identity rotated | 4960b95 |
| D4 | RT-13 Non-string signature | WEAKENS: verify crashes | 4960b95 |
| D5 | RT-17 Forged entry with seq -1 | BREAKS: verifier says clean | 4960b95 |
| D5 | RT-18 Invalid JSON in one row's details | WEAKENS: verifier crash hides all verdicts | 4960b95 |
| D5 | RT-19 Re-chain, then delete node1.pub | BREAKS: checkpoint checks skipped, clean | 4960b95 |
| D5 | RT-20 Truncate below a signed local checkpoint | WEAKENS: clean | 4960b95 |
| D5 | RT-21 Run with --witness | WEAKENS: flag ignored, "clean" | 4960b95 (stub until D8) |
| D6 | RT-23 Junk heartbeats with random node_ids | WEAKENS: unbounded alert rows | 4960b95 |
| D7 | RT-24 Reply lost / crash after send | WEAKENS: false COUNTER_REPLAY | 4960b95 |
| D7 | RT-25 One DB error in heartbeat thread | WEAKENS: heartbeats stop for good | 4960b95 |
| D7 | RT-26 Witness rejects checkpoints | WEAKENS: silent upload failure | 4960b95 |
| D8 | RT-28 Stolen key: rewrite, re-sign, feed forged head to witness | BREAKS: verifier with witness says clean | 29141c8 |
| D8 | RT-29 Edit node_id in config to an unseen id | BREAKS: verifier with witness says clean | 29141c8 |
| D8 | RT-30 Verify while sidecar is live | WEAKENS: false TRUNCATION | 29141c8 |
| D10 | RT-31 compose up: spool mount path | BREAKS: nothing ingested, silently | 29141c8 |
| D10 | RT-32 compose up: witness nodes_file | BREAKS: witness cannot start | 29141c8 |
| D10 | RT-33 compose up: witness_url localhost | BREAKS: no heartbeats, SILENCE | 29141c8 |
| D10 | RT-34 No .dockerignore | WEAKENS: secrets sent to builder | 29141c8 |
| D0/D6 | RT-16 unpinned requirements, RT-27 no body limit (carried) | WEAKENS / NITPICK | 29141c8 |
| D10 | RT-35 Witness on the same host in demo compose | WEAKENS: host admin can reach it | accepted for demo, documented |
| D10 | RT-38 Root-owned data/ on Linux | WEAKENS: host verifier may not open DB | documented, untested |

Full detail (why it broke, plan, verification), all in docs/red-team/: RED_TEAM_D0_D4.md (RT-01 to RT-16, including nitpicks RT-09, RT-14 to RT-16) RED_TEAM_D5_D7.md (RT-17 to RT-27, including nitpicks RT-22, RT-27) and RED_TEAM_D8_D10.md (RT-28 to RT-38, plus RT-16 and RT-27 closed)
