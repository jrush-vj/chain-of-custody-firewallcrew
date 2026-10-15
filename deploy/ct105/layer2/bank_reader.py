"""Read-only view of the bank's transactions for the witness sync (ct105).

Reads ONLY these columns of the `transactions` table, through the read-only `coc_reader` database
role: id, type, amount, status, from_account_id, to_account_id, timestamp. That role is granted
SELECT on exactly those columns, so names, IBANs, account numbers and the reference text cannot be
read through it at all. Every query is built from integers this module generates; nothing from the
database or the network is ever placed into SQL.

The hashes it computes match the witness's (witness/records.js): both hash the same canonical text.
Standard library only; it talks to the database with `docker exec ... psql`.

Environment: COC_PG_CONTAINER (default banking-postgres), COC_DB_NAME (bankingsystem),
COC_DB_ROLE (coc_reader).
"""

import hashlib
import os
import subprocess

CONTAINER = os.environ.get("COC_PG_CONTAINER", "banking-postgres")
DATABASE = os.environ.get("COC_DB_NAME", "bankingsystem")
ROLE = os.environ.get("COC_DB_ROLE", "coc_reader")
COLUMNS = 'id, type, amount::text, status, from_account_id, to_account_id, "timestamp"::text'
SWEEP_SIZE = 50
RANGES_LIMIT = 3900  # the witness accepts at most 4000 characters


class BankReadError(Exception):
    pass


def psql(sql):
    """Run one read-only query and return its output as text."""
    command = ["docker", "exec", "-i", CONTAINER, "psql", "-U", ROLE, "-d", DATABASE,
               "-X", "-q", "-t", "-A", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", sql]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError) as error:
        raise BankReadError(f"could not run docker: {error}") from error
    if result.returncode != 0:
        raise BankReadError(result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "psql failed")
    return result.stdout


def all_ids():
    return sorted(int(line) for line in psql("SELECT id FROM transactions ORDER BY id").splitlines() if line.strip())


def rows_by_ids(ids):
    """The allowlisted columns of the given transactions, as dicts. ids must be integers."""
    wanted = [int(i) for i in ids]
    if not wanted:
        return []
    output = psql(f"SELECT {COLUMNS} FROM transactions WHERE id IN ({','.join(str(i) for i in wanted)}) ORDER BY id")
    rows = []
    for line in output.splitlines():
        if not line.strip():
            continue
        parts = line.split("|")
        if len(parts) != 7:
            raise BankReadError("unexpected row shape from the database")
        rows.append({
            "id": int(parts[0]),
            "type": parts[1],
            "amount": parts[2],
            "status": parts[3],
            "from_account_id": int(parts[4]) if parts[4] else None,
            "to_account_id": int(parts[5]) if parts[5] else None,
            "timestamp": parts[6],
        })
    return rows


def canonical(row):
    """One fixed text form of a row. witness/records.js builds the same text."""
    return "|".join(str(part) for part in (
        row["id"], row["type"], row["amount"], row["status"],
        "" if row["from_account_id"] is None else row["from_account_id"],
        "" if row["to_account_id"] is None else row["to_account_id"],
        row["timestamp"]))


def row_hash(row):
    return hashlib.sha256(canonical(row).encode("utf-8")).hexdigest()[:32]


def to_ranges(ids):
    """[1,2,3,5,6,9] -> '1-3,5-6,9'."""
    parts, ids = [], sorted(ids)
    index = 0
    while index < len(ids):
        end = index
        while end + 1 < len(ids) and ids[end + 1] == ids[end] + 1:
            end += 1
        parts.append(str(ids[index]) if end == index else f"{ids[index]}-{ids[end]}")
        index = end + 1
    return ",".join(parts)


def build_view(position=0, size=SWEEP_SIZE):
    """The summary a heartbeat carries, and where the rotating sample resumes next time.

    The summary is: how many rows, the largest id, every id as ranges, and a hash for `size` rows
    starting at `position` in id order (wrapping round), so every row is checked in turn."""
    ids = all_ids()
    ranges = to_ranges(ids)
    if len(ranges) > RANGES_LIMIT:
        raise BankReadError("too many gaps in the transaction ids to summarise")
    sample = []
    if ids:
        start = position % len(ids)
        sample = [ids[(start + step) % len(ids)] for step in range(min(size, len(ids)))]
    sweep = [[row["id"], row_hash(row)] for row in rows_by_ids(sample)]
    next_position = (position + size) % len(ids) if ids else 0
    view = {"count": len(ids), "max_id": ids[-1] if ids else 0, "ranges": ranges, "sweep": sweep}
    return view, next_position
