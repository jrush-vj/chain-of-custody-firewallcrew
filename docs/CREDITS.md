# Credits and third-party material

Everything below was used in this project. Code written by the team is under the
MIT licence in [LICENSE](../LICENSE).

## Repositories and projects reused

| Item | Link | What we took | Licence |
| --- | --- | --- | --- |
| Banking application | https://github.com/jtr-0901/Banking-system-fullstack | The banking app that the Layer 2 and Layer 3 demos run against, imported as `banking-system/`. Our witness integration (`banking-system/backend/services/witness*.js`) and the ct105 deploy scripts are ours. | MIT (upstream `package.json`) |
| Cybersec detection project | https://github.com/JeevikaS-19/cybersec | Linked as the `cybersec/` submodule, pinned to `73cfe0c`, not modified. Its UI is served by the witness through `witness/auditor.html`. | **No licence file upstream.** Redistribution needs the author's permission. |

## Libraries

Witness service (`witness/`): Node.js built-in modules only (`node:crypto`, `node:http`,
`node:fs`), so it has no npm dependencies. Node.js 18 or later; tested on Node 24.15.0.

Banking application: the dependencies listed in `banking-system/backend/package.json` and
`banking-system/frontend/package.json`, pinned by the lock file where one exists.

Layer 1 and Layer 2 scripts (`deploy/ct105/`): Python 3 standard library, bash, `auditd` is
not used (the honeypot wrappers replaced it), PostgreSQL client `psql`.

## Data

No public datasets are used. All demo data is generated: the traffic simulator
(`deploy/ct105/traffic/`) creates random transactions through the banking API, and the Layer 3
demo keys in `deploy/ct105/layer3/demo_keys.py` are fixed demo-only strings.

## Concepts borrowed

Hash-linked records (SHA-256 `prev_hash`, as in Bitcoin-style chains) and the idea of an
independent witness holding its own copy, from the blockchain integrity literature. No blockchain
network or library is used.
