# Guard: alarm classification, soft containment, incident reports

Everything here is **off unless enabled**. With no guard settings the witness behaves exactly as before.
Nothing in this folder touches the existing Layer 1/2/3 code, the quarantine and lockout code, or the
dashboard page (`auditor.html`). It is reached through an API only.

## Turn it on

Witness (the machine running `witness/server.js`):

| Variable | Default | Meaning |
|---|---|---|
| `GUARD_ENABLED` | off | `1` turns the guard on |
| `APPROVERS` | none | JSON list of approvers (below). With none, every approval is refused |
| `FLAP_MAX` / `FLAP_WINDOW_S` | 3 / 900 | this many link drops inside the window = UNSTABLE |
| `CONTAIN_TAMPER_TIMEOUT_S` | 120 | countdown before an unanswered tamper incident orders the quarantine |
| `CONTAIN_AMBIG_TIMEOUT_S` | 900 | countdown for ambiguous evidence; on timeout it stays sealed |
| `BOB_ENABLED` | off | master switch for every Bob feature (see below) |
| `REPORT_NARRATIVE` | `off` | `off`, `bob_on_demand`, `bob_auto` (the Bob modes need `BOB_ENABLED=1`) |

Bank host (the machine running `deploy/ct105/layer1/monitor.py`): set `COC_GUARD=1`. Then silence reports
"sealed" instead of quarantining the host, and the host carries out only a quarantine the witness orders.
A changed witness link setting still triggers Layer 3 directly.

## Approvers: make a token

An approver is an id plus the SHA-256 of a secret token. Only the hash is configured.

```bash
# 1. make a token and keep it somewhere safe (it is the approver's password)
TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
# 2. hash it
HASH=$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)
# 3. configure the witness (more approvers = more objects in the list)
export APPROVERS="[{\"id\":\"soc-lead\",\"sha256\":\"$HASH\"}]"
```

Never put an approver token on the protected host.

## API

| Call | Auth | Purpose |
|---|---|---|
| `GET /guard/state` | none | incidents and their states, Bob/narrative settings |
| `POST /guard/approvals/<incident>` body `{"choice":"approve"\|"deny"\|"extend"}` | `Authorization: Bearer <token>` + `X-Approver: <id>` | decide a PENDING incident; recorded in the ledger |
| `GET /guard/reports`, `GET /guard/reports/<id>` | none | reports; one that fails verification is never served |
| `POST /guard/incidents/<incident>/report` | approver | build a report now (concluded incidents get one automatically) |
| `GET /v1/guard-decision`, `POST /v1/guard-ack` | signed (the box) | the box polls for a quarantine order |

## States

`SEALED` (unverified, no lockout) → `PENDING` (a human decides, with a countdown) → `QUARANTINED`
(the existing quarantine is ordered). `RESUMED` after a verified clean reconnect. `UNSTABLE` when the link
flaps: nothing automatic until a human clears it. Sealing is a recorded state; it does not yet block
privileged actions on the host.

## Incident reports

A report needs no key and no network. Every number comes from the witness's own ledger or the classifier;
text from the host (summaries, command arguments) is never copied in. Each report is stored in the ledger.
Check one independently, with no witness running:

```bash
node witness/guard/report/verify-cli.js /var/lib/banking-witness/ledger.jsonl report.json
```

## Bob

`BOB_ENABLED` is the master switch. With the guard on and `BOB_ENABLED` unset, Bob is **off**: the
"Diagnose with Bob" request is refused (HTTP 403) and `GET /guard/state` reports `bob_enabled: false`.
With the guard off, behaviour is as before unless `BOB_ENABLED=0`. The classifier, containment and
approvals never depend on Bob.
