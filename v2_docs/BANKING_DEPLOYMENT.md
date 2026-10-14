# Chain of Custody v3: Banking Deployment Guide

How to take the three-layer tamper-evident logging system from the hackathon demo into an Indian bank.

> This guide is a technical starting point, not legal advice. Every bank's compliance and IS audit team must confirm the exact obligations that apply to it before go-live.

---

## 1\. Why banks need this

Banks are already required to keep logs. What they struggle to prove is that **nobody changed those logs**, especially a privileged insider or an attacker with stolen admin credentials. Chain of Custody answers that: every change is detected by a witness the attacker does not control, and the original survives in a vault nobody can delete from.

## 2\. Regulatory drivers

| Source | What it asks for | How Chain of Custody helps |
| :---- | :---- | :---- |
| **CERT-In Directions, 28 April 2022** | Logs of all ICT systems kept for a rolling **180 days within Indian jurisdiction**, shared with CERT-In on request; notified incidents reported within **6 hours**; clocks synced to NIC/NPL time sources | Vault in an India region with locked retention; evidence bundles ready to hand over; timestamps from synced clocks |
| **RBI Master Direction on IT Governance, Risk, Controls and Assurance Practices (2023, effective 1 April 2024\)** | Audit trails detailed enough for forensics; the bank's IT policy sets how long audit trails are preserved; regular monitoring of audit trails and system logs | Signed, hash-chained trails; continuous witness verification; SOC timeline |
| **RBI Cyber Security Framework for Banks (2016)** | Baseline controls including maintenance, monitoring and analysis of audit logs, and audit log settings | Layer 1 and auditd backstop; centralized evidence |
| **PCI DSS v4.0.1, Requirement 10** (if the bank handles card data) | Audit logs protected from modification (10.3); **all access to audit logs** recorded (10.2.1.3); automated log review (10.4.1.1); **12 months** retention with the latest **3 months immediately available** (10.5.1); time sync (10.6) | Layer 1 trips on any access to logs; tamper evidence; tiered retention |

**Retention to configure:** take the strictest applicable rule. For a card-handling bank that means **at least 12 months**, the most recent 3 months searchable immediately, and a copy always held in India.

## 3\. Production architecture

The demo runs everything in Docker on one laptop. In a bank, each component sits in a **separate trust domain** so no single compromised account reaches all of them.

 Source systems                Log tier                 Independent tier

 ─────────────                 ────────                 ────────────────

 Core banking (CBS)  ─┐

 Payment switch       ├─► Log servers \+ agent ──┬──► Witness (run by IS Audit)

 (UPI/IMPS/NEFT/RTGS) │   (3 layers active)     │

 ATM / card systems   │                         ├──► Evidence Vault (WORM, India region,

 Internet / mobile    │                         │     DR site copy)

 banking auth         │                         │

 DB \+ privileged      ┘                         └──► Bank SIEM (layer events as

 access tools                                         high-severity alerts)

**Placement rules**

- **Log servers** in the production zone, managed by IT operations.
- **Witness** in a separate network segment or separate cloud account, **operated by Internal / IS Audit**, not IT. No SSH. Only the heartbeat/challenge API is reachable.
- **Evidence vault** on immutable storage (S3 Object Lock in compliance mode, Azure immutable blob, or an on-prem WORM appliance), in an **India region**, replicated to the DR site. Owned by a different team than the log servers.
- **SIEM integration**: layer events are forwarded to the bank's existing SIEM so the SOC works in one tool. Chain of Custody complements the SIEM; it does not replace it.

**Infrastructure differences from the demo**

| Demo | Production |
| :---- | :---- |
| Docker containers on one host | Separate hardened VMs or a Kubernetes cluster with admission policies |
| MinIO | Cloud immutable storage or WORM appliance |
| Shares stored in files | Shares held by separate people, on smart cards or in separate HSM partitions |
| Signing keys on disk | Keys in an HSM |
| Attacker container | Red team / VAPT exercise |

## 4\. Mapping roles to a bank

| Chain of Custody role | Typical bank owner | Access |
| :---- | :---- | :---- |
| Sysadmin | IT operations / infrastructure team | Manages log servers through a bastion with MFA and session recording. Limited sudo. **Cannot** write to log files |
| SOC | Bank SOC (in-house or MSSP) | View, search, investigate, trigger break glass. Cannot edit |
| Auditor | Internal IS Audit / concurrent auditor | Reads evidence bundles, verifies signatures and chain, holds an unlock share |
| Witness operator | IS Audit or a trusted third party | Runs the witness; no one from IT operations has access |
| Split-key holders (2 of 3\) | Suggested: CISO, Head of Internal Audit, Chief Compliance Officer | Unlock after a break-glass freeze |

Keep the split-key holders in **different reporting lines** so no single department can unlock alone.

## 5\. Layer configuration for banking

### Layer 1: custom command tripwire

- Deploy on **log servers only**, not on CBS application servers where operations staff work daily.
- Add banking-relevant commands to the tripwire list, in addition to editors and file tools: database clients (`sqlplus`, `psql`, `mysql`), `ausearch`/`auditctl`, and any log export tools.
- Every access to log files is recorded, which directly supports PCI DSS 10.2.1.3.
- Revert-key use is itself an alert to the SOC and is reviewed by IS Audit.
- **Start in alert-only mode** (do not block) during the pilot to measure false positives.

### Layer 2: heartbeat \+ checksum (from v2)

- **Amount/balance reconciliation checksum** is the strongest fit for banking: if a transaction log entry is changed, running totals no longer reconcile against CBS balances.
- Heartbeat interval should be tuned to how often logs are written; random challenges should be frequent enough that a gap is caught within minutes.
- Direct writes caught by auditd go to Layer 2 immediately rather than waiting for the next heartbeat.

### Layer 3: break glass

**Critical banking rule: break glass freezes the log tier, never the business.** A bank cannot stop UPI, ATM or CBS transactions because a log server was tampered with.

- **Scope of the freeze:** log servers and the log store only. Source systems keep running and keep writing to a standby log path or directly to the vault.
- **Triggers:** admin lockout signals, escalation from Layer 2, manual SOC panic button.
- **Order:** capture, push evidence, isolate, freeze, lock out. Never reboot.
- **Unlock:** 2 of 3 holders, entered through the witness/dashboard, never on the frozen server.
- **Test it in DR drills** and record recovery time against the bank's RTO for the logging service.
- Document how break glass interacts with the bank's **Business Continuity / DR plan**, as required under the RBI Master Direction.

## 6\. Retention and storage

| Tier | Period | Storage | Purpose |
| :---- | :---- | :---- | :---- |
| Hot | Latest 3 months | Searchable store / SIEM | Investigation, PCI "immediately available" |
| Warm/cold | Up to 12 months or the bank's policy period, whichever is longer | Immutable object storage, India region | Regulatory retention, CERT-In requests |
| Evidence bundles | Per legal hold, often years | Separate locked bucket | Forensics, legal proceedings |

- **Compliance-mode retention**, so not even the vault administrator can delete early.
- Encrypt at rest with keys in an HSM or cloud KMS.
- **Time sync** all components to NIC/NPL NTP sources, since evidence timelines depend on consistent clocks.

## 7\. Incident response flow

1. A layer fires and the evidence bundle reaches the vault; the alert reaches the SOC and SIEM.
2. **SOC triage**: confirm it is real tampering, not a misconfigured job.
3. If confirmed: open an incident, escalate to the CISO.
4. **Regulatory reporting**: CERT-In within 6 hours of noticing a reportable incident, and RBI reporting per the bank's current RBI instructions.
5. **Forensics**: export the evidence bundles (before, after, diff, who, source IP, auditd records) with signature verification results. The auditor view produces a verification report for each bundle.
6. Lessons learned: tune Layer 1 lists and Layer 2 thresholds.

## 8\. Rollout plan

| Phase | Scope | Mode | Exit criteria |
| :---- | :---- | :---- | :---- |
| 1\. Pilot | One non-critical system's logs | Alert only, no blocking, no break glass | False-positive rate acceptable to SOC |
| 2\. Shadow | Add CBS and payment logs | Alert only, break glass in manual mode | Witness and vault stable; IS Audit reviews bundles |
| 3\. Enforce | Same scope | Layer 1 blocks, break glass automatic on admin lockout | Successful DR drill including unlock |
| 4\. Expand | All in-scope ICT systems | Full | VAPT passed, IS Audit sign-off |

Each phase goes through the bank's **change management** process. Run a **VAPT** and an **IS audit** before Phase 3\.

## 9\. Pre-go-live checklist

- [ ] Compliance team confirmed applicable rules and retention period
- [ ] Witness operated by a team independent of IT operations
- [ ] Vault in India region, compliance-mode retention, DR copy
- [ ] Log server credential can only write to the vault (no read, no delete)
- [ ] Log files owned by a dedicated service user; sysadmin cannot write to them
- [ ] Sudo list reviewed against shell-escape commands
- [ ] auditd rules locked (`-e 2`); agent processes excluded from tripwires
- [ ] Append-only attribute set and the capability to remove it dropped
- [ ] Signing keys in HSM; split-key shares issued to three holders in different reporting lines
- [ ] Break glass scoped to log tier only; tested in DR drill
- [ ] Clocks synced to NIC/NPL NTP
- [ ] SIEM receiving layer events; SOC runbook written
- [ ] CERT-In and RBI reporting procedure linked to the incident runbook
- [ ] VAPT completed; IS audit sign-off

## 10\. Known limitations to state openly

- An attacker with full control of a log server can stop the agent. The witness detects this through missed heartbeats, and everything streamed before that point is safe in the vault.
- If the network is cut before an evidence bundle is pushed, that bundle may be delayed or lost. **Local encrypted buffering is still an open design decision.**
- Layer 1 wrappers are a detection aid; enforcement comes from auditd, file permissions and append-only storage.
- The system proves logs were not changed. It does not prove the original entries were truthful when written; that depends on the source application.

## Sources

- [CERT-In Directions, 28 April 2022 (overview, Mondaq)](https://www.mondaq.com/india/security/1191962/an-overview-on-the-cert-in-cyber-security-directions-2022)
- [CERT-In directions: 6-hour reporting, 180-day logs, NTP sync (TCSA)](https://www.tcsa.in/frameworks/iso-27001/for-cert-in)
- [CERT-In logs stored abroad need an India copy (ManageEngine)](https://www.manageengine.com/log-management/cyber-security/cert-in-compliance-for-indian-enterprises.html)
- [RBI Master Direction on IT Governance, Risk, Controls and Assurance Practices (RBI PDF)](https://website.rbi.org.in/documents/87730/39710850/Master+Directions+-+IT+Governance+and+Practices+-FINAL.pdf)
- [RBI IT GRC directions effective 1 April 2024, audit trail clauses (ManageEngine ebook)](https://download.manageengine.com/products/desktop-central/how-endpoint-central-helps-you-meet-rbi-it-grc-directives-ebook.pdf)
- [RBI Cyber Security Framework and ITGRCA clause map (Open Security Architecture)](https://opensecurityarchitecture.org/frameworks/rbi-csf)
- [PCI DSS Requirement 10 in v4.0.1 (Motadata)](https://www.motadata.com/blog/pci-dss-requirement-10)
- [PCI DSS 10.5.1 retention (AWS PCI maturity model)](https://pci-maturitymodel.security.aws.dev/en/recommendation/r10.2/)