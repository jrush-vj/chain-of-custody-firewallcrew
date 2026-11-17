# Run the whole demo on your own laptop

Everything (bank, witness, attacker lab, IBM Bob) runs in Docker on one machine. Secrets are
generated fresh on first start; nothing is shared with anyone else's setup. Local testing only.

## You need

- **Docker Desktop**, running (give it ~4 GB RAM; the lab image download is ~1 GB the first time).
- **Git for Windows** (gives you *Git Bash*) on Windows; any terminal on macOS/Linux.
- **Node.js 18+**.
- **Your own IBM Bob API key** (only for the "Diagnose with Bob" step). Never commit it.

Run every command below in **Git Bash** (Windows) or a normal terminal (macOS/Linux), from the repo root.

## 1. Get the code

```bash
git clone https://github.com/jrush-vj/chain-of-custody-firewallcrew.git
cd chain-of-custody-firewallcrew
```

## 2. Start the bank, witness and lab (first run takes a few minutes)

```bash
bash deploy/local/test-stack.sh up       # postgres, backend, site, witness + a throwaway .env
bash deploy/local/test-stack.sh lab-up   # the "bank server" container the attacks run in
bash deploy/local/test-stack.sh traffic  # a few real transactions (Layer 2 needs them)
```

## 3. Start the two consoles (each in its own terminal, leave them running)

```bash
node deploy/hacker-demo/server.js                          # red team console: http://localhost:3300
BOB_API_KEY=your-key-here node deploy/local/bob/defender.mjs   # IBM Bob defender
```

## 4. Demo

1. Open the red team console http://localhost:3300 and launch the attacks (or "Launch all three").
2. Open the witness dashboard http://localhost:8787 and press **Diagnose with Bob** (~2 minutes).
3. Layer 3 leaves a dry-run quarantine: clear it with **Restore to normal** on the witness.

The bank site itself is at http://localhost:3001.

## Stop / reset

```bash
bash deploy/local/test-stack.sh down     # removes containers, data and the throwaway .env
```

## If something fails

- `NOT UP: ...` after `up`: make sure Docker Desktop is running, then run `up` again.
- Lab has no heartbeat: `bash deploy/local/test-stack.sh lab-logs`.
- `refusing: banking-system/.env exists`: you have a real `.env` there; move it away first.
- Ports 3001, 3300, 8081 or 8787 already in use: stop whatever uses them.

Bob runs with a root shell inside the lab and can reach Docker, so only use this throwaway setup.
