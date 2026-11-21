# Bob usage and cost, run RUN001

Date: 2026-11-21. Repo commit `3103130` (branch `bob-audit`).
Source labels: **M** = measured live (witness `/status` `bob_diagnosis`, which the defender fills from `bob run --format json` `stats.session_costs` and its own timer). **L** = from the witness ledger. **I** = from the IBM usage record. **N/A** = not captured.

No key or secret appears here.

| Call id | Time (UTC) | Prompt id | Input tokens | Output tokens | Seconds | Cost (USD) | Purpose | Source |
|---------|------------|-----------|--------------|---------------|---------|------------|---------|--------|
| RUN001-D1 | 13:25:30 | `diagnosisPrompt` | N/A | N/A | 93 | 0.830 | T1: "Diagnose with Bob", three layers, real evidence | M |
| RUN001-D2 | 13:28:10 | `diagnosisPrompt` | N/A | N/A | 115 | 1.171 | T6: same prompt with an injected alert in the evidence | M |
| RUN001-D3 | 13:58 | `diagnosisPrompt` (evidence scoped to 30 min) | N/A | N/A | 80 | 0.494 | Re-run on the fixed defender; CLI stats: 23 tool calls, 76.9 s | M |
| RUN001-G1 | 13:40 | guard launch args | N/A | N/A | 8 | 0.004 | Guarded Bob asked to run a shell command (tools disabled) | M |
| RUN001-G2 | 13:40 | control (tools on) | N/A | N/A | 12 | 0.045 | Same prompt with tools enabled, positive control | M |
| RUN001-G3 | 13:44 | guard narrative x9 | N/A | N/A | 63 | not captured | Nine guarded-adapter runs (benign, 6 payloads, 2 extra); my script did not print their cost | M (seconds only) |
| RUN001-T2a | 14:20 | template only x3 | 0 | 0 | 0.008 (mean of 5, 8, 11 ms) | 0.000 | T2: guard report with no Bob call | M |
| RUN001-T2b | 14:20 | guard narrative x3 | N/A | N/A | 22.9 total (6.8, 9.7, 6.4) | not recorded | T2: same incident, report + Bob note; the guard path stores no cost | M (seconds only) |
| **Totals** | | | **N/A** | **N/A** | **363** (excludes T2b) | **2.544** (excludes G3) | 14 calls (excludes G3, T2b) | M |

Average per Diagnose run (three runs: 0.830, 1.171, 0.494): **0.832 USD and 96 s** (M). Per layer, if split evenly across the three layers: about 0.33 USD.

## What is not available, and why
- **Tokens:** the defender (`deploy/local/bob/defender.mjs`) keeps only `stats.session_costs` (cost) and its own seconds. It does not store input or output tokens. I did not have access to the IBM usage record, so these cells say N/A instead of an estimate.
- **Per-call ledger rows (L):** none. A diagnosis run writes **nothing** to the witness ledger; the result lives only in memory (`store.bobDiagnosis`) and is lost on a witness restart. `bob:report` ledger events (with `cost` and `seconds`) exist only in `BOB_AUTO=1` mode, which was not run. Checked: the ledger gained no Bob records during either call.
- **Follow-up call** (`--max-cost 0.3`, the "give me JSON only" retry): not triggered in either run.
- **T2 with and without templates:** not run. No template files exist, so there is no variant to compare (see the detailed report, T2).
- **Defender console:** it printed nothing useful in my captured log (output was buffered), so the cost and seconds above come from the witness record, not the console line.

## Cost controls observed in code
- `BOB_MAX_COST` default 1.5 per run. The T6 run reached 1.171, so a single run can cost close to the cap.
- `BOB_MAX_RUNS_PER_HOUR` default 6, so the worst case is about 9 USD per hour (6 runs at the 1.5 cap).
- A queued Diagnose request that nobody picked up stays queued and would be run, and billed, the next time the defender starts (observed in T7).

## Notes
- Cost figures are the CLI's own session cost, not an IBM invoice. Check against IBM's usage record before quoting them externally.
- Rotate the demo key after the demo. It is visible in Bob's own process environment, and Bob runs as root with a shell.

## Guarded path: cost is not recorded (found in T2)
The adapter returns `cost`, but `witness/guard/guard.js` builds the stored narrative without it (lines 81 to 83). Spend on the guarded path therefore appears in no report, no ledger event and no run record. Only the per-call cap (`--max-cost 0.3`) bounds it. Needs a code change and your approval.
