"""Verifier checks: hash chain and Merkle checkpoints offline, plus comparison with the witness."""
import json
import sqlite3
from pathlib import Path
from typing import Any

from sidecar.canon import GENESIS_PREV_HASH, compute_entry_hash
from sidecar.keys import verify_payload
from sidecar.merkle import merkle_root_hex


def _verdict(code: str, seq_from: int, seq_to: int, detail: str) -> dict[str, Any]:
    """Build one verdict object as in CONTRACT.md section 6."""
    return {"code": code, "seq_from": seq_from, "seq_to": seq_to, "detail": detail}


def _recompute_hash(row: sqlite3.Row) -> str | None:
    """Recompute an entry's hash from its stored fields, or None if the row cannot be read."""
    try:
        return compute_entry_hash(
            seq=int(row["seq"]),
            ts=row["ts"],
            source=row["source"],
            actor=row["actor"],
            event_type=row["event_type"],
            details=json.loads(row["details"]),
            prev_hash=row["prev_hash"],
        )
    except (ValueError, TypeError, RecursionError):
        return None


def verify_entries(conn: sqlite3.Connection) -> tuple[int, list[dict[str, Any]]]:
    """Verify log entries for sequence continuity, canonical hashing, and chain linkage."""
    rows = conn.execute("SELECT * FROM entries ORDER BY seq ASC").fetchall()
    verdicts: list[dict[str, Any]] = []
    edited_seqs: set[int] = set()
    expected_seq = 0
    prev_row: sqlite3.Row | None = None

    for row in rows:
        seq = int(row["seq"])

        # SEQ_GAP: anything other than the next expected seq (missing range, or a seq below it such as -1).
        if seq > expected_seq:
            verdicts.append(_verdict("SEQ_GAP", expected_seq, seq - 1,
                                     f"missing sequence numbers from {expected_seq} to {seq - 1}"))
        elif seq < expected_seq:
            verdicts.append(_verdict("SEQ_GAP", seq, seq, f"unexpected seq {seq} (expected {expected_seq})"))
        expected_seq = max(expected_seq, seq + 1)

        # EDIT: stored hash differs from the hash recomputed from the stored fields.
        recomputed = _recompute_hash(row)
        if recomputed != row["hash"]:
            edited_seqs.add(seq)
            detail = ("entry fields cannot be read or re-hashed" if recomputed is None
                      else f"stored hash {row['hash']} differs from recomputed hash {recomputed}")
            verdicts.append(_verdict("EDIT", seq, seq, detail))

        # CHAIN_BREAK: prev_hash does not link to the previous entry (skipped right after an EDIT,
        # so one edit gives one verdict).
        if seq == 0:
            if row["prev_hash"] != GENESIS_PREV_HASH:
                verdicts.append(_verdict("CHAIN_BREAK", 0, 0,
                                         f"entry 0 prev_hash {row['prev_hash']} is not the genesis hash"))
        elif seq > 0 and prev_row is not None and int(prev_row["seq"]) not in edited_seqs:
            if row["prev_hash"] != prev_row["hash"]:
                verdicts.append(_verdict("CHAIN_BREAK", seq, seq,
                                         f"prev_hash {row['prev_hash']} does not match previous entry hash "
                                         f"{prev_row['hash']}"))
        prev_row = row

    return len(rows), verdicts


def _check_one_checkpoint(conn: sqlite3.Connection, public_key_hex: str, row: sqlite3.Row) -> dict[str, Any] | None:
    """Return the verdict for one stored checkpoint, or None if it verifies against the local entries."""
    try:
        tree_size, head_seq = int(row["tree_size"]), int(row["head_seq"])
        payload = {"node_id": row["node_id"], "tree_size": tree_size, "head_seq": head_seq,
                   "head_hash": row["head_hash"], "root_hash": row["root_hash"], "ts": row["ts"]}
    except (ValueError, TypeError):
        return _verdict("BAD_CHECKPOINT_SIGNATURE", 0, 0, "checkpoint row cannot be read")
    if not verify_payload(public_key_hex, row["signature"], payload):
        return _verdict("BAD_CHECKPOINT_SIGNATURE", 0, head_seq,
                        f"checkpoint signature for tree_size {tree_size} is invalid")

    hashes = [r[0] for r in conn.execute(
        "SELECT hash FROM entries WHERE seq >= 0 AND seq < ? ORDER BY seq ASC", (tree_size,))]
    if len(hashes) != tree_size:
        return _verdict("CHECKPOINT_MISMATCH", 0, head_seq,
                        f"signed checkpoint covers {tree_size} entries (seq 0..{head_seq}) "
                        f"but only {len(hashes)} are present")
    try:
        computed_root = merkle_root_hex(hashes)
    except ValueError:
        computed_root = None
    if computed_root != row["root_hash"] or hashes[-1] != row["head_hash"]:
        return _verdict("CHECKPOINT_MISMATCH", 0, head_seq,
                        f"recomputed Merkle root {computed_root} differs from checkpoint root {row['root_hash']}")
    return None


def verify_checkpoints(conn: sqlite3.Connection, public_key_hex: str) -> list[dict[str, Any]]:
    """Verify signatures and recomputed Merkle roots on all stored checkpoints."""
    cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoints'")
    if not cur.fetchone():
        return []
    rows = conn.execute("SELECT * FROM checkpoints ORDER BY tree_size ASC").fetchall()
    return [v for v in (_check_one_checkpoint(conn, public_key_hex, r) for r in rows) if v is not None]


def fetch_witness(node_id: str, witness_url: str, client: Any = None) -> dict[str, list[dict[str, Any]]]:
    """Fetch a node's heartbeats, checkpoints and alerts from the witness; fail if it has none."""
    import httpx
    c = client if client is not None else httpx.Client(timeout=5.0)
    try:
        base, records = witness_url.rstrip("/"), {}
        for ep in ("heartbeats", "checkpoints", "alerts"):
            r = c.get(f"{base}/{ep}", params={"node_id": node_id, "limit": 100000})
            if r.status_code != 200:
                raise RuntimeError(f"witness GET /{ep} returned HTTP {r.status_code}")
            records[ep] = r.json()
    finally:
        if client is None:
            c.close()
    if not records["heartbeats"] and not records["checkpoints"]:
        # Fail closed: an empty history (wrong or edited node_id) must never read as "nothing to compare".
        raise RuntimeError(f"witness has no heartbeats or checkpoints for node_id '{node_id}'; "
                           "check the node id (use --node-id) and that the sidecar has reached the witness")
    return records


def verify_witness(conn: sqlite3.Connection, records: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """Compare the local log with fetched witness records: TRUNCATION, FORK and SILENCE verdicts."""
    verdicts: list[dict[str, Any]] = []
    val = conn.execute("SELECT MAX(seq) FROM entries").fetchone()[0]
    local_head = -1 if val is None else int(val)

    # Keep every hash per seq: with a stolen key an attacker can add a second history, never remove the first.
    w_heads: dict[int, set[str]] = {}
    for x in records["heartbeats"] + records["checkpoints"]:
        w_heads.setdefault(int(x["head_seq"]), set()).add(str(x["head_hash"]))
    max_w_seq = max(w_heads, default=-1)
    if local_head < max_w_seq:
        verdicts.append(_verdict("TRUNCATION", local_head + 1, max_w_seq,
                                 f"local head {local_head} is lower than witness head {max_w_seq}"))

    for w_seq, w_hashes in sorted(w_heads.items()):
        if w_seq < 0:
            continue
        if len(w_hashes) > 1:
            verdicts.append(_verdict("FORK", w_seq, w_seq,
                                     f"witness holds {len(w_hashes)} different head_hash values for seq {w_seq}"))
            continue
        row = conn.execute("SELECT hash FROM entries WHERE seq = ?", (w_seq,)).fetchone() if w_seq <= local_head else None
        if row is not None and str(row["hash"]) not in w_hashes:
            verdicts.append(_verdict("FORK", w_seq, w_seq,
                                     f"local hash at seq {w_seq} ({row['hash']}) differs from witness ({min(w_hashes)})"))

    # The witness's own alerts are records of the node claiming another history, or going quiet.
    alert_codes = {"FORK": "FORK", "SEQ_ROLLBACK": "TRUNCATION", "SILENCE": "SILENCE"}
    for a in records["alerts"]:
        code = alert_codes.get(a.get("code"))
        if code:
            at = max(0, local_head)
            verdicts.append(_verdict(code, at, at, f"witness {a.get('code')} alert at {a.get('received_at')}: "
                                                   f"{a.get('detail')}"))
    return verdicts


def verify(
    db_path: Path, public_key_path: Path | None = None, witness_url: str | None = None,
    node_id: str | None = None, client: Any = None,
) -> dict[str, Any]:
    """Execute offline and optional witness checks against the database and return report."""
    if not db_path.exists():
        raise FileNotFoundError(f"Database file does not exist: {db_path}")
    if public_key_path is not None and not public_key_path.exists():
        # Fail closed: without the key the checkpoints cannot be checked, so "clean" would be a lie.
        raise FileNotFoundError(f"Public key file does not exist: {public_key_path}; cannot verify checkpoints")
    if witness_url and not node_id:
        raise ValueError("--witness needs a node id ([node] node_id in the config, or --node-id)")
    # Witness first: the sidecar commits an entry before any heartbeat reports it, so the local
    # snapshot taken afterwards already holds everything the witness saw (no false TRUNCATION).
    records = fetch_witness(node_id, witness_url, client=client) if witness_url else None

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, isolation_level=None)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("BEGIN")  # one read snapshot for entries, checkpoints and the witness comparison
        checked_entries, verdicts = verify_entries(conn)
        if public_key_path is not None:
            verdicts.extend(verify_checkpoints(conn, public_key_path.read_text(encoding="utf-8").strip()))
        if records is not None:
            verdicts.extend(verify_witness(conn, records))
    finally:
        conn.close()

    return {"clean": len(verdicts) == 0, "checked_entries": checked_entries, "verdicts": verdicts}


def verify_offline(db_path: Path, public_key_path: Path | None = None) -> dict[str, Any]:
    """Execute all offline integrity checks against the database and return report dict."""
    return verify(db_path, public_key_path)
