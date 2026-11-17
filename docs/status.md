# Status

Updated 2026-11-17.

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

## Guard (branch `guard-containment`, 2026-11-17; not merged, nothing pushed)

Off by default (`GUARD_ENABLED`, and `COC_GUARD` on the bank host), so the demo behaves as before. See
[`witness/guard/README.md`](../witness/guard/README.md) for settings, the API and the approver-token recipe.

- **Alarm classifier** (`witness/guard/classify.js`): pure function over witness-side evidence; separates tamper,
  a verified clean reconnect, silence, flapping and box-only claims. Reads no free text, so planted text
  cannot change a verdict. `SITE_OUTAGE` and `PROBE_FAIL` are fixture-only: this witness watches one box.
- **Soft containment** (`containment.js`, `approvals.js`): SEALED / PENDING / QUARANTINED / RESUMED / UNSTABLE in
  front of the unchanged Layer 3 quarantine. Tamper evidence counts down 120 s to the existing quarantine;
  ambiguous evidence stays sealed; approvals are API only. "Sealed" is a recorded state: it does not yet
  block privileged actions on the host.
- **Incident reports** (`report/`): built from the witness's own ledger with no key, stored in the ledger,
  independently checkable with `report/verify-cli.js`; a report that fails verification is never served.
- **Bob guardrails** (`bob/`): all 11 tool groups disabled, empty workspace, minimal environment, no shell;
  injection-like input withheld; output schema-validated; any tool-call attempt is a ledger alert.
  `BOB_ENABLED` is the master switch (also refuses "Diagnose with Bob").
- Tests: witness 128/128 (`npm test`), box monitor 22/22; `npm run guard-demo` replays 41 checks with no key.
  The existing Layer 1-3 code, the quarantine code and `auditor.html` are unchanged.

### What running the real Bob service showed (2026-11-17)
- Tool groups really are off: 0 `tool_use` events and `stats.tool_calls: 0`. Bob nevertheless wrote
  invented tool calls and output as prose (a made-up directory listing and hostname); the schema rejects it.
- The answer arrives as assistant chunks in `stream-json`, wrapped in a code fence; the adapter now reads that.
- A narrative can still be wrong while passing every check (it read a sequence number as a count of 4
  records, with "high" confidence). It is therefore shown labelled "AI-written; not verified".
- The unrestricted defender (root, Docker socket) saw the planted instructions as untrusted and ignored
  them: cost 1.257 of the 1.5 cap. So that Bob was not hijacked; the guardrails matter because they
  remove the capability, not because one test run was fooled.
- A scripted "hijacked" Bob is what the tests and the demo use; its failures are all stopped.

### Not done
- Live test of a Bob that actually obeys an injection (we could not make it); egress allowlist for the
  Bob process (infrastructure, not code); guard state lives in witness memory (decisions are in the ledger);
  the dashboard shows none of this (API only, by request); guard not run against the lab stack end to end.
