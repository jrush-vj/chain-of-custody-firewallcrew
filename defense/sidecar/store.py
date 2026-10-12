"""SQLite store for hash-chained log entries in WAL mode."""
import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sidecar.canon import GENESIS_PREV_HASH, canonical_json_str, compute_entry_hash

SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    seq INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    source TEXT NOT NULL,
    actor TEXT NOT NULL,
    event_type TEXT NOT NULL,
    details TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL,
    received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ingest_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints (
    tree_size INTEGER PRIMARY KEY,
    head_seq INTEGER NOT NULL,
    head_hash TEXT NOT NULL,
    root_hash TEXT NOT NULL,
    ts TEXT NOT NULL,
    signature TEXT NOT NULL,
    node_id TEXT NOT NULL
);
"""


def get_connection(db_path: Path | str) -> sqlite3.Connection:
    """Open a SQLite connection configured with WAL mode and row factory."""
    if isinstance(db_path, (str, Path)) and str(db_path) != ":memory:":
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    # isolation_level=None: no implicit transactions, works on Python 3.11 (autocommit= needs 3.12).
    conn = sqlite3.connect(str(db_path), timeout=10.0, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn


def init_db(db_path: Path | str) -> sqlite3.Connection:
    """Initialize the SQLite database schema and return the connection."""
    conn = get_connection(db_path)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.executescript(SCHEMA)
    return conn


@contextmanager
def write_transaction(conn: sqlite3.Connection) -> Iterator[None]:
    """Run a block inside BEGIN IMMEDIATE; commit on success, roll back on any error or interrupt."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def get_state(conn: sqlite3.Connection, key: str) -> str | None:
    """Retrieve a state string by key from the ingest_state table."""
    cur = conn.execute("SELECT value FROM ingest_state WHERE key = ?", (key,))
    row = cur.fetchone()
    return str(row["value"]) if row else None


def set_state(conn: sqlite3.Connection, key: str, value: str) -> None:
    """Upsert a state string by key into the ingest_state table."""
    conn.execute(
        "INSERT INTO ingest_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    """Convert an entries database row into a dictionary with parsed details."""
    d = dict(row)
    d["details"] = json.loads(d["details"])
    return d


def get_last_entry(conn: sqlite3.Connection) -> dict[str, Any] | None:
    """Fetch the latest log entry by seq, or None if the log is empty."""
    cur = conn.execute("SELECT * FROM entries ORDER BY seq DESC LIMIT 1")
    row = cur.fetchone()
    return _row_to_dict(row) if row else None


def get_entry(conn: sqlite3.Connection, seq: int) -> dict[str, Any] | None:
    """Fetch a single log entry by its sequence number."""
    cur = conn.execute("SELECT * FROM entries WHERE seq = ?", (seq,))
    row = cur.fetchone()
    return _row_to_dict(row) if row else None


def get_entries(conn: sqlite3.Connection, from_seq: int = 0, limit: int | None = None) -> list[dict[str, Any]]:
    """Fetch consecutive log entries starting from from_seq with an optional limit."""
    query = "SELECT * FROM entries WHERE seq >= ? ORDER BY seq ASC"
    params: list[Any] = [from_seq]
    if limit is not None:
        query += " LIMIT ?"
        params.append(limit)
    cur = conn.execute(query, tuple(params))
    return [_row_to_dict(r) for r in cur.fetchall()]


def count_entries(conn: sqlite3.Connection) -> int:
    """Return the total number of entries in the log."""
    cur = conn.execute("SELECT COUNT(*) FROM entries")
    return int(cur.fetchone()[0])


def append_entry(
    conn: sqlite3.Connection,
    raw_event: dict[str, Any],
    received_at: str | None = None,
) -> dict[str, Any]:
    """Append a RawEvent to the log atomically inside a BEGIN IMMEDIATE transaction."""
    with write_transaction(conn):
        return insert_entry(conn, raw_event, received_at)


def insert_entry(
    conn: sqlite3.Connection,
    raw_event: dict[str, Any],
    received_at: str | None = None,
) -> dict[str, Any]:
    """Chain and insert a RawEvent; the caller must hold a write_transaction."""
    if received_at is None:
        received_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    details_str = canonical_json_str(raw_event["details"])
    details_obj = json.loads(details_str)

    cur = conn.execute("SELECT seq, hash FROM entries ORDER BY seq DESC LIMIT 1")
    last_row = cur.fetchone()
    if last_row is None:
        seq = 0
        prev_hash = GENESIS_PREV_HASH
    else:
        seq = int(last_row["seq"]) + 1
        prev_hash = str(last_row["hash"])

    entry_hash = compute_entry_hash(
        seq=seq,
        ts=raw_event["ts"],
        source=raw_event["source"],
        actor=raw_event["actor"],
        event_type=raw_event["event_type"],
        details=details_obj,
        prev_hash=prev_hash,
    )

    sql = """INSERT INTO entries (seq, ts, source, actor, event_type, details, prev_hash, hash, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"""
    conn.execute(sql, (seq, raw_event["ts"], raw_event["source"], raw_event["actor"],
                       raw_event["event_type"], details_str, prev_hash, entry_hash, received_at))

    return {
        "seq": seq, "ts": raw_event["ts"], "source": raw_event["source"], "actor": raw_event["actor"],
        "event_type": raw_event["event_type"], "details": details_obj, "prev_hash": prev_hash,
        "hash": entry_hash, "received_at": received_at,
    }


def insert_checkpoint(conn: sqlite3.Connection, cp: dict[str, Any]) -> None:
    """Insert a signed checkpoint record into the checkpoints table."""
    sql = """INSERT INTO checkpoints (tree_size, head_seq, head_hash, root_hash, ts, signature, node_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)"""
    conn.execute(sql, (cp["tree_size"], cp["head_seq"], cp["head_hash"],
                       cp["root_hash"], cp["ts"], cp["signature"], cp["node_id"]))


def get_last_checkpoint(conn: sqlite3.Connection) -> dict[str, Any] | None:
    """Retrieve the latest checkpoint by tree_size, or None if none exist."""
    cur = conn.execute("SELECT * FROM checkpoints ORDER BY tree_size DESC LIMIT 1")
    row = cur.fetchone()
    return dict(row) if row else None


def get_checkpoints(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Retrieve all checkpoints in ascending tree_size order."""
    cur = conn.execute("SELECT * FROM checkpoints ORDER BY tree_size ASC")
    return [dict(r) for r in cur.fetchall()]
