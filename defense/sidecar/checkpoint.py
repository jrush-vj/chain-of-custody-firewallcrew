"""Signed checkpoint generation over the hash chain Merkle tree."""
import logging
import time
from collections.abc import Callable
from datetime import datetime, timezone
from sqlite3 import Connection
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from sidecar.keys import sign_payload
from sidecar.merkle import merkle_root_hex
from sidecar.store import count_entries, get_last_checkpoint, insert_checkpoint

logger = logging.getLogger(__name__)


def create_checkpoint(
    conn: Connection,
    node_id: str,
    private_key: Ed25519PrivateKey,
    ts: str | None = None,
) -> dict[str, Any] | None:
    """Create, sign, and store a checkpoint for all currently recorded entries."""
    max_seq = conn.execute("SELECT MAX(seq) FROM entries").fetchone()[0]
    if max_seq is None:
        return None
    total_entries = int(max_seq) + 1

    last_cp = get_last_checkpoint(conn)
    if last_cp is not None and last_cp["tree_size"] >= total_entries:
        return None

    cur = conn.execute("SELECT seq, hash FROM entries WHERE seq >= 0 ORDER BY seq ASC")
    rows = cur.fetchall()
    if len(rows) != total_entries:
        raise ValueError(
            f"Refusing to sign: {len(rows)} entries stored but seq runs 0..{max_seq} (gap or bad seq)"
        )
    entry_hashes = [str(r["hash"]) for r in rows]

    head_seq = total_entries - 1
    head_hash = entry_hashes[-1]
    root_hash = merkle_root_hex(entry_hashes)

    if ts is None:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    payload: dict[str, Any] = {
        "node_id": node_id,
        "tree_size": total_entries,
        "head_seq": head_seq,
        "head_hash": head_hash,
        "root_hash": root_hash,
        "ts": ts,
    }

    payload["signature"] = sign_payload(private_key, payload)
    insert_checkpoint(conn, payload)
    return payload


def should_create_checkpoint(
    conn: Connection,
    last_checkpoint_epoch: float,
    every_n: int,
    every_s: int,
) -> bool:
    """Determine whether a new checkpoint should be created based on count or elapsed time."""
    total_entries = count_entries(conn)
    last_cp = get_last_checkpoint(conn)
    last_tree_size = int(last_cp["tree_size"]) if last_cp else 0
    new_entries = total_entries - last_tree_size

    if new_entries <= 0:
        return False
    if new_entries >= every_n:
        return True
    if (time.time() - last_checkpoint_epoch) >= every_s:
        return True
    return False


def make_checkpoint_tick(
    conn: Connection,
    node_id: str,
    private_key: Ed25519PrivateKey,
    every_n: int,
    every_s: int,
) -> Callable[[], None]:
    """Return a callback that creates a checkpoint whenever one is due (run it in the ingest thread)."""
    last_epoch = time.time()

    def tick() -> None:
        """Create a signed checkpoint if every_n entries or every_s seconds have passed."""
        nonlocal last_epoch
        if should_create_checkpoint(conn, last_epoch, every_n, every_s):
            last_epoch = time.time()
            cp = create_checkpoint(conn, node_id, private_key)
            if cp is not None:
                logger.info("Checkpoint tree_size=%d root=%s", cp["tree_size"], cp["root_hash"])

    return tick
