# Chain of Custody - Hacker Demo UI

A browser-based demo interface showing Layer 1, 2, and 3 attacks on the banking server, with real-time detection by the witness.

## Setup

1. **Install Node.js** (v18+)
2. **Run the API server:**
   ```bash
   cd deploy/hacker-demo
   node server.js
   ```
3. **Open in browser:**
   ```
   http://localhost:3000
   ```

## How it works

- **Left panel:** buttons for Layer 1, 2, 3 attacks. They trigger `ssh ... coc.sh attack N` on your server.
- **Right panel:** live chat log showing attack output and witness detections.
- **Status:** shows real-time connection to the server, witness, and SSH.
- **Custom commands:** enter any SSH command to run on the server.

## Attacks

| Layer | What it does | Detection |
|-------|-------|-----------|
| **1** | Touches honeypot-wrapped commands (nano, rm, etc.) | Witness sees tripwire alerts |
| **2** | Edits a transaction in PostgreSQL | Witness detects DB tampering |
| **3** | Cuts network between bank and witness | Layer 3 flags quarantine; attacker is locked out |

## Demo flow

1. Register a user on http://192.168.31.77:3001
2. Make a deposit (it's witnessed)
3. Open this demo UI and trigger attacks
4. Watch the witness dashboard at http://localhost:8787 show detections
5. After Layer 3, run "Restore" button on the witness dashboard to unlock

## Notes

- SSH key login recommended; you'll be asked for passwords otherwise
- Attacks call the existing `coc.sh` scripts on the server
- The demo runs the same attacks that Jeevika tests on `main`
