# v2 Plan and Methodology

These files preserve the Firewall Crew v2/v3 planning material and prototypes.
They are design inputs, not a claim that those features are deployed. The
<<<<<<< HEAD
current production-like demo in this repository is the banking app only.
=======
banking app and a separate minimal Oracle witness are demo components; actual
deployment state must be verified on the hosts.
>>>>>>> firewallcrew-publish

## Hosting decisions for this deployment

- **ct105-ai:** PostgreSQL, banking backend, and frontend. The backend and
  database are published only on loopback; the frontend is published at
  `127.0.0.1:3001`.
- **Cloudflare Tunnel:** remains the public route for `bank.jrushvj.dev` to
  `http://127.0.0.1:3001`. Tunnel credentials and DNS remain server-side and
  are never committed.
<<<<<<< HEAD
- **Oracle VPS (1 GB RAM):** keep it idle or use it only for a lightweight
  witness service if/when the defense component is reintroduced. Do not run a
  banking database, build jobs, mock attack environment, feed simulator, or
  evidence archive there.
=======
- **Oracle VPS (1 GB RAM):** use only the small standalone witness in
  [`../witness/`](../witness/) if deployed. Do not run a banking database,
  build jobs, mock attack environment, feed simulator, or evidence archive
  there.
>>>>>>> firewallcrew-publish
- **Automatic deployment:** ct105 polls this repository's `main` branch with a
  systemd timer. It rebuilds/restarts only when `banking-system/` changes.

## Revised implementation methodology

The v2 plan remains staged, rather than attempting its full threat model at
once:

1. **Banking availability:** deploy the supplied banking application, verify
   PostgreSQL readiness and backend/frontend health, then verify the public
   Cloudflare hostname.
<<<<<<< HEAD
2. **Independent witness:** reintroduce a small witness on Oracle only after a
   compatible evidence producer and protocol are implemented and tested.
   Keep the witness external to ct105's trust domain.
=======
2. **Independent witness:** the repository now contains a minimal bank-to-
   Oracle prepare/commit flow with a PostgreSQL retry outbox and a separate
   hash-chained witness ledger. It still requires deployment and end-to-end
   testing. Keep the witness external to ct105's trust domain.
>>>>>>> firewallcrew-publish
3. **Sealed chain:** specify and test canonical event encoding, integer
   smallest-unit amounts, sequence/hash continuity, signing, key rotation, and
   crash recovery.
4. **External anchoring:** add an independently authenticated anchor only
   after a threat-model review. The included Worker prototype uses KV, which
   does not provide atomic compare-and-set across concurrent requests; it must
   not be represented as a strict monotonic notary without a strongly
   consistent per-node coordinator (for example, a Durable Object).
5. **Truth checks:** add witness-side replay and state challenges, then an
   independent signed confirmation feed on a separate trust domain. Do not
   claim reconciliation against reality until that external source exists.
6. **Attack demonstrations:** add A10-A14 only with repeatable tests, clean-run
   tests, and explicitly documented limits.

## Prototype security warnings

- `cloudflare/worker-anchor/wrangler.toml` contains placeholders. Configure
  credentials using Cloudflare secrets; do not deploy placeholder keys.
- A public key is not an authentication secret. The current Worker prototype
  uses a shared header value and must be redesigned with authenticated,
  integrity-protected requests.
- `cloudflare/mock_anchor_server.py` is an in-memory offline mock, not a
  production witness or durable anchor.
- `attacks/test_a10_anchor_tamper.py` exercises the local mock and does not
  prove an actual Cloudflare Worker deployment.
<<<<<<< HEAD
=======
- The standalone Oracle witness is a hackathon/demo service. HMAC credentials
  reside on ct105 and can be read by ct105 root; a root-compromised banking
  host can suppress or forge new events. The two-phase protocol exposes
  pending outcomes but cannot make two independent databases atomically
  commit.
>>>>>>> firewallcrew-publish
- The architecture and compliance notes are planning claims, not legal advice,
  certification, or evidence of regulatory compliance.

## Source documents

<<<<<<< HEAD
=======
- [Cybersec integration handoff (2026-10-14)](./CYBERSEC_INTEGRATION_HANDOFF_2026-10-14.md)
>>>>>>> firewallcrew-publish
- [v2 architecture and build plan](./chain-of-custody-plan-v2.md)
- [Cloudflare architecture notes](./CLOUDFLARE_ARCHITECTURE.md)
- [Banking deployment and compliance notes](./BANKING_DEPLOYMENT.md)
