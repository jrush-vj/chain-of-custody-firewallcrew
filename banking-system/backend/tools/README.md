# Banking Chain of Custody adapter

The backend migration creates `coc_audit` and a PostgreSQL trigger for every
transaction insert, update, and delete. Run the adapter on the Ubuntu VPS as
the only writer of the defence spool:

```bash
COC_SPOOL_PATH=/srv/chain-of-custody/spool/events.jsonl \
COC_AUDIT_STATE_PATH=/srv/chain-of-custody/spool/.audit-offset \
npm run coc:spool
```

Use a database role that can only `SELECT` from `coc_audit`; it does not need
permission to mutate banking tables. The Chain of Custody sidecar mounts the
spool read-only, detects edits/deletions/reordering, and sends signed
heartbeats/checkpoints to a witness on a host the VPS administrator cannot
modify.

Do not place the witness database on the banking VPS. Vercel is suitable for
the static Hacker Agent console, but not for this long-running adapter,
sidecar, or SQLite witness.
