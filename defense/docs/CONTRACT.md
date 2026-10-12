# CONTRACT v0.3 (DRAFT, awaiting platform integrator OK)

This is the only interface between the defence software (Chain of Custody) and any platform it protects. The defence is standalone and platform-agnostic: it never contains platform-specific code. A platform integrates by supplying a profile, which is a `config.toml` (section 7). The profile's collectors read the evidence the platform already leaves (log files, an audit table) and write RawEvents (section 2) to a spool file. A platform whose evidence no collector fits may write the spool with its own adapters instead. Same code and logic for every platform, only the profile differs.

The defence repo holds the master copy of this file. Platform repos (for example the demo bank platform) pin a version of it.

Changelog:
- v0.3: generic collectors shipped with the defence and configured in the profile (`[[collectors]]`, section 7), so most platforms write no code. `db_audit` supports SQLite and PostgreSQL; `access_log` can map requests to event types with `rules`. `hb_counter` counts send attempts (section 5). The verifier also reports the witness's own FORK and SEQ_ROLLBACK alerts (section 6).
- v0.2: platform-agnostic. Event types are open (any snake_case) with an optional per-profile allow-list. No floats anywhere in `details`. Added the `[profile]` config section. Two-repo change protocol.
- v0.1: first version.

## 0. Change protocol
- Nobody edits this file silently.
- To change it: edit it in the defence repo on a branch named `contract-change-<topic>`, bump the version at the top, add a changelog line, message every platform integrator with what changed and why, and merge to main only after they say OK.
- After a merge, platform repos update their pinned copy before continuing.

## 1. Time rules
- All timestamps are UTC, ISO 8601, seconds precision, with a trailing Z: `2026-10-12T09:15:30Z`.
- `ts` in an event is when it happened at the source. The witness uses its own clock for anything it records.
- All machines in the demo must sync their clocks (NTP). Clock drift causes false alarms.

## 2. RawEvent (platform -> sidecar)
The defence's collectors (section 7), or the platform's own adapters, write one JSON object per line into the spool file (path set by `spool_path` in the profile, default `spool/events.jsonl`). UTF-8, one event per line, each line ends with `\n`, the file is only ever appended to.

| field | type | rules |
|---|---|---|
| source | string | one of `app`, `db`, `host` (the layer the event came from, the same for every platform) |
| ts | string | UTC time as in section 1 |
| actor | string | user or account name, `unknown` if there is none |
| event_type | string | lowercase snake_case, matching `^[a-z][a-z0-9_]*$` |
| details | object | small JSON object. No floats anywhere inside it, at any depth: money amounts and other decimals are strings. No passwords, tokens or real personal data. |

Event types are open: any platform may use its own names. If the profile sets `[profile] event_types` to a non-empty list, only those names are valid for that profile. An empty or missing list means any snake_case name is valid.

Recommended common names (use these when they fit, so verdicts read the same across platforms):
- `app`: `login_success`, `login_failed`, `error`
- `db`: `transaction_created`, `transaction_updated`, `transaction_deleted`, `account_created`
- `host`: `http_request` (the web server access log counts as the host source for now)

Rules for the writer of the spool (collectors or adapters):
- Exactly one writer per spool: either the profile's collectors or the platform's own adapters, never both.
- Write each line with a single write call so lines never interleave.
- Never rewrite or truncate the spool while the sidecar runs.
- Order across sources is not guaranteed. The sidecar assigns the order (`seq`).
- Examples: `samples/events.sample.jsonl`

## 3. Log entry and hash chain (inside the sidecar)
The sidecar turns each RawEvent into an entry.

Entry fields: `seq` (integer, starts at 0, +1 per entry, no gaps), `ts`, `source`, `actor`, `event_type`, `details`, `prev_hash` (hex), `hash` (hex), plus `received_at` (sidecar clock, stored but not hashed in the base model).

Canonical JSON (used for everything that is hashed or signed):
- keys sorted, separators `,` and `:` with no spaces, `ensure_ascii=False`, encoded as UTF-8.
- In Python that is `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")`.

Hash rule:
- `hash = SHA-256(canonical_json({seq, ts, source, actor, event_type, details, prev_hash}))`, written as lowercase hex.
- The first entry (`seq` 0) has `prev_hash` = 64 zero characters.

### Test vectors (built from the first 5 lines of samples/events.sample.jsonl)
Canonical JSON of entry 0:
`{"actor":"asha","details":{"ip":"10.0.0.5"},"event_type":"login_success","prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","seq":0,"source":"app","ts":"2026-10-12T09:15:30Z"}`

Entry hashes:
```
seq 0  6838b198eaec15fe5a4e73266e04f912bd99c230c81dcae534fd0e3d019a8053
seq 1  75397be4962e1d5a605cf9bda41ba3cc1e6b8100b2abcc0409b96735e3d44711
seq 2  20da29a9023ae11b33d97e95c4c2563762cc51aca7dcb7964dd6f70a088e75b3
seq 3  9b6e549dae35527ebabf1a2a63160c4fce5c4419b67bae7807b0ea28f05d3a6d
seq 4  5f169c5466e1a9d2f292cd8f6c061c5915f03986deb2ac21be626e562eeaf61b
```

## 4. Merkle tree and checkpoints
Merkle tree over entry hashes, RFC 6962 style:
- leaf = `SHA-256(0x00 || entry_hash_bytes)` where `entry_hash_bytes` is the 32 bytes behind the hex hash.
- node = `SHA-256(0x01 || left || right)`.
- For `n` leaves with `n > 1`, split at `k` = the largest power of two strictly smaller than `n`: left = first `k` leaves, right = the rest. A tree with one leaf has that leaf as its root.

Root test vectors (same 5 entries, tree over the first n entries):
```
n=1  cb881caff33b24f04627fe6d753ae468524848c8b7576be108f53a7f13150127
n=2  22d0190096126edcebc54d3a8803eb2f9d65b3b47802b951fc1cebc61dfc9d62
n=3  e11816ce00bd2bce1fd4cf47d1af346d512011ee63d2b244c5574ddede44c415
n=4  eb8f45112105cceac05363584b2404429046b6cf6de1cdd8dc4af0dbe039cf6b
n=5  fa342082214823efae8212916bd68a53efa3740e65dfa7c396ef4ba71472591b
```

Checkpoint object:
```
{"node_id": "node-1", "tree_size": 50, "head_seq": 49, "head_hash": "<hex>", "root_hash": "<hex>", "ts": "<UTC>", "signature": "<hex>"}
```
- `tree_size` entries are covered (seq 0 to tree_size - 1), so `head_seq = tree_size - 1`.
- `signature` = Ed25519 signature (hex) over the canonical JSON of the object without the `signature` field.
- A checkpoint is created every `every_n` entries or every `every_s` seconds, whichever comes first, if there is at least one new entry.

## 5. Heartbeat and witness API (sidecar -> witness)
Heartbeat object, sent every `interval_s` seconds (default 30):
```
{"node_id": "node-1", "hb_counter": 17, "head_seq": 212, "head_hash": "<hex>", "tree_size": 213, "ts": "<UTC>", "signature": "<hex>"}
```
- `hb_counter` starts at 1 and increases by 1 per send attempt, so a failed send still uses up its number. The witness may therefore see gaps; a gap is not an alert. The counter never repeats or goes down. It is stored by the sidecar so it survives restarts.
- `signature` works as for checkpoints.

Witness endpoints (JSON in and out):
- `POST /heartbeat` -> `{"status": "ok"}` or `{"status": "alert", "alerts": [{"code": "...", "detail": "..."}]}`
- `POST /checkpoint` -> `{"status": "stored"}`
- `GET /heartbeats?node_id=...&limit=...`, `GET /checkpoints?node_id=...`, `GET /alerts?node_id=...`

The witness trusts only node public keys listed in its `nodes_file`. It stores every valid heartbeat and checkpoint append-only and never overwrites.

Witness alert codes:
- `BAD_SIGNATURE`: signature does not verify against the node's public key
- `COUNTER_REPLAY`: `hb_counter` is not greater than the last one seen
- `SEQ_ROLLBACK`: `head_seq` is lower than the highest seen
- `FORK`: same `head_seq` seen before with a different `head_hash`
- `SILENCE`: no valid heartbeat for more than `2 * interval_s + 15` seconds

## 6. Verifier output
Command: `python -m verifier --config config.toml [--witness URL]`

Output (JSON on stdout):
```
{"clean": false, "checked_entries": 212, "verdicts": [{"code": "EDIT", "seq_from": 17, "seq_to": 17, "detail": "..."}]}
```
Exit code: 0 clean, 1 tampering found, 2 the verifier itself failed.

Verdict codes:
- `EDIT`: stored `hash` differs from the hash recomputed from the entry's fields
- `CHAIN_BREAK`: an entry's `prev_hash` is not the previous entry's `hash`
- `SEQ_GAP`: `seq` values are not consecutive from 0 (the missing range is reported)
- `CHECKPOINT_MISMATCH`: Merkle root recomputed from local entries differs from a checkpoint's `root_hash`
- `BAD_CHECKPOINT_SIGNATURE`: a checkpoint's signature does not verify
- `TRUNCATION` (needs witness): local `head_seq` is lower than the highest `head_seq` the witness has seen. Also reported when the witness raised `SEQ_ROLLBACK` for this node
- `FORK` (needs witness): local entry hash at a `seq` the witness recorded differs from the witness's `head_hash` for that `seq`. Also reported when the witness raised `FORK` for this node
- `SILENCE` (needs witness): the witness raised a silence alert in the checked period

## 7. Config keys (the profile)
See `config.example.toml`. One `config.toml` is one platform profile. Everything platform-dependent lives here and nowhere else. Read with Python's `tomllib`. Do not rename keys without the change protocol.

`[profile]` section:
- `name` (string): a label for the platform, for humans only. The defence never branches on it.
- `event_types` (list of strings): optional allow-list as in section 2. Empty means any snake_case name.

`[paths] collector_state_dir` (string, default `data/collectors`): where collectors keep their position, one file per collector.

`[[collectors]]` (zero or more tables): each one reads one piece of platform evidence and turns it into RawEvents. All collectors of a profile run in one defence process (`coc collect`), which is the single writer of `spool_path`.

Rules for every collector:
- Read only. A collector never writes to the platform's files or database (files opened read-only, databases opened read-only).
- Keeps its position in `collector_state_dir`, so a restart neither repeats nor skips. A source file that shrinks or is replaced: loud stop, as for the spool in the base model.
- Output follows section 2 exactly. Floats from the source become strings. A record that cannot be mapped (missing timestamp, event type not snake_case, unknown field type) is skipped and counted, never rewritten into something valid; `coc check` reports the count.

Keys for every collector:
- `name` (string, unique in the profile, `^[a-z0-9_-]+$`): names its state file.
- `type` (string): `json_lines`, `access_log` or `db_audit`.
- `source` (string): `app`, `db` or `host`, as in section 2.

`type = "json_lines"` (an app log with one JSON object per line):
- `path` (string): the log file.
- `ts_field` (string): field holding the time. `ts_format` (string): `iso8601` (default), `epoch_s` or `epoch_ms`; converted to section 1 form.
- `actor_field` (string, optional): missing or empty value gives `unknown`.
- Exactly one of `event_type_field` (string, the field holding the name) or `event_type` (string, a fixed name).
- `details_fields` (list of strings): fields copied into `details`; fields missing from a record are left out.

`type = "access_log"` (web server access log):
- `path` (string). `format` (string): `combined` (the nginx and apache default) is the only format in v0.3.
- `event_type` (string, default `http_request`). `skip_static` (bool, default true): skip css, js, image and font files.
- `rules` (list of tables, optional): each has `method`, `path` (exact match, query string removed), `status` (an exact code like `"401"` or a class like `"2xx"`) and `event_type`. The first matching rule sets the event type; a line no rule matches uses `event_type`. Example: `{method = "POST", path = "/api/auth/login", status = "2xx", event_type = "login_success"}`.
- `details` holds `ip`, `method`, `path` (query string removed, as it may carry tokens) and `status`. `actor` is the log's user field, `unknown` when it is `-`. Times are converted to UTC.

`type = "db_audit"` (an audit table, filled by the platform's own triggers or audit feature):
- `driver` (string): `sqlite` or `postgres`; others are added through the change protocol.
- `sqlite`: `path` (string), the database file, opened read-only.
- `postgres`: `dsn_env` (string), the name of an environment variable holding the connection string. The password never goes in the profile. Connect as a user that can only SELECT from the audit table.
- Numeric columns are read exactly and written as strings (never through a float), as section 2 requires.
- `table` (string). `id_column` (string): an increasing integer; the collector reads rows with a higher id than the last one seen.
- `ts_column`, `actor_column`, `event_type_column` (strings), `details_columns` (list of strings).
- `poll_s` (integer, default 2).

Example:
```toml
[[collectors]]
name = "app-log"
type = "json_lines"
source = "app"
path = "/var/log/platform/app.jsonl"
ts_field = "time"
actor_field = "user"
event_type_field = "event"
details_fields = ["ip", "amount"]

[[collectors]]
name = "web"
type = "access_log"
source = "host"
path = "/var/log/nginx/access.log"
format = "combined"
```

## 8. What each side guarantees
- Platform (any integrator): evidence the profile's collectors can read (or, without collectors, valid RawEvents as in section 2 in an append-only spool), synthetic data only in demos, a profile (`config.toml`) for its deployment.
- Defence: collectors that only read the platform's evidence, a sidecar that tails the spool and never modifies it, no platform-specific code, a validator any integrator can run (`python -m tools.validate_spool <spool> [--config config.toml]`), and Docker images for the sidecar and witness.
