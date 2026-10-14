# Cybersec Integration Handoff

**Date:** 2026-10-14  
**Purpose:** Preserve the current integration decisions and verified deployment facts for the next Claude session.

## Current request and scope

The user asked to refresh the `JeevikaS-19/cybersec` submodule, integrate its new detection work, test the result, and provide a copy/paste ct105 attack-demo command that can be verified on the witness dashboard. Before that work could proceed, the user asked that the work completed so far be documented here so Claude can continue.

Do not use Figma MCP. Keep the banking app on ct105 and the independent witness on the Oracle VPS. Keep the separate “Hacker Agent” out of scope. Changes to this document are a handoff, not evidence that integration, deployment, or testing has completed.

## Verification boundary for this handoff

The workspace's repository-settings pre-tool hook failed on local file reads, so the local checkout, Claude's uncommitted edits, and local test results could not be inspected in this session. The repository's published GitHub files and live HTTP endpoints were used as read-only references. **This is not a complete local repository scan.**

Before editing or merging code, Claude must inspect the actual local working tree and submodule state, preserve any uncommitted user changes, and read the files that are really present. Do not assume that published `main` matches the user's local checkout.

## Hosting and banking/witness design

- **ct105:** PostgreSQL plus the banking backend and frontend. The known deployment checkout is `/opt/chain-of-custody-firewallcrew`; its Compose project is `banking-system`. Preserve the local backend/frontend port mappings (`127.0.0.1:8081:8080`, `127.0.0.1:3001:80`) and the existing PostgreSQL volume. Do not reset the checkout, remove/recreate the database volume, or rebuild PostgreSQL for an app-only update.
- **Oracle VPS:** standalone Node witness on loopback port `8787`, published through the Cloudflare Tunnel at `witness.jrushvj.dev`. A separate pre-existing Python `coc-witness.service` on port `8800` is legacy; do not remove or overwrite it. Oracle is resource-constrained (about 1 GB RAM).
- The Node witness stores a hash-chained event ledger and periodically compares witnessed transaction events against the bank's narrow `/api/transactions/witness-reconcile` endpoint. It is a demo detector, not an independently authoritative bank ledger.
- The HMAC credential used by the bank-to-witness flow exists on ct105; ct105 root can read it. A compromised root can suppress or forge new traffic, replace the API/agent, or block reconciliation. Do not claim protection against a fully compromised source host.
- The two-phase bank/witness flow does not provide an atomic commit across the two machines. Keep uncertain/pending outcomes visible; do not describe the system as preventing all tampering.

Useful deployment and design references:

- [`BANKING_DEPLOYMENT.md`](./BANKING_DEPLOYMENT.md)
- [`CLOUDFLARE_ARCHITECTURE.md`](./CLOUDFLARE_ARCHITECTURE.md)
- [`chain-of-custody-plan-v2.md`](./chain-of-custody-plan-v2.md)
- [`witness/`](./witness/)

## Cybersec upstream state observed

At the time of this handoff, GitHub `JeevikaS-19/cybersec` `main` was at commit [`97e26e686250721def8e94fcf87b233cd231a7a2`](https://github.com/JeevikaS-19/cybersec/commit/97e26e686250721def8e94fcf87b233cd231a7a2), titled “Layer 1: profile-id team access, everything from config”. The existing project submodule pointer in published root `main` was still the earlier README commit `44f30f179cbd0d29fe68627cb315745235f6f0bb`.

Recent upstream changes, based on GitHub commit summaries and its README:

- Layer 1 command tripwire, configurable guarded commands, deception/block behavior, and profile IDs.
- Agent-signed event delivery to the Python witness; witness auditor view for activity, challenges, alerts, and layer events.
- Earlier upstream work added heartbeat/challenge monitoring and SQLite-based truth checks.
- Upstream reported its own Python fast tests and WSL smoke tests passing in commit messages. Those reports are **not** tests of this banking integration.

The upstream project is a separate Python application. Its quick-start bank uses SQLite and its README calls for an adapter mapping transaction rows and real balances into the agent model. It is not currently integrated with this app's PostgreSQL schema or the existing Node witness. Its Layers 1-3 must not be described as deployed here merely because the submodule pointer is advanced.

Before advancing the submodule:

1. Inspect the full local status, `.gitmodules`, the current gitlink, upstream diff from the pinned commit, new scripts/install steps, and relevant tests.
2. Review security-sensitive changes, especially privileged command wrappers, generated scripts, agent key registration/storage, event signing/verification, config-derived protected paths, and the distinction between deception mode and actual prevention.
3. Confirm the upstream license and the project's permission to adapt/distribute it; do not infer licensing from GitHub visibility.
4. Advance the submodule pointer only after review. Record the exact upstream commit and integration delta in the root repository.
5. Adapt the transaction/balance feed to this PostgreSQL application's actual schema, preserving integer minor-unit amounts and correct post-transaction balances. Add tests against this schema before deployment.
6. Keep the existing Node witness untouched until an explicit migration plan covers service ownership, ports, secrets, persistence, resource use, rollback, and dashboard behavior. Do not install a second witness on port 8787 or overwrite the legacy service.

## Live state observed on 2026-10-14

The public bank reconciliation endpoint returned:

```json
{
  "transactions": [
    {
      "transaction_id": 3,
      "type": "withdrawal",
      "amount_minor": "10000",
      "event_id": "5f74c0bd-f3c0-43ae-8619-3a1ba7944524"
    }
  ]
}
```

The public witness `/v1/status` returned a healthy witness with a reconciliation mismatch:

```json
{
  "state": "mismatch",
  "checked_transactions": 1,
  "mismatches": [
    {
      "transaction_id": 3,
      "issue": "changed_amount",
      "witnessed_type": "withdrawal",
      "bank_type": "withdrawal",
      "witnessed_amount_minor": 100,
      "bank_amount_minor": 10000
    }
  ]
}
```

These values mean the witness recorded transaction 3 as **100 minor units ($1.00)** while the current bank API reports **10,000 minor units ($100.00)**. The dashboard should be checked at `https://witness.jrushvj.dev/` to confirm its rendered alert; the HTTP status alone proves the API mismatch, not the browser's visual state. The earlier screenshot showing a $1 row is not the latest source of truth; use a fresh bank API/database read when continuing.

Do not blindly restore transaction 3. First check the current database row, witness event, and expected demo baseline. If changing the row for a demonstration, alter only that transaction history record and never represent the SQL update as changing or reversing the account balance.

## Safe attack-demo requirements

The requested one-paste ct105 demo should be a bounded, reversible **authorized simulation** on the demo transaction row, not a root-shell exploit, SSH brute force, service disruption, or arbitrary log/database tampering. It should:

- Confirm it is running in `/opt/chain-of-custody-firewallcrew/banking-system` with the expected Compose project.
- Check transaction 3 and its current witnessed baseline before writing; stop rather than overwrite unexpected values.
- Change only the `transactions.amount` history field for the known demo row, using a guarded SQL `UPDATE` that checks expected old value, transaction ID, and type.
- Poll the public witness status for a bounded interval and fail explicitly if reconciliation does not report the expected mismatch.
- Restore the exact prior amount in a `trap`/cleanup path even after an interrupted run, verify that restoration, and poll until the witness reports reconciliation clear.
- Print concise progress and nonzero exit status on any unexpected condition; never print secrets.
- Avoid changing account balances or creating a real money movement. Explain that it simulates a changed historical record, not a real attacker's complete host compromise.

Prefer checking the script into a clearly named demo location and running it with `bash` on ct105 rather than asking the user to paste an opaque multi-line command. If a single paste is needed, use a reviewed heredoc that writes the script to a fixed, clearly scoped path and then invokes it; do not silently overwrite an existing script. Test the script against a disposable local/test database first. Do not claim a dashboard test passed unless both the mismatch and post-restore clear state are observed live.

## Next-session work order

1. Inspect the entire **local** repository inventory, git status/diff, current branch/history, `.gitmodules`, and Cybersec gitlink. Preserve unrelated and uncommitted Claude edits.
2. Read project instructions and existing v2 docs before editing. Determine which parts of the prior Claude changes are committed, staged, or untracked.
3. Fetch Cybersec upstream and compare it with the pinned commit; perform the security/license review above. Do not pull blindly.
4. Decide and implement the narrow PostgreSQL adapter/test boundary; keep upstream code isolated where possible and avoid deploying the separate Python witness without an approved migration.
5. Run the project's backend, witness, frontend, and Cybersec tests that apply, plus build/lint checks documented by their manifests. Record commands and actual results; distinguish upstream-only tests from integration tests.
6. Prepare the guarded attack-demo script and test its mismatch/restore behavior against a test environment.
7. Deploy only after code/test review and confirmation of the current host state. Verify a fresh bank API response, witness `/v1/status`, the rendered dashboard mismatch, restoration, and dashboard recovery.
8. Update this handoff with exact commits, changed files, commands/results, and deployment evidence. Never record credentials or `.env` values.
