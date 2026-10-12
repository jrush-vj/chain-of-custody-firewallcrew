"""Insert-only SQLite store for the witness: heartbeats, checkpoints and alerts."""
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS heartbeats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL, hb_counter INTEGER NOT NULL, head_seq INTEGER NOT NULL,
    head_hash TEXT NOT NULL, tree_size INTEGER NOT NULL, ts TEXT NOT NULL,
    signature TEXT NOT NULL, fresh INTEGER NOT NULL,
    received_at TEXT NOT NULL, received_epoch REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL, tree_size INTEGER NOT NULL, head_seq INTEGER NOT NULL,
    head_hash TEXT NOT NULL, root_hash TEXT NOT NULL, ts TEXT NOT NULL,
    signature TEXT NOT NULL, received_at TEXT NOT NULL, received_epoch REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL, code TEXT NOT NULL, detail TEXT NOT NULL,
    received_at TEXT NOT NULL, received_epoch REAL NOT NULL
);
"""

# Columns returned by the GET endpoints (internal ids and epochs stay private).
COLUMNS = {
    "heartbeats": "node_id, hb_counter, head_seq, head_hash, tree_size, ts, signature, received_at",
    "checkpoints": "node_id, tree_size, head_seq, head_hash, root_hash, ts, signature, received_at",
    "alerts": "node_id, code, detail, received_at",
}


def _insert_only_triggers() -> str:
    """Return SQL that makes every witness table reject UPDATE and DELETE."""
    return "".join(
        f"CREATE TRIGGER IF NOT EXISTS {table}_no_{verb.lower()} BEFORE {verb} ON {table} "
        f"BEGIN SELECT RAISE(ABORT, 'witness tables are insert-only'); END;\n"
        for table in COLUMNS for verb in ("UPDATE", "DELETE")
    )


def connect(db_path: Path | str) -> sqlite3.Connection:
    """Open the witness database in WAL mode and create the schema and triggers."""
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.executescript(SCHEMA + _insert_only_triggers())
    return conn


@contextmanager
def write_transaction(conn: sqlite3.Connection) -> Iterator[None]:
    """Run a block inside BEGIN IMMEDIATE; commit on success, roll back on any error."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def insert_heartbeat(conn: sqlite3.Connection, hb: dict[str, Any], fresh: bool, received_at: str, epoch: float) -> None:
    """Insert a signature-valid heartbeat; fresh means its counter was higher than any seen."""
    conn.execute(
        "INSERT INTO heartbeats (node_id, hb_counter, head_seq, head_hash, tree_size, ts, signature,"
        " fresh, received_at, received_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (hb["node_id"], hb["hb_counter"], hb["head_seq"], hb["head_hash"], hb["tree_size"],
         hb["ts"], hb["signature"], int(fresh), received_at, epoch),
    )


def insert_checkpoint(conn: sqlite3.Connection, cp: dict[str, Any], received_at: str, epoch: float) -> None:
    """Insert a signature-valid checkpoint."""
    conn.execute(
        "INSERT INTO checkpoints (node_id, tree_size, head_seq, head_hash, root_hash, ts, signature,"
        " received_at, received_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (cp["node_id"], cp["tree_size"], cp["head_seq"], cp["head_hash"], cp["root_hash"],
         cp["ts"], cp["signature"], received_at, epoch),
    )


def insert_alert(conn: sqlite3.Connection, node_id: str, code: str, detail: str, received_at: str, epoch: float) -> None:
    """Insert an alert row."""
    conn.execute(
        "INSERT INTO alerts (node_id, code, detail, received_at, received_epoch) VALUES (?, ?, ?, ?, ?)",
        (node_id, code, detail, received_at, epoch),
    )


def alert_recorded_since(conn: sqlite3.Connection, node_id: str, code: str, detail: str, since: float) -> bool:
    """Return True if an identical alert was stored after the given epoch."""
    cur = conn.execute(
        "SELECT 1 FROM alerts WHERE node_id = ? AND code = ? AND detail = ? AND received_epoch > ? LIMIT 1",
        (node_id, code, detail, since),
    )
    return cur.fetchone() is not None


def _scalar(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...]) -> Any:
    """Return the first column of the first row, or None."""
    row = conn.execute(sql, params).fetchone()
    return row[0] if row else None


def last_counter(conn: sqlite3.Connection, node_id: str) -> int | None:
    """Highest hb_counter stored for the node."""
    return _scalar(conn, "SELECT MAX(hb_counter) FROM heartbeats WHERE node_id = ?", (node_id,))


def highest_head_seq(conn: sqlite3.Connection, node_id: str) -> int | None:
    """Highest head_seq stored in the node's heartbeats."""
    return _scalar(conn, "SELECT MAX(head_seq) FROM heartbeats WHERE node_id = ?", (node_id,))


def last_fresh_epoch(conn: sqlite3.Connection, node_id: str) -> float | None:
    """Receive time of the newest heartbeat that advanced the counter."""
    return _scalar(conn, "SELECT MAX(received_epoch) FROM heartbeats WHERE node_id = ? AND fresh = 1", (node_id,))


def last_alert_epoch(conn: sqlite3.Connection, node_id: str, code: str) -> float | None:
    """Receive time of the newest stored alert with this code."""
    return _scalar(conn, "SELECT MAX(received_epoch) FROM alerts WHERE node_id = ? AND code = ?", (node_id, code))


def heartbeat_exists(conn: sqlite3.Connection, node_id: str, hb_counter: int, signature: str) -> bool:
    """Return True if this exact signed heartbeat is already stored."""
    sql = "SELECT 1 FROM heartbeats WHERE node_id = ? AND hb_counter = ? AND signature = ? LIMIT 1"
    return conn.execute(sql, (node_id, hb_counter, signature)).fetchone() is not None


def hashes_at_seq(conn: sqlite3.Connection, node_id: str, head_seq: int) -> set[str]:
    """Every head_hash the witness has seen for this head_seq (heartbeats and checkpoints)."""
    sql = ("SELECT head_hash FROM heartbeats WHERE node_id = ? AND head_seq = ? UNION "
           "SELECT head_hash FROM checkpoints WHERE node_id = ? AND head_seq = ?")
    return {r[0] for r in conn.execute(sql, (node_id, head_seq, node_id, head_seq))}


def get_checkpoint_at(conn: sqlite3.Connection, node_id: str, tree_size: int) -> dict[str, Any] | None:
    """Return the first stored checkpoint of this tree_size for the node."""
    sql = "SELECT * FROM checkpoints WHERE node_id = ? AND tree_size = ? ORDER BY id ASC LIMIT 1"
    row = conn.execute(sql, (node_id, tree_size)).fetchone()
    return dict(row) if row else None


def list_rows(
    conn: sqlite3.Connection, table: str, node_id: str, limit: int | None = None, code: str | None = None
) -> list[dict[str, Any]]:
    """Return the newest `limit` rows of a table for a node, oldest first."""
    cols = COLUMNS[table]
    where, params = "node_id = ?", [node_id]
    if code is not None:
        where += " AND code = ?"
        params.append(code)
    params.append(-1 if limit is None else limit)
    sql = (f"SELECT {cols} FROM (SELECT id, {cols} FROM {table} WHERE {where} "
           f"ORDER BY id DESC LIMIT ?) ORDER BY id ASC")
    return [dict(r) for r in conn.execute(sql, params)]
