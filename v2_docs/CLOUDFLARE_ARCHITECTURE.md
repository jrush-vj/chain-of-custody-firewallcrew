# Cloudflare Architecture Guide: Chain of Custody

This document details how Cloudflare services transform **Chain of Custody** from a local demo into a tamper-evident, enterprise-ready banking security system.

---

## 1. The Core Problem Cloudflare Solves

In `chain-of-custody-plan-v2.md`:
> *"Chains prove a log wasn't changed. We also prove it matches reality."*
> *"Assumption: the attacker has admin, root, and local access on the platform, can read our agent's code and config, and holds the agent's current key."*

Even with Layer 1 (Sealed Chain), Layer 2 (Outside Witness), and Layer 3 (Truth Check), two major vulnerabilities remain if infrastructure is self-hosted naively:
1. **Attack A10 (Compromised Witness):** If the attacker also gains root access to the Witness server, what stops them from rewriting the witness SQLite database?
2. **Venue / Network Isolation:** In a 3-laptop hackathon setup (or bank branch to data-center link), firewalls, NAT, and Wi-Fi client isolation block inbound connections.
3. **Regulatory Long-Term Retention Costs:** Indian banks subject to CERT-In (180 days) and PCI DSS (12 months) face massive bandwidth egress penalties on AWS S3 / Azure Blob when exporting high-volume forensic logs.

---

## 2. Cloudflare Service Breakdown

### 2.1 Public Cryptographic Anchor (Cloudflare Workers + KV)
- **Role:** Third-party public notary.
- **How it works:**
  - Witness periodically hashes its current chain head and submits `{seq, chain_head, timestamp, signature}` to the Cloudflare Worker (`POST /anchor`).
  - Worker enforces **strict monotonicity** (`seq > latest_seq`) so past anchors cannot be modified or replaced.
  - The hash is replicated globally across Cloudflare's edge network (300+ cities).
- **Attack Defeated:** **A10 (Compromised Witness rewrites history)**. If an insider rewrites the witness store, any auditor running `GET /verify?seq=X&hash=H` immediately detects a **split-view divergence**.

### 2.2 Cloudflare Tunnel (`cloudflared`)
- **Role:** Zero-trust perimeter for Witness & Dashboards.
- **How it works:**
  - Witness on Laptop B creates an outbound encrypted tunnel to Cloudflare Edge.
  - No inbound ports are opened. No firewall rules or router port forwarding needed.
  - Laptop A (Agent) and Laptop C (Feed) stream events securely over standard HTTPS.
  - Judges can access the Auditor tab directly from their phones.

### 2.3 Cloudflare R2: WORM Evidence Vault (Object Lock)
- **Role:** Regulatory tamper-proof storage tier.
- **Banking Drivers:**
  - **CERT-In Directions 2022:** 180-day rolling log retention within Indian jurisdiction.
  - **PCI DSS v4.0.1 Req 10.5.1:** 12 months retention, 3 months immediately searchable.
- **Why R2 over AWS S3:**
  - **Compliance-Mode Object Lock:** Even bucket owners/admins cannot delete or modify log bundles before the retention date expires.
  - **Zero Egress Fees:** Banks downloading tens of gigabytes for forensics during a 6-hour CERT-In mandatory report pay **\$0 in bandwidth egress costs**.
  - **India Data Jurisdiction:** R2 supports jurisdictional placement to ensure logs remain strictly within Indian borders.

### 2.4 Cloudflare Time Services (NTS & Roughtime)
- **Role:** Cryptographically authenticated clock synchronization (`time.cloudflare.com`).
- **Attack Defeated:** **A5 (Backdating a timestamp)** and NTP spoofing. Fulfills CERT-In mandate for clock synchronization to authorized atomic/NTP references.

### 2.5 Cloudflare Access & API Shield
- **Role:** Zero Trust RBAC for SOC vs. Auditor tabs.
- **Compliance:** Satisfies **PCI DSS 10.2.1.3** ("all access to audit logs recorded") with SSO and hardware FIDO2 MFA. Sysadmins have zero access to audit views.

---

## 3. Red Team Attack Catalogue: Cloudflare Defense Matrix

| Attack # | Attack Name | Standard Defense | Cloudflare Enhanced Defense |
| :--- | :--- | :--- | :--- |
| **A4** | Kill / block the agent | Witness silence alert | Cloudflare edge telemetry logs TCP disconnects instantly; DDoS rate limiting prevents flooding. |
| **A5** | Backdate a timestamp | Witness receive time check | Agent and Witness sync to Cloudflare NTS (`time.cloudflare.com`) + edge timestamping header. |
| **A7** | Rewrite whole local chain | Witness copy + receipts | Witness head is public on Cloudflare Worker KV; local rewrite is instantly exposed. |
| **A10** | **Compromised witness rewrites history** | **Signed receipts only** | **Cloudflare Public Anchor Worker:** Monotonic KV store proves past chain state; divergence triggers instant alert. |

---

## 4. Pitch & Presentation Highlights (For Judges)

1. **"What if your witness gets hacked?"**
   *Answer:* "We anchor every chain head to a public Cloudflare Worker running an append-only notary. The moment anyone alters the witness database, the auditor dashboard pulls the Cloudflare anchor and flags a Split-View Contradiction (Attack A10). To forge logs, an attacker would have to hack Cloudflare's global edge network."

2. **"How do you handle CERT-In 180-day and PCI DSS 12-month compliance without huge cloud bills?"**
   *Answer:* "We stream evidence bundles directly into Cloudflare R2 with WORM Object Lock in Compliance Mode within the India jurisdiction. Unlike AWS S3 which charges steep egress fees when regulators request forensic bundles, R2 offers zero egress fees."

3. **"How does the demo run seamlessly across 3 separate laptops?"**
   *Answer:* "We use Cloudflare Tunnel. Laptop B connects outbound to Cloudflare; the Agent and Feed stream over end-to-end HTTPS with zero open inbound ports and zero Wi-Fi firewall dependencies."
