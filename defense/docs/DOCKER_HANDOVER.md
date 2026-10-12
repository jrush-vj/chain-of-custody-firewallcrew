# Docker handover: run the defence in Docker once

**Goal:** prove the two defence containers (sidecar and witness) build and run, and that the verifier says the log is clean. This has never been run, because Jeev's machine can't run Docker yet. It takes about 30 minutes.

**You need:** Windows 10/11 (or macOS/Linux), Git, Python 3.11 or newer. Commands below are for Windows PowerShell; on macOS/Linux use `source .venv/bin/activate` and `cp` instead of `copy`.

---

## 1. Install Docker Desktop
1. Download it from https://www.docker.com/products/docker-desktop/ and install it with the default options (it uses WSL 2).
2. Restart if it asks. Open Docker Desktop and wait until it shows "Engine running".
3. Check it works: `docker run --rm hello-world` prints "Hello from Docker!".

If it does not start:
- "Virtualization not enabled": Task Manager > Performance > CPU must show "Virtualization: Enabled". If it says Disabled, turn on Intel VT-x / AMD SVM in the BIOS.
- "WSL 2 is not installed": open PowerShell as admin, run `wsl --install`, restart.

## 2. Get the code
```
git clone <THIS_REPOSITORY_URL>
cd banking-security-demo/defense
py -3.11 -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## 3. Set up the profile, key and witness key file
```
copy config.example.toml config.toml
mkdir data, spool
python -c "from pathlib import Path; from sidecar.keys import load_or_generate_keypair as k; print(k(Path('data/node1.key'), Path('data/node1.pub'))[1])"
```
The last command prints a 64-character key. Open Notepad, paste this with your key in place of the Xs, and save it as `data\witness_nodes.toml`. Set "Save as type" to "All files" and "Encoding" to "UTF-8":
```
[nodes]
node-1 = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
```
Do this before step 4. If the file is missing, Docker creates an empty **folder** with that name. If that happens, delete the folder and create the file.

## 4. Build and start
```
docker compose -f defence-compose.yml up -d --build
docker compose -f defence-compose.yml ps
```
Both `chain-of-custody-sidecar` and `chain-of-custody-witness` should be "running". If one is not, run `docker compose -f defence-compose.yml logs` and copy the output.

## 5. Feed events and verify
```
python -m tools.gen_events --config config.toml --count 200 --rate 20
```
Wait 45 seconds, so the sidecar sends at least one heartbeat. Then:
```
python -m verifier --config config.toml --witness http://localhost:8800 --node-id node-1
```
**Expected:** JSON with `"clean": true` and `"checked_entries": 200`. Check the exit code with `echo $LASTEXITCODE`: it should print `0`.

## 6. Three safety checks (copy the output of each)
```
docker inspect chain-of-custody-sidecar --format "{{json .Mounts}}"
```
- The mount with `"Destination":"/app/spool"` must show `"RW":false`.
- No mount may have the name `witness-data` (only the witness may see that volume).

```
docker run --rm chain-of-custody-sidecar:latest find /app -name "*.key" -o -name "*.pub" -o -name "*.db" -o -name config.toml
docker run --rm chain-of-custody-witness:latest find /app -name "*.key" -o -name "*.pub" -o -name "*.db" -o -name config.toml
```
- Both must print **nothing**. If they print a file, a secret was copied into the image.

## 7. Optional: watch it catch something (2 minutes)
```
docker compose -f defence-compose.yml stop sidecar
```
Wait 90 seconds, then run the verifier command from step 5 again. **Expected:** a `SILENCE` verdict and exit code `1`. Then start it again with `docker compose -f defence-compose.yml start sidecar`.

## 8. Clean up and report
```
docker compose -f defence-compose.yml down
```
Send Jeev:
- Did steps 4, 5 and 6 pass? (yes/no each)
- The verifier output from step 5 (and step 7 if you did it)
- The full error text for anything that failed, plus `docker compose -f defence-compose.yml logs` if a container stopped

Do not commit or push anything from this folder. `config.toml`, `data/` and the key are private and already ignored by git.
