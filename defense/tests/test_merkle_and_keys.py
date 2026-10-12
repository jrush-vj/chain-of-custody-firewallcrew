"""D4 tests: Merkle tree RFC 6962 math, Ed25519 signing, and signed checkpoints."""
import json
import time
from pathlib import Path

from sidecar.checkpoint import create_checkpoint, should_create_checkpoint
from sidecar.keys import (
    generate_keypair,
    load_or_generate_keypair,
    sign_payload,
    verify_payload,
)
from sidecar.merkle import merkle_root_hex
from sidecar.store import append_entry, get_checkpoints, get_last_checkpoint, init_db

ROOT = Path(__file__).resolve().parents[1]
SAMPLE_PATH = ROOT / "samples" / "events.sample.jsonl"

ENTRY_HASHES_5 = [
    "6838b198eaec15fe5a4e73266e04f912bd99c230c81dcae534fd0e3d019a8053",
    "75397be4962e1d5a605cf9bda41ba3cc1e6b8100b2abcc0409b96735e3d44711",
    "20da29a9023ae11b33d97e95c4c2563762cc51aca7dcb7964dd6f70a088e75b3",
    "9b6e549dae35527ebabf1a2a63160c4fce5c4419b67bae7807b0ea28f05d3a6d",
    "5f169c5466e1a9d2f292cd8f6c061c5915f03986deb2ac21be626e562eeaf61b",
]

EXPECTED_ROOTS = {
    1: "cb881caff33b24f04627fe6d753ae468524848c8b7576be108f53a7f13150127",
    2: "22d0190096126edcebc54d3a8803eb2f9d65b3b47802b951fc1cebc61dfc9d62",
    3: "e11816ce00bd2bce1fd4cf47d1af346d512011ee63d2b244c5574ddede44c415",
    4: "eb8f45112105cceac05363584b2404429046b6cf6de1cdd8dc4af0dbe039cf6b",
    5: "fa342082214823efae8212916bd68a53efa3740e65dfa7c396ef4ba71472591b",
}


def test_contract_merkle_root_test_vectors() -> None:
    """Verify that n=1..5 Merkle roots match CONTRACT.md section 4 test vectors exactly."""
    for n in range(1, 6):
        root = merkle_root_hex(ENTRY_HASHES_5[:n])
        assert root == EXPECTED_ROOTS[n], f"Mismatch for n={n}"


def test_merkle_tree_sizes_1_to_8() -> None:
    """Verify Merkle tree construction across leaf sizes 1 to 8 produces valid roots."""
    hashes = [f"{i:064x}" for i in range(1, 9)]
    roots = [merkle_root_hex(hashes[:size]) for size in range(1, 9)]
    assert len(set(roots)) == 8
    for r in roots:
        assert len(r) == 64


def test_tampering_any_leaf_changes_root() -> None:
    """Changing any single entry hash produces a completely different Merkle root."""
    original_root = merkle_root_hex(ENTRY_HASHES_5)
    for i in range(len(ENTRY_HASHES_5)):
        tampered_hashes = list(ENTRY_HASHES_5)
        tampered_hashes[i] = "a" * 64
        tampered_root = merkle_root_hex(tampered_hashes)
        assert tampered_root != original_root


def test_keypair_generation_and_roundtrip(tmp_path: Path) -> None:
    """Key pair generation, disk persistence, and reloading work reliably."""
    priv_path = tmp_path / "node.key"
    pub_path = tmp_path / "node.pub"

    priv_key, pub_hex = load_or_generate_keypair(priv_path, pub_path)
    assert priv_path.exists()
    assert pub_path.exists()
    assert len(pub_hex) == 64

    reloaded_priv, reloaded_pub = load_or_generate_keypair(priv_path, pub_path)
    assert reloaded_pub == pub_hex


def test_sign_and_verify_payload() -> None:
    """Signatures over canonical JSON verify cleanly and reject tampered data."""
    priv_key, pub_hex = generate_keypair()
    payload = {
        "node_id": "node-1",
        "tree_size": 5,
        "head_seq": 4,
        "head_hash": ENTRY_HASHES_5[4],
        "root_hash": EXPECTED_ROOTS[5],
        "ts": "2026-10-12T09:20:00Z",
    }

    sig_hex = sign_payload(priv_key, payload)
    assert len(sig_hex) == 128
    assert verify_payload(pub_hex, sig_hex, payload) is True

    tampered_payload = dict(payload)
    tampered_payload["tree_size"] = 6
    assert verify_payload(pub_hex, sig_hex, tampered_payload) is False

    _, other_pub_hex = generate_keypair()
    assert verify_payload(other_pub_hex, sig_hex, payload) is False
    assert verify_payload(pub_hex, "deadbeef", payload) is False


def test_checkpoint_creation_and_signature_verification(tmp_path: Path) -> None:
    """Create signed checkpoints in the store and verify against node public key."""
    db_file = tmp_path / "sidecar.db"
    conn = init_db(db_file)
    priv_key, pub_hex = generate_keypair()

    assert create_checkpoint(conn, "node-1", priv_key) is None

    sample_lines = SAMPLE_PATH.read_text(encoding="utf-8").strip().splitlines()
    for line in sample_lines[:5]:
        append_entry(conn, json.loads(line))

    cp = create_checkpoint(conn, "node-1", priv_key, ts="2026-10-12T09:20:00Z")
    assert cp is not None
    assert cp["node_id"] == "node-1"
    assert cp["tree_size"] == 5
    assert cp["head_seq"] == 4
    assert cp["head_hash"] == ENTRY_HASHES_5[4]
    assert cp["root_hash"] == EXPECTED_ROOTS[5]
    assert cp["ts"] == "2026-10-12T09:20:00Z"
    assert "signature" in cp

    payload_no_sig = {k: v for k, v in cp.items() if k != "signature"}
    assert verify_payload(pub_hex, cp["signature"], payload_no_sig) is True

    assert create_checkpoint(conn, "node-1", priv_key) is None

    stored_last = get_last_checkpoint(conn)
    assert stored_last is not None
    assert stored_last["root_hash"] == EXPECTED_ROOTS[5]
    assert len(get_checkpoints(conn)) == 1


def test_should_create_checkpoint_logic(tmp_path: Path) -> None:
    """Check should_create_checkpoint count and elapsed time conditions."""
    db_file = tmp_path / "sidecar.db"
    conn = init_db(db_file)
    priv_key, _ = generate_keypair()

    sample_lines = SAMPLE_PATH.read_text(encoding="utf-8").strip().splitlines()
    for line in sample_lines[:5]:
        append_entry(conn, json.loads(line))

    now = time.time()
    assert should_create_checkpoint(conn, last_checkpoint_epoch=now, every_n=10, every_s=60) is False
    assert should_create_checkpoint(conn, last_checkpoint_epoch=now, every_n=5, every_s=60) is True
    assert should_create_checkpoint(conn, last_checkpoint_epoch=now - 70.0, every_n=50, every_s=60) is True

    create_checkpoint(conn, "node-1", priv_key)
    assert should_create_checkpoint(conn, last_checkpoint_epoch=now - 70.0, every_n=50, every_s=60) is False
