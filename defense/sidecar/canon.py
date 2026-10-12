"""Canonical JSON and SHA-256 calculation according to CONTRACT.md."""
import hashlib
import json
from typing import Any

GENESIS_PREV_HASH = "0" * 64


def canonical_json_bytes(obj: Any) -> bytes:
    """Encode an object into canonical JSON bytes with sorted keys and no whitespace."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def canonical_json_str(obj: Any) -> str:
    """Encode an object into canonical JSON string."""
    return canonical_json_bytes(obj).decode("utf-8")


def sha256_hex(data: bytes) -> str:
    """Compute the lowercase hexadecimal SHA-256 digest of bytes."""
    return hashlib.sha256(data).hexdigest()


def compute_entry_hash(
    seq: int,
    ts: str,
    source: str,
    actor: str,
    event_type: str,
    details: Any,
    prev_hash: str,
) -> str:
    """Compute the SHA-256 hash for a log entry according to CONTRACT.md section 3."""
    entry_payload = {
        "seq": seq,
        "ts": ts,
        "source": source,
        "actor": actor,
        "event_type": event_type,
        "details": details,
        "prev_hash": prev_hash,
    }
    return sha256_hex(canonical_json_bytes(entry_payload))
