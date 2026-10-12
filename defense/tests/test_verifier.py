"""D5 tests: verifier offline tamper detection and verdict codes."""
import json
import random
import shutil
from pathlib import Path

from sidecar.checkpoint import create_checkpoint
from sidecar.keys import generate_keypair, load_or_generate_keypair, save_keypair
from sidecar.store import append_entry, init_db
from tools.gen_events import make_event
from verifier.__main__ import main
from verifier.checks import verify_offline


def _create_seeded_db(base_dir: Path, n_entries: int = 15) -> tuple[Path, Path, Path]:
    """Helper to populate a test database with entries, keys, and a signed checkpoint."""
    db_path = base_dir / "sidecar.db"
    priv_path = base_dir / "node.key"
    pub_path = base_dir / "node.pub"

    priv_key, pub_hex = load_or_generate_keypair(priv_path, pub_path)
    conn = init_db(db_path)

    rng = random.Random(42)
    for _ in range(n_entries):
        raw = make_event(rng, "2026-10-12T10:00:00Z")
        append_entry(conn, raw)

    create_checkpoint(conn, "node-1", priv_key)
    conn.close()
    return db_path, priv_path, pub_path


def _create_config(base_dir: Path, db_path: Path, pub_path: Path) -> Path:
    """Helper to write a temporary config.toml pointing to the given DB and key."""
    cfg_path = base_dir / "config.toml"
    content = f"""[node]
node_id = "node-1"

[paths]
spool_path = "spool/events.jsonl"
db_path = "{db_path.as_posix()}"
private_key_path = "data/node.key"
public_key_path = "{pub_path.as_posix()}"
"""
    cfg_path.write_text(content, encoding="utf-8")
    return cfg_path


def test_clean_database_passes(tmp_path: Path) -> None:
    """A clean, untampered database reports clean: true and exit code 0."""
    db_path, _, pub_path = _create_seeded_db(tmp_path, 15)
    report = verify_offline(db_path, pub_path)

    assert report["clean"] is True
    assert report["checked_entries"] == 15
    assert report["verdicts"] == []

    cfg = _create_config(tmp_path, db_path, pub_path)
    assert main(["--config", str(cfg)]) == 0


def test_tamper_edit_field(tmp_path: Path) -> None:
    """Editing a field in a row triggers the EDIT verdict code with the exact seq."""
    db_orig, _, pub_path = _create_seeded_db(tmp_path / "orig", 15)
    db_copy = tmp_path / "tampered.db"
    shutil.copyfile(db_orig, db_copy)

    conn = init_db(db_copy)
    conn.execute("UPDATE entries SET actor = 'malicious_actor' WHERE seq = 7")
    conn.close()

    report = verify_offline(db_copy, pub_path)
    assert report["clean"] is False
    codes = [v["code"] for v in report["verdicts"]]
    assert "EDIT" in codes

    edit_verdict = next(v for v in report["verdicts"] if v["code"] == "EDIT")
    assert edit_verdict["seq_from"] == 7
    assert edit_verdict["seq_to"] == 7

    cfg = _create_config(tmp_path, db_copy, pub_path)
    assert main(["--config", str(cfg)]) == 1


def test_tamper_seq_gap(tmp_path: Path) -> None:
    """Deleting a row triggers the SEQ_GAP verdict code with the missing range."""
    db_orig, _, pub_path = _create_seeded_db(tmp_path / "orig", 15)
    db_copy = tmp_path / "tampered.db"
    shutil.copyfile(db_orig, db_copy)

    conn = init_db(db_copy)
    conn.execute("DELETE FROM entries WHERE seq = 5")
    conn.close()

    report = verify_offline(db_copy, pub_path)
    assert report["clean"] is False
    gap_verdict = next((v for v in report["verdicts"] if v["code"] == "SEQ_GAP"), None)
    assert gap_verdict is not None
    assert gap_verdict["seq_from"] == 5
    assert gap_verdict["seq_to"] == 5


def test_tamper_chain_break(tmp_path: Path) -> None:
    """Corrupting an entry prev_hash triggers the CHAIN_BREAK verdict code."""
    db_orig, _, pub_path = _create_seeded_db(tmp_path / "orig", 15)
    db_copy = tmp_path / "tampered.db"
    shutil.copyfile(db_orig, db_copy)

    conn = init_db(db_copy)
    conn.execute("UPDATE entries SET prev_hash = ? WHERE seq = 4", ("f" * 64,))
    conn.close()

    report = verify_offline(db_copy, pub_path)
    assert report["clean"] is False
    break_verdict = next((v for v in report["verdicts"] if v["code"] == "CHAIN_BREAK"), None)
    assert break_verdict is not None
    assert break_verdict["seq_from"] == 4
    assert break_verdict["seq_to"] == 4


def test_tamper_reorder_entries(tmp_path: Path) -> None:
    """Swapping two entries triggers a tampering verdict at the swapped sequence numbers."""
    db_orig, _, pub_path = _create_seeded_db(tmp_path / "orig", 10)
    db_copy = tmp_path / "tampered.db"
    shutil.copyfile(db_orig, db_copy)

    conn = init_db(db_copy)
    row4 = dict(conn.execute("SELECT * FROM entries WHERE seq = 4").fetchone())
    row5 = dict(conn.execute("SELECT * FROM entries WHERE seq = 5").fetchone())

    conn.execute("UPDATE entries SET ts=?, source=?, actor=?, event_type=?, details=? WHERE seq = 4",
                 (row5["ts"], row5["source"], row5["actor"], row5["event_type"], row5["details"]))
    conn.execute("UPDATE entries SET ts=?, source=?, actor=?, event_type=?, details=? WHERE seq = 5",
                 (row4["ts"], row4["source"], row4["actor"], row4["event_type"], row4["details"]))
    conn.close()

    report = verify_offline(db_copy, pub_path)
    assert report["clean"] is False
    assert any(v["code"] in ("EDIT", "CHAIN_BREAK") and v["seq_from"] in (4, 5) for v in report["verdicts"])


def test_tamper_checkpoint_mismatch_on_rechain(tmp_path: Path) -> None:
    """Re-chaining entries after seq K violates the Merkle root of the signed checkpoint."""
    from sidecar.canon import compute_entry_hash

    db_orig, _, pub_path = _create_seeded_db(tmp_path / "orig", 10)
    db_copy = tmp_path / "tampered.db"
    shutil.copyfile(db_orig, db_copy)

    conn = init_db(db_copy)
    # Tamper row 6 and recompute hashes forward to end
    conn.execute("UPDATE entries SET actor = 'forger' WHERE seq = 6")
    cur = conn.execute("SELECT * FROM entries WHERE seq >= 6 ORDER BY seq ASC")
    rows = [dict(r) for r in cur.fetchall()]

    prev = conn.execute("SELECT hash FROM entries WHERE seq = 5").fetchone()["hash"]
    for r in rows:
        new_hash = compute_entry_hash(
            r["seq"], r["ts"], r["source"], r["actor"], r["event_type"],
            json.loads(r["details"]), prev
        )
        conn.execute("UPDATE entries SET prev_hash = ?, hash = ? WHERE seq = ?",
                     (prev, new_hash, r["seq"]))
        prev = new_hash
    conn.close()

    report = verify_offline(db_copy, pub_path)
    assert report["clean"] is False
    # Local chain looks internally consistent from seq 6 onwards, but Merkle root must mismatch checkpoint!
    mismatch = next((v for v in report["verdicts"] if v["code"] == "CHECKPOINT_MISMATCH"), None)
    assert mismatch is not None
    assert mismatch["seq_to"] == 9


def test_tamper_bad_checkpoint_signature(tmp_path: Path) -> None:
    """Corrupting a checkpoint signature triggers BAD_CHECKPOINT_SIGNATURE."""
    db_orig, _, pub_path = _create_seeded_db(tmp_path / "orig", 10)
    db_copy = tmp_path / "tampered.db"
    shutil.copyfile(db_orig, db_copy)

    conn = init_db(db_copy)
    conn.execute("UPDATE checkpoints SET signature = ? WHERE tree_size = 10", ("0" * 128,))
    conn.close()

    report = verify_offline(db_copy, pub_path)
    assert report["clean"] is False
    bad_sig = next((v for v in report["verdicts"] if v["code"] == "BAD_CHECKPOINT_SIGNATURE"), None)
    assert bad_sig is not None


def test_verifier_exit_code_2_on_error(tmp_path: Path) -> None:
    """Verifier returns exit code 2 when config or database is missing or unreadable."""
    assert main(["--config", str(tmp_path / "nonexistent.toml")]) == 2

    bad_cfg = tmp_path / "bad.toml"
    bad_cfg.write_text("""[node]\nnode_id="n1"\n[paths]\nspool_path="s"\ndb_path="missing.db"\npublic_key_path="p"\n""")
    assert main(["--config", str(bad_cfg)]) == 2
