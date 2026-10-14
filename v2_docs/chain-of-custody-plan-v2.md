# Chain of Custody: Tamper-Evident, Truth-Checked Logging

**Hackurity 2026 · Track C · PS-6**
**Team:** Firewall Crew (3 members)
**Event:** 24-hour build. All code is written during the event; this document is pre-event planning only.
**Version:** v2 (adds witness-side reconciliation, attacks A12 to A14, three-layer structure, revised build order)

---

## 1. Goal

Detect and prove log tampering, even when the attacker has admin/root access on the platform and knows our code.

The claim is **tamper-evident and truth-checked**, not tamper-proof:
- **Tamper-evident:** any edit, deletion, gap, reordering, backdating, or full rewrite of the log is detected and provable.
- **Truth-checked:** the log is also compared against reality (the live database and an independent confirmation source), so a log that is intact but *wrong* is caught too.

> Pitch line: *Chains prove a log wasn't changed. We also prove it matches reality.*

We do not say "catches every kind of tampering." We say "catches every attack in our catalogue (section 9), and here is what we don't catch (section 3)."

---

## 2. Audience

**Primary pitch:** security and compliance teams at Indian banks and fintechs who must prove log integrity to auditors and regulators (RBI cybersecurity framework, CERT-In 2022 directions, PCI DSS), including against their own admins.

**Also applies to (one "next" slide only):** critical infrastructure, SaaS operations, incident response, audit and assurance.

**Users inside a platform:**

| User | Wants | Gets |
|---|---|---|
| SOC team | Speed: know the moment something is tampered with | SOC tab: live chain status, reconciliation status, alerts, exact entry that broke |
| Auditor | Proof: independent confirmation logs are complete, untouched, and match reality | Auditor tab: range verification, reconciliation report, export |

---

## 3. Threat model

**Assumption:** the attacker has admin, root, and local access on the platform, can read our agent's code and config, and holds the agent's *current* key.

**Trust risk points and how each is covered:**

| Risk point | Coverage |
|---|---|
| Platform admin key | Rotating keys with deletion. A stolen key cannot forge past entries. Agent generates keys; admins never handle them. |
| Platform database | Not trusted. Witness replays balances itself and spot-checks the live DB (state challenge). |
| Platform's SIEM | Not relied on. Agent streams directly to the witness. |
| Witness server | External anchors, signed receipts, multi-witness (stretch). |
| Our agent | Killing or blocking it shows up as silence. Lying through it is caught by the confirmation feed. |
| Genesis step | Assumed to happen on a clean platform. Stated explicitly. |

**Honest limits (say these in the pitch):**
- After compromise, the attacker can feed false future events through the agent. Layers 1 and 2 faithfully protect that lie. **Layer 3 is what catches it**, as long as the independent confirmation source is not also compromised.
- If the attacker controls both the platform **and** the settlement/counterparty side, reconciliation agrees with the lie. That means compromising two separate organisations.
- A root attacker can answer state challenges with a fake balance. That only holds until money actually moves out, at which point the confirmation feed disagrees.
- Guarantee: **everything up to the moment of compromise cannot be hidden or altered**, and anything the attacker does afterwards must be consistent with an outside party they don't control.
- Future work: hardware attestation (TPM).

---

## 4. Base model: three layers, three questions

| Layer | Question | Mechanisms |
|---|---|---|
| **1. Sealed chain** | Was anything changed? | Hash chain, sequence numbers, rotating Ed25519 keys, per-entry verification |
| **2. Outside witness** | Was anything removed or hidden? | Streaming to witness, heartbeats, random challenges, signed receipts, external anchors |
| **3. Truth check (our innovation)** | Does the log match reality? | Witness-side replay, state challenges, independent confirmation feed, conservation |

### 4.1 Layer 1: Sealed chain
- Every entry contains the previous entry's hash and a sequence number.
- **Rotating Ed25519 keys:** each interval the agent generates a new key pair, signs the new public key with the old private key, then deletes the old private key. The witness only holds public keys, so it can verify but never forge.
- **Canonical encoding:** sorted-key JSON, UTF-8, amounts as **integer paise**, never floats. The same entry must always produce the same bytes.

### 4.2 Layer 2: Outside witness
- Every entry streams to the witness as it is written.
- On arrival, the witness checks:
  - previous-hash link matches the last stored entry
  - valid signature under the current public key
  - sequence number is exactly last + 1
  - timestamp moves forward and is close to the witness's own receive time
  - entry or heartbeat arrived within the expected window (silence = alert)
- **Random challenges** at times the platform can't predict: "send your latest hash now." Slow or missing reply = alert.
- **Signed receipts** for every accepted entry.
- **External anchoring** of chain heads (timestamping authority, mock anchor fallback).

### 4.3 Layer 3: Truth check (the innovation)

The key rule: **no reconciliation logic runs on the platform.** The platform only supplies raw events. The witness decides.

**Check 1: Witness-side replay**
- Witness keeps its own per-account balance table, updated only from verified entries.
- The agent's `running_balance` is a *claim*. Witness compares it with its own number. Mismatch = alert pointing to the exact entry and amount.

**Check 2: State challenge (log vs reality)**
- Sent with the random challenges: "send the current database balance of account X, now." Account and timing are random.
- Agent reads the live DB and replies, signed. Witness compares with its replay.
- Catches **A12:** root edits the database directly and writes no log entry. The chain stays green; Layer 3 goes red.

**Check 3: Independent confirmation feed**
- A separate process (`feed/`) simulates the settlement/counterparty side (in real banking: NEFT/RTGS settlement, the other bank, customer statements).
- Runs on a **different laptop**, with **its own key** the platform never sees, and sends signed confirmations **straight to the witness**.
- Every platform transaction must match a confirmation, and every confirmation must match a platform transaction, within a time window.
- **Match key:** (`txn_id`, `from_account`, `to_account`, `amount_paise`).
- Catches **A13** (fabricated transaction via compromised agent), **A14** (redirection: same amount, different destination), and omission (real transaction never logged).

**Check 4: Conservation**
- Total money in the system changes only by inflows/outflows the feed confirmed. Every debit has a matching credit.
- Catches money created or destroyed by an edit, even when individual entries look fine.

**Why the attacker can't tweak Layer 3**
- All logic lives on the witness.
- Field mapping (which field is amount, account) lives in the witness profile; profile hash in heartbeats catches a local swap (A8).
- Platform key and feed key are held by parties who don't trust each other. Faking a transaction means forging both.
- Every reconciliation result is written to the witness's hash-chained admin log and anchored, so a mismatch can't be quietly deleted.

**Edge cases to model from the start** (prevents false alarms):
- Confirmation arriving before or after the platform entry: matching window, default 30 seconds.
- Reversals and refunds: their own `event_type`, referencing the original `txn_id`.
- In-flight transactions during a state challenge: the reply includes the last `seq` applied, and the witness compares against its replay at that `seq`.

---

## 5. Architecture

### 5.1 Components

- **Platform (victim):** synthetic bank producing transactions, with a real balances table.
- **Agent:** sidecar on the platform. Builds entries, signs, streams, answers challenges. One codebase; behaviour differs only by profile.
- **Witness:** separate trust domain. Verifies, stores, replays balances, reconciles, issues receipts, runs challenges, serves dashboards.
- **Feed:** independent confirmation source, separate machine and key.
- **External anchor:** public place the witness publishes chain heads to.

**Demo hardware:** laptop A = platform + agent (the attacker's machine), laptop B = witness + dashboards, laptop C = feed + red team scripts. Connected over a phone hotspot, so nothing depends on venue wifi.

### 5.2 Views

One app with **two tabs**, served from the witness side, never the platform.

| Role | Can | Cannot |
|---|---|---|
| SOC analyst | View chain and reconciliation status, inspect broken entries, acknowledge alerts with a note | Edit or delete entries, change profiles, delete alerts |
| Auditor | Read-only, run range verification, view reconciliation report, export | Acknowledge alerts, change anything |
| Witness admin | Manage profiles and accounts | Edit or delete log entries or alerts |

Rules for every role: append-only for everyone; acknowledging doesn't remove an alert; every action is recorded in the witness's own hash-chained admin log; witness admin is a different person from platform admin.

**For the build:** seed users from a config file, simple login, role check on every endpoint. MFA goes on the architecture slide.

### 5.3 Platform profiles

Authoritative copy on the witness; profile hash sent in every heartbeat. **For the build:** one hardcoded profile. Multi-platform profiles go on a slide with two example config files.

### 5.4 Setup (latching on)

1. Install agent. 2. Genesis: first key pair, register public key and profile with witness. 3. Register feed public key with witness. 4. Map events to entry schema. 5. Set policies. 6. Create SOC and auditor accounts.

---

## 6. If the witness is compromised

- External anchors: anchored history can't be rewritten.
- Signed receipts: if the witness rewrites history, its own receipts contradict it.
- The feed keeps its own copy of confirmations: an independent record the witness can't rewrite.
- Multi-witness: stretch / slide only.

To hide tampering, an attacker now needs the platform, the witness, the anchor, and the feed.

---

## 7. Firewall and network

- Witness inbound: only registered agents and the feed. Mutual TLS if time allows; otherwise signed messages plus an IP allowlist.
- Agent pins the witness certificate.
- Doesn't protect the platform (root controls its firewall); blocking the agent shows up as silence.
- Routing/config changes are logged as events and alert signals, not treated as a defence.

---

## 8. Extra detection: attacker's digital trail (overnight, only if stable)

Capture logins, failed logins, privilege escalation, agent stopped, log/config modified, unusual outbound connections. Entries stream immediately, so disabling logging gets logged first. On Windows, capture at app level or run in Docker/WSL.

---

## 9. Attack catalogue (red team)

| # | Attack | Caught by | Layer |
|---|---|---|---|
| A1 | Edit a stored entry | Chain break + replay mismatch | 1, 3 |
| A2 | Delete entries from the middle | Sequence gap + chain break | 1 |
| A3 | Truncate the latest entries | Witness copy + receipts | 2 |
| A4 | Kill / block the agent | Silence: missed challenge + heartbeat | 2 |
| A5 | Backdate a timestamp | Witness receive time vs entry time | 2 |
| A6 | Change an amount only | Chain break + replay mismatch | 1, 3 |
| A7 | Rewrite the whole local chain | Witness copy + anchors | 2 |
| A8 | Turn off checks in local profile | Profile hash mismatch | 2 |
| A9 | Steal current key, forge old entries | Old keys deleted, rotation chain | 1 |
| A10 | Compromised witness rewrites history | Receipts + anchors + feed copy | 2, 3 |
| A11 | Stop logging / tamper with config | System events captured first | 2 |
| **A12** | **Edit DB balance directly, no log entry** | **State challenge vs replay** | **3 only** |
| **A13** | **Fabricated transaction via compromised agent** | **No matching feed confirmation** | **3 only** |
| **A14** | **Redirect: same amount, different destination** | **Feed match on accounts + per-account replay** | **3 only** |

A12 to A14 are the attacks only we catch. They lead the demo.

### Demo order (5 minutes)

1. Transactions flowing; all three layers green.
2. **A1:** edit an entry. Layer 1 red. ("Everyone catches this.")
3. **A4:** kill the agent. Layer 2 red within seconds.
4. **A12:** run an UPDATE on the balances table. Layer 1 and 2 stay **green**. Layer 3 goes **red**. ("Every other system just missed this.")
5. **A13:** push a fake withdrawal through the agent, correctly signed. Layer 3 red: no settlement confirmation.
6. Auditor tab: export the report showing all of it.

Backup: a screen recording of the full run, made during the last rehearsal.

---

## 10. Build plan by round

Event starts 8:00 AM. Fill in Round 2 and Final times once confirmed.

**Golden rule:** at each checkpoint, if it isn't working, cut scope. `main` is always demoable.

### Round 1: Layers 1 + 3 core (8:00 AM to 3:00 PM)

**Target:** an attack happens and the SOC tab catches it, including one attack only Layer 3 catches.

| Time | Defence (Jeev) | Platform (Jaganath) | Red team (3rd member) |
|---|---|---|---|
| 8:00 to 8:30 | Repo, CLAUDE.md, confirm spec | Repo, confirm spec | Confirm attack list, demo script |
| 8:30 to 11:00 | Agent: entry builder, canonical encoding, hash chain, seq, Ed25519 (single key), streaming | Synthetic bank with real balances table, transactions in integer paise; DB read endpoint for agent | Attack scripts A1, A2, A4, A12 |
| 11:00 | **Checkpoint 1:** platform → agent → witness entries flowing | | |
| 11:00 to 1:30 | Witness: per-entry verification, storage, heartbeat + silence alert, **replay table (Check 1)** | Basic SOC tab: chain status, reconciliation status, alert list | Clean-run test: 10,000 transactions, zero alerts required |
| 1:30 | **Checkpoint 2:** A1, A2, A4 caught | | |
| 1:30 to 2:30 | **State challenge for one random account (Check 2)** | Polish SOC tab | A12 against state challenge; rehearse |
| 2:30 to 3:00 | **Feature freeze. Demo rehearsal.** | | |

**Round 1 demo:** flowing → A1 edit caught → A4 silence → **A12 DB edit caught only by Layer 3.**

If behind at 1:30: drop the state challenge to Round 2, and demo A1, A4, and replay mismatch on A6.

### Round 2: Truth feed + witness can't cheat

In priority order. Stop adding when time runs out.

1. **Confirmation feed (Check 3)** on laptop C, own key, matching window (A13, A14). Owner: 3rd member builds `feed/`, Jeev wires matching into witness.
2. Conservation check (Check 4).
3. Key rotation with deletion (A9).
4. Signed receipts.
5. Random challenge timing (replace fixed heartbeat).
6. Auditor tab: range verification, reconciliation report, export (this replaces the standalone verifier).
7. External anchoring (mock fallback ready) + A10 scenario.
8. Timestamp check (A5).

**Round 2 demo:** the full demo order from section 9.

### Final: overnight, only if Round 2 is stable
- System events (A11)
- Pinned witness cert + allowlist
- UI polish, readable alerts

**Last 3 hours before final:** feature freeze, full attack suite, clean-run test, rehearse twice, record backup video, finish slides, sleep in shifts.

### Slide only (not built)
Multi-platform profiles (A8 shown as config files), multi-witness, TPM, real DB change-capture hooks, full mTLS, MFA.

---

## 11. Stack

- Python, FastAPI, SQLite
- `cryptography` library for Ed25519 and SHA-256
- Dashboard: simple HTML or Streamlit (one app, two tabs)
- Folders: `victim/`, `agent/`, `witness/`, `feed/`, `attacks/`
- `feed/` never imports from `victim/`.

---

## 12. Interfaces to agree on before the event

**Log entry fields**
- `seq`, `timestamp`, `event_type` (transaction / reversal / system / heartbeat)
- `payload`: `txn_id`, `from_account`, `to_account`, `amount_paise` (int)
- `running_balance_paise` (claim only, witness doesn't trust it)
- `prev_hash`, `key_id`, `signature`
- `hash`: SHA-256 of canonical encoding of all fields except `signature`

**Feed confirmation fields**
- `txn_id`, `from_account`, `to_account`, `amount_paise`, `confirmed_at`, `feed_signature`

**Agent ↔ witness API**
- register (genesis: public key + profile)
- submit entry → signed receipt
- heartbeat (includes profile hash)
- challenge: latest hash → response
- **state challenge: `{account}` → `{account, balance_paise, last_seq, signature}`**
- key rotation (new public key signed by old)

**Feed → witness API**
- register feed public key
- submit confirmation

**Witness → dashboards**
- chain status, reconciliation status, alerts, entry lookup, range verification, report export

---

## 13. Working process

**Roles**
- **Jeev:** agent, witness core, cryptography, reconciliation logic
- **Jaganath:** platform first, dashboards once platform is stable
- **3rd member:** attack scripts, feed, clean-run tests, demo script, slides

**AI tools**
- Claude Code Pro (two accounts), limits reset roughly every 5 hours. Stagger heavy sessions.
- Well-scoped prompts citing this spec ("implement state challenge per section 12").
- Gemini in Antigravity as overflow.
- Review priority: crypto and reconciliation code always reviewed; UI code only if broken.
- CLAUDE.md / AGENTS.md holds this spec, stack, folder layout.
- Two AI agents never edit the same folder at once.

**Discipline**
- Checkpoint every ~4 hours. Time-box risky items to 45 minutes, then fallback/mock.
- Full attack suite + clean-run test after every merge.

---

## 14. Pitch outline (7 slides)

1. **Hook:** a bank insider edits a balance at 2 a.m. Logs are the only evidence, and the attacker controls them.
2. **Insight:** a log can't protect itself on a machine the attacker owns. It must prove itself to someone outside, and match reality.
3. **Three layers, three questions** (table from section 4).
4. **Live demo** (section 9 order).
5. **What makes us different:** A12 to A14, caught by no hash chain.
6. **Honest limits** (section 3) + future work.
7. **Who first:** Indian bank/fintech compliance (RBI, CERT-In, PCI DSS). Other industries: one line.

**Rehearse these judge questions:**
- "What if root changes data before you log it?" → Layer 3, feed.
- "How is your balance check different from the hash chain?" → it checks against sources the platform doesn't control; demo A12.
- "What if the witness is compromised?" → receipts, anchors, feed copy.
- "What can't you catch?" → platform + settlement both compromised.

---

## 15. Pre-event checklist

- [ ] Confirm rules allow pre-written docs being fed to AI tools
- [ ] Confirm judging rubric if published; adjust demo/pitch weighting
- [ ] Finalise section 12 with all three members
- [ ] Task list per person, in priority order
- [ ] CLAUDE.md / AGENTS.md written
- [ ] Paper walkthrough: A12 through Check 2, A13 through Check 3
- [ ] Attack list and demo script per round
- [ ] Pitch slides + architecture diagram
- [ ] Pick timestamping authority, test manually
- [ ] Three laptops + phone hotspot confirmed
- [ ] Fill in Round 2 and Final times
- [ ] Prep time scheduled separately from HACKFEST Round 1 (due Oct 18)

---

## 16. Dropped or reframed ideas

| Idea | Outcome |
|---|---|
| Encrypting data in transit to hide keys | Replaced by signatures. TLS covers encryption. |
| Scrambling timestamps | Replaced by timestamps in hashed entry + witness receive time. |
| Routing table detection | Alert signal only. |
| HMAC key ratchet | Replaced by rotating Ed25519 keys. |
| "Near impossible to edit" / "catch every kind" | Reframed as "detected, provable, and checked against reality." |
| Running balance computed on platform as the checksum | Reframed: witness replays balances itself; platform balance is only a claim. |
| Separate SOC and auditor apps | One app, two tabs. |
| Standalone verifier script | Folded into auditor export. |
| Multi-platform profiles built | Slide only; one hardcoded profile. |
