# Status

Updated 2026-11-13 (branch `local-test`, uncommitted).

## Done
- Hacker demo restored (`deploy/hacker-demo`, http://localhost:3300): Layer 1/2/3 attack buttons run inside
  the `coc-lab` container. Free-form command box, `/run` endpoint and `Access-Control-Allow-Origin: *`
  removed; `Host` header checked (DNS rebinding).
- IBM Bob defender (`deploy/local/bob/defender.mjs`): watches witness `/alerts`, runs Bob Shell 2.1.0
  headless inside `coc-lab` (open root shell on the bank server), posts a signed `bob:*` brief back.
  Caps: 1.5 per incident, 30 turns, 6 runs/hour. Tested end to end on all three layers.
- Witness dashboard: per-layer IBM Bob brief panel and card status. Fixed: Bob's Layer 3 briefs were
  hiding a confirmed quarantine (regression test added). Witness tests 35/35, defender tests 5/5.
- "Diagnose with Bob" flow: attack first from the red team console, then press Diagnose with Bob on the
  witness; Bob checks the server, undoes leftovers and gives a per-layer walkthrough (Overview, Layer 1-3).
  Witness endpoints /v1/diagnose-request|pending|report (test added, 36/36). Live per-alert mode now opt-in
  (BOB_AUTO=1). Tested end to end: all 3 attacks, diagnosis done in 124 s, cost 1.343.
- Both dashboards restyled to the hackfest Secure Sphere look (light, IBM Plex, served locally, OFL).

## Next
- Merged into `main` (2026-11-17).
- Optional: give the defender its own witness node ID/secret so Bob's events can't pose as the bank's.

## Blocked / known limits
- `coc-lab` has the Docker socket (the Layer 3 attack needs it), so a hijacked Bob can still reach Docker.
- Bob can read the local test `.env` (it did once); never reuse this setup with real secrets.
- The diagnosis lives in witness memory only: a witness restart clears it (press the button again).
- A full diagnosis costs ~1.3, close to the 1.5 per-run cap; if Bob hits it, a short follow-up still asks for the report.
- Attack scripts undo their own changes a few seconds later, so part of Bob's "restore" is already done.
