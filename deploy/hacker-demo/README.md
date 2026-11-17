# Chain of Custody - Hacker Demo UI

A browser-based demo interface showing Layer 1, 2, and 3 attacks on the banking server, with real-time detection by the witness.

## Setup

1. **Install Node.js** (v18+) and start the local stack and lab (laptop testing):
   ```bash
   bash deploy/local/test-stack.sh up && bash deploy/local/test-stack.sh lab-up
   ```
2. **Run the API server:**
   ```bash
   cd deploy/hacker-demo
   node server.js
   ```
3. **Open in browser:**
   ```
   http://localhost:3300
   ```

## How it works

- **Left panel:** buttons for Layer 1, 2, 3 attacks. They run `coc.sh attack N` inside the `coc-lab` container (the bank server) with `docker exec`.
- **Right panel:** live log showing attack output.
- **Status:** whether the lab container and the witness are reachable.
- There is deliberately no free-form command box, and the API only answers same-origin requests.

## Attacks

| Layer | What it does | Detection |
|-------|-------|-----------|
| **1** | Touches honeypot-wrapped commands (nano, rm, etc.) | Witness sees tripwire alerts |
| **2** | Edits a transaction in PostgreSQL | Witness detects DB tampering |
| **3** | Cuts network between bank and witness | Layer 3 flags quarantine; attacker is locked out |

## Demo flow

1. Start the Bob defender: `node deploy/local/bob/defender.mjs` (needs `BOB_API_KEY`).
2. Make some witnessed transactions: `bash deploy/local/test-stack.sh traffic` (Layer 2 needs them).
3. On this console, launch the attacks (one by one, or "Launch all three in order").
4. Open the witness dashboard at http://localhost:8787 and press **Diagnose with Bob**. Bob checks the
   bank server, undoes anything still damaged, and walks you through Layer 1, 2 and 3 (about 2 minutes).
5. Layer 3 leaves a dry-run quarantine on the witness: clear it with "Restore to normal".
