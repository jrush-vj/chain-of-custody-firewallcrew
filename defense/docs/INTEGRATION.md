# INTEGRATION: plugging any platform into Chain of Custody

The defence is the same code for every platform. To protect a platform you do two things, both outside the defence code:
1. **Adapters (platform side):** small programs that turn what the platform already leaves behind into RawEvents in a spool file.
2. **Profile (defence side):** one `config.toml` that tells the sidecar where the spool is and how to label the node.

No change to the platform's code. No change to the defence's code.

## 1. Map what each action leaves behind
Do the key actions on the platform (log in, fail a login, create, edit and delete a record, create an account). For each, note where evidence appears:
| source | typical evidence |
|---|---|
| `app` | the app's own log file (logins, errors) |
| `db` | an audit table filled by triggers on the important tables (insert, update, delete with old and new values) |
| `host` | the web server access log (method, path, status) |

Pick event type names. Reuse the recommended names in CONTRACT.md section 2 where they fit; otherwise any lowercase snake_case name is fine.

## 2. Write the adapters
- One adapter per source. Each follows its evidence (log file, audit table) and keeps a small state file so it never repeats or skips.
- **Database:** adding an audit table and triggers is the only allowed change to the platform, and only if the platform has no audit log already. Use a read-only database user for the adapter. Soft deletes (a flag instead of a real delete) still map to a `*_deleted` event.
- **App log:** group multi-line entries (stack traces) by the timestamp at the start of a line. Ignore noise.
- **Web log:** skip static files (css, js, images).
- **One spool writer:** all adapters append through one function or process. Build the full line, write it with one write call, end with `\n`. Never truncate or rewrite the spool.
- Money and other decimals are strings. No floats anywhere in `details`. Synthetic data only in demos.

## 3. Write the profile
Copy `config.example.toml` to `config.toml` and set:
- `[profile] name`: a label for humans.
- `[profile] event_types`: leave empty to accept any snake_case name, or list the platform's names to reject anything else.
- `[node] node_id` and `[paths] spool_path`.

## 4. Acceptance test
```
python -m tools.validate_spool <spool file> --config config.toml
```
Exit code 0 on a long run of real traffic means the platform is integrated. Then start the sidecar and witness and check the verifier reports clean.

## 5. Running alongside the platform (Docker Compose)
The platform's compose file includes `defence-compose.yml` unchanged. Per platform you supply only the spool folder, the profile and the witness's list of trusted node keys.

### Images and services
- Sidecar image: `chain-of-custody-sidecar:latest` (built from `sidecar/Dockerfile`, Python 3.11)
- Witness image: `chain-of-custody-witness:latest` (built from `witness/Dockerfile`, Python 3.11)
- Compose file: `defence-compose.yml`. No keys, DBs or `config.toml` go into the images (`.dockerignore`).

### Mounts
- Spool folder (`SPOOL_DIR`, default `./spool`): read-only at `/app/spool` in the sidecar.
- Profile `config.toml`: read-only at `/app/config.toml` in both.
- `./data`: sidecar DB and node keys, at `/app/data` in the sidecar only.
- `witness-data` named volume: the witness DB, at `/app/data` in the witness only.
- `./data/witness_nodes.toml`: read-only at `/etc/coc/witness_nodes.toml` in the witness.

Keep the profile's paths relative and under `spool/` and `data/` (as in `config.example.toml`). Then the same profile works on the host and in the containers. Inside Compose the sidecar reaches the witness at `http://witness:8800`; the compose file passes that with `--witness-url`, so the profile can keep `localhost` for host runs.

### First start
1. Copy `config.example.toml` to `config.toml` and set the paths and `node_id`.
2. Create the node key: `docker compose -f defence-compose.yml run --rm --no-deps sidecar python -c "from pathlib import Path; from sidecar.keys import load_or_generate_keypair as k; print(k(Path('data/node1.key'), Path('data/node1.pub'))[1])"`
3. Write `data/witness_nodes.toml` with that key (see `witness_nodes.example.toml`). Do this before step 4: if the file is missing, Docker creates a folder with that name.
4. `docker compose -f defence-compose.yml up -d`
5. On the host: `python -m verifier --config config.toml --witness http://localhost:8800 --node-id node-1`

### Notes
- Linux hosts: the containers run as root, so files in `data/` are root-owned. Run the verifier with sudo, or `chown` the folder, or add `user: "<uid>:<gid>"` to the sidecar service. Docker Desktop (Windows, macOS) is not affected.
- Demo only: here the witness runs on the same host as the platform. A host admin could stop it or edit its volume. In real use, run the witness on a machine the platform's admins cannot reach and point `--witness-url` at it.
- When auditing, pass `--node-id` yourself instead of trusting the `node_id` in the audited host's `config.toml`. If the witness has no records for that node id, the verifier exits 2, never "clean".

## Platforms integrated so far
- Demo bank-style platform (separate repo): in progress.
