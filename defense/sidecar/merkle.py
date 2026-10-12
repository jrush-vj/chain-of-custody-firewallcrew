"""RFC 6962 style Merkle tree calculation over log entry hashes."""
import hashlib
import re

ENTRY_HASH_RE = re.compile(r"[0-9a-f]{64}")


def _leaf_hash(entry_hash_hex: str) -> bytes:
    """Compute leaf hash SHA-256(0x00 || entry_hash_bytes) for a 64-char lowercase hex hash."""
    if not isinstance(entry_hash_hex, str) or not ENTRY_HASH_RE.fullmatch(entry_hash_hex):
        raise ValueError(f"entry hash is not 64 lowercase hex characters: {entry_hash_hex!r}")
    raw_bytes = bytes.fromhex(entry_hash_hex)
    return hashlib.sha256(b"\x00" + raw_bytes).digest()


def _node_hash(left_bytes: bytes, right_bytes: bytes) -> bytes:
    """Compute internal node hash SHA-256(0x01 || left || right)."""
    return hashlib.sha256(b"\x01" + left_bytes + right_bytes).digest()


def _sub_tree_hash(leaves: list[bytes]) -> bytes:
    """Recursively compute root bytes for a list of leaf hashes using power-of-two split."""
    n = len(leaves)
    if n == 0:
        return hashlib.sha256(b"").digest()
    if n == 1:
        return leaves[0]

    k = 1 << ((n - 1).bit_length() - 1)
    left_root = _sub_tree_hash(leaves[:k])
    right_root = _sub_tree_hash(leaves[k:])
    return _node_hash(left_root, right_root)


def merkle_root_hex(entry_hashes_hex: list[str]) -> str:
    """Compute RFC 6962 Merkle tree root as a lowercase hex string."""
    if not entry_hashes_hex:
        return hashlib.sha256(b"").hexdigest()
    leaves = [_leaf_hash(h) for h in entry_hashes_hex]
    return _sub_tree_hash(leaves).hex()
