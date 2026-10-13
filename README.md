# Banking Security Demonstration

This repository contains the complete three-part hackathon project:

```text
banking-security-demo/
├── banking-system/   # Demo banking API, PostgreSQL, React frontend, audit events
├── defense/          # Chain of Custody sidecar, witness, verifier, and deployment
└── hacker-agent/     # Optional operator SSH console and Vercel static UI
```

## Components

### 1. Banking system

[banking-system/](./banking-system) is the demo bank:

- Express/PostgreSQL backend
- React frontend
- Deposits, withdrawals, transfers, accounts, and authentication
- `coc_audit` database evidence for transaction changes
- Audit spooler consumed by the defense sidecar

Run it with Docker Compose from the component directory:

```bash
cd banking-system
cp .env.example .env
# Set production secrets in .env
docker compose up -d --build
```

### 2. Defense

[defense/](./defense) is the tamper-evident logging system:

- Sidecar hash chain
- Signed checkpoints
- Heartbeats
- Remote witness
- Verifier and tamper-detection tests
- Railway deployment configuration
- Ubuntu systemd service files

The sidecar runs on the banking VPS. The witness should run outside that VPS;
the included Railway deployment uses a persistent volume for the witness
database. Start with [defense/docs/DEPLOYMENT_BANKING.md](./defense/docs/DEPLOYMENT_BANKING.md).

### 3. Hacker Agent

[hacker-agent/](./hacker-agent) is an optional operator console:

- SSH terminal
- Approval-based command execution
- Optional llama.cpp integration
- Static UI deployable to Vercel

It is separate from the banking and defense integrity path. Review its own
[README](./hacker-agent/README.md) before enabling it.

## Recommended deployment

```text
Ubuntu VPS
├── banking-system
├── PostgreSQL
├── audit spooler
└── defense sidecar

Railway
└── defense witness with persistent volume

Vercel
└── optional hacker-agent static console or defense dashboard
```

The witness must not run on the same VPS as the banking system if the demo is
intended to show detection against a root-level attacker. A root attacker can
otherwise stop or replace both the logs and the witness.

## Project documentation

- [System architecture](./docs/ARCHITECTURE.md)
- [Deployment guide](./docs/DEPLOYMENT.md)
- [Networking and routing](./docs/NETWORKING.md)
- [Operations and troubleshooting](./docs/OPERATIONS.md)
- [Tampering demonstration](./docs/TAMPERING_DEMO.md)
- [Defense implementation and banking integration](./defense/docs/INTEGRATION.md)

## Validation

Defense tests:

```bash
cd defense
python -m venv .venv
. .venv/Scripts/activate       # Windows
# source .venv/bin/activate    # Ubuntu
pip install -r requirements.txt
python -m pytest -q
```

The three components are intentionally independently runnable, but this root
directory is the single Git repository for the complete project.
