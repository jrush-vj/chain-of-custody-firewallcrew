# System Architecture

This project is a controlled banking-security demonstration. It has three
separate components:

```text
chain-of-custody/
├── banking-system/   Demo bank and database
├── defense/          Audit adapter, sidecar, witness, and verifier
└── hacker-agent/     Optional SSH operator console
```

The Hacker Agent is optional and is not part of the banking integrity path.

## Recommended deployment topology

```text
Internet
  │
  ├── bank.jrushvj.dev
  │      │
  │      ▼
  │  Cloudflare Tunnel
  │      │
  │      ▼
  │  Homelab container: ct105-ai
  │  ├── banking-frontend :3001 (host) → :80 (container)
  │  ├── banking-backend  :8081 (host) → :8080 (container)
  │  ├── PostgreSQL        :5432 (host, localhost only)
  │  ├── coc-spooler
  │  └── coc-sidecar
  │
  └── witness.jrushvj.dev
         │
         ▼
     Cloudflare Tunnel
         │
         ▼
     Oracle VPS
     ├── coc-witness :8800 (localhost only)
     └── persistent witness.db
```

The public banking hostname reaches only the frontend. The frontend's Nginx
configuration proxies `/api/` and `/api-docs/` to the backend over the private
Docker network.

## Evidence flow

```text
Banking transaction
  → PostgreSQL transactions table
  → coc_audit trigger
  → coc-audit-spooler
  → events.jsonl
  → sidecar hash chain
  → signed checkpoint and heartbeat
  → remote witness
```

### Banking database

The backend migration creates the `coc_audit` table and a trigger on
`transactions`. The trigger records transaction inserts, updates, and deletes.
The application database remains the source of banking state.

### Spooler

The spooler uses a read-only PostgreSQL role, reads new `coc_audit` rows, and
appends normalized JSON events to `events.jsonl`. It also stores the last audit
ID in `.audit-offset`.

The spooler is the only normal writer to the evidence spool.

### Sidecar

The sidecar runs next to the banking system. It reads the spool, stores a local
hash chain, signs checkpoints, and sends heartbeats to the witness. If an old
spool line is changed, removed, truncated, or replaced, the sidecar refuses to
continue.

### Witness

The witness runs outside the banking host's trust boundary. It stores signed
heartbeats, checkpoints, and alerts in an insert-only SQLite database. It
raises `SILENCE` when a trusted node stops sending valid heartbeats and can
display a signed `SPOOL_TAMPER` alert reported by the sidecar.

## Trust boundaries

The important security boundary is between the homelab and Oracle:

```text
Homelab attacker with root access:
  can tamper with local banking files and stop local services
  cannot directly edit the Oracle witness database
```

This is tamper evidence, not magic prevention. A root attacker can still stop
the banking application and sidecar. The remote witness preserves the fact
that heartbeats stopped or that a signed tamper alert was received.

## Keys

Each protected node has an Ed25519 key pair:

- `node1.key`: private key, kept only on the banking host.
- `node1.pub`: public key, registered in the Oracle witness.

Never copy the private key to the witness host.
