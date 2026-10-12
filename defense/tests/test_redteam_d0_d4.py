"""Regression tests for the D0-D4 red-team findings (see docs/red-team/RED_TEAM_D0_D4.md, one test per RT id)."""
import hashlib
import json
import random
import sqlite3
import threading
import time
from pathlib import Path

import pytest

from sidecar import ingest, store
from sidecar.checkpoint import create_checkpoint, make_checkpoint_tick
from sidecar.ingest import IngestStopError, follow_spool, ingest_batch
from sidecar.keys import generate_keypair, load_or_generate_keypair, verify_payload
from sidecar.merkle import merkle_root_hex
from sidecar.store import append_entry, count_entries, get_checkpoints, get_entries, init_db
from tools.gen_events import append_event, generate
from tools.validate_spool import validate_line

GOOD = {"source": "app", "ts": "2026-10-12T09:15:30Z", "actor": "asha",
        "event_type": "login_success", "details": {"ip": "10.0.0.5"}}
GOOD_LINE = json.dumps(GOOD, separators=(",", ":"))


def _spool(tmp_path: Path, *lines: str) -> Path:
    """Write lines (each followed by a newline) to a fresh spool file."""
    path = tmp_path / "events.jsonl"
    path.write_bytes("".join(line + "\n" for line in lines).encode("utf-8"))
    return path


# RT-01: Python 3.11 has no autocommit= argument on sqlite3.connect.
def test_rt01_connection_works_with_python311_signature(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """get_connection must not pass arguments that Python 3.11's sqlite3.connect rejects."""
    real_connect = sqlite3.connect

    def connect_311(*args: object, **kwargs: object) -> sqlite3.Connection:
        """Stand-in for Python 3.11's sqlite3.connect, which has no autocommit argument."""
        if "autocommit" in kwargs:
            raise TypeError("'autocommit' is an invalid keyword argument for Connection()")
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(store.sqlite3, "connect", connect_311)
    conn = init_db(tmp_path / "s.db")
    append_entry(conn, GOOD)
    other = real_connect(str(tmp_path / "s.db"))
    assert other.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == 1


# RT-02: lone surrogate passed the validator, then failed to hash and was dropped.
def test_rt02_lone_surrogate_rejected_and_ingest_continues(tmp_path: Path) -> None:
    """A lone surrogate is a contract error, and ingest moves on to the next valid line."""
    bad = GOOD_LINE.replace('"asha"', '"\\ud800"')
    assert any("not encodable" in e for e in validate_line(bad))
    conn = init_db(tmp_path / "s.db")
    assert ingest_batch(conn, _spool(tmp_path, bad, GOOD_LINE)) == 1
    assert get_entries(conn)[0]["actor"] == "asha"


# RT-03: deep nesting crashed the validator and stalled ingest forever.
def test_rt03_deep_nesting_rejected_without_crash(tmp_path: Path) -> None:
    """Deeply nested JSON is reported as bad JSON, and the sidecar keeps ingesting."""
    deep = GOOD_LINE.replace('{"ip":"10.0.0.5"}', '{"x":' + "[" * 100_000 + "]" * 100_000 + "}")
    assert any("nested too deeply" in e for e in validate_line(deep))
    conn = init_db(tmp_path / "s.db")
    assert ingest_batch(conn, _spool(tmp_path, deep, GOOD_LINE)) == 1


# RT-04: duplicate keys were silently merged (last one wins).
@pytest.mark.parametrize("line", [
    GOOD_LINE.replace('"actor":"asha"', '"actor":"asha","actor":"mallory"'),
    GOOD_LINE.replace('{"ip":"10.0.0.5"}', '{"ip":"10.0.0.5","ip":"10.9.9.9"}'),
])
def test_rt04_duplicate_keys_rejected(line: str) -> None:
    """Duplicate keys at the top level or inside details are a contract error."""
    assert any("duplicate key" in e for e in validate_line(line))


# RT-05: a crash between storing the entry and saving the offset duplicated the event.
def test_rt05_crash_mid_commit_no_duplicate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """If the process dies after the insert but before the offset write, nothing is kept."""
    spool = _spool(tmp_path, GOOD_LINE)
    conn = init_db(tmp_path / "s.db")

    def die(*_args: object) -> None:
        """Simulate the process being killed mid-transaction."""
        raise KeyboardInterrupt

    monkeypatch.setattr(ingest, "set_state", die)
    with pytest.raises(KeyboardInterrupt):
        ingest_batch(conn, spool)
    assert count_entries(conn) == 0
    monkeypatch.undo()
    assert ingest_batch(conn, spool) == 1
    assert count_entries(conn) == 1


# RT-06: a failed append advanced the offset and lost the event.
def test_rt06_failed_append_is_retried_not_lost(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A storage error leaves the offset in place so the same line is retried."""
    spool = _spool(tmp_path, GOOD_LINE)
    conn = init_db(tmp_path / "s.db")

    def disk_full(*_args: object) -> None:
        """Simulate a failing database write."""
        raise sqlite3.OperationalError("database or disk is full")

    monkeypatch.setattr(ingest, "insert_entry", disk_full)
    with pytest.raises(sqlite3.OperationalError):
        ingest_batch(conn, spool)
    assert store.get_state(conn, "spool_offset") is None
    monkeypatch.undo()
    assert ingest_batch(conn, spool) == 1


# RT-07: a replaced spool of equal or larger size was ingested from the old offset.
@pytest.mark.parametrize("extra_lines", [0, 3])
def test_rt07_replaced_spool_stops_ingest(tmp_path: Path, extra_lines: int) -> None:
    """Replacing the spool with different content (same size or longer) stops ingest loudly."""
    spool = _spool(tmp_path, GOOD_LINE, GOOD_LINE)
    conn = init_db(tmp_path / "s.db")
    assert ingest_batch(conn, spool) == 2
    forged = GOOD_LINE.replace('"asha"', '"evil"')  # same length as the original
    spool.write_bytes(((forged + "\n") * (2 + extra_lines)).encode("utf-8"))
    with pytest.raises(IngestStopError, match="shrunk or replaced"):
        ingest_batch(conn, spool)
    assert count_entries(conn) == 2


def test_rt07_normal_appends_still_work(tmp_path: Path) -> None:
    """The last-line check does not disturb normal append-only growth across restarts."""
    spool = tmp_path / "events.jsonl"
    conn = init_db(tmp_path / "s.db")
    for seed in range(3):
        generate(spool, 10, 0, random.Random(seed))
        assert ingest_batch(conn, spool) == 10
    conn.close()
    conn = init_db(tmp_path / "s.db")
    append_event(spool, GOOD)
    assert ingest_batch(conn, spool) == 1
    assert count_entries(conn) == 31


# RT-08: two sidecars on the same DB both ingested the same lines.
def test_rt08_second_writer_detected_no_duplicates(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """If another writer advances the offset mid-batch, this one stops instead of duplicating."""
    spool = _spool(tmp_path, GOOD_LINE, GOOD_LINE, GOOD_LINE)
    conn_a = init_db(tmp_path / "s.db")
    conn_b = init_db(tmp_path / "s.db")
    real_parse = ingest._parse_raw
    raced = []

    def parse_and_race(raw: bytes, allowed: set[str] | None) -> object:
        """While sidecar A parses its first line, sidecar B ingests the whole spool."""
        if not raced:
            raced.append(True)
            ingest_batch(conn_b, spool)
        return real_parse(raw, allowed)

    monkeypatch.setattr(ingest, "_parse_raw", parse_and_race)
    with pytest.raises(IngestStopError, match="second sidecar"):
        ingest_batch(conn_a, spool)
    assert count_entries(conn_a) == 3


# RT-09: the stop decision relied on the word "shrunk" in an error message.
def test_rt09_follow_spool_stops_on_ingest_stop_error(tmp_path: Path) -> None:
    """follow_spool re-raises IngestStopError regardless of its message."""
    spool = _spool(tmp_path, GOOD_LINE, GOOD_LINE)
    conn = init_db(tmp_path / "s.db")
    ingest_batch(conn, spool)
    spool.write_bytes(b"")
    with pytest.raises(IngestStopError):
        follow_spool(conn, spool, poll_interval=0.01)


# RT-10: checkpoints were never created by the running sidecar.
def test_rt10_running_sidecar_creates_checkpoints(tmp_path: Path) -> None:
    """follow_spool with the checkpoint tick produces signed checkpoints every every_n entries."""
    spool = tmp_path / "events.jsonl"
    conn = init_db(tmp_path / "s.db")
    private_key, pub_hex = generate_keypair()
    tick = make_checkpoint_tick(conn, "node-1", private_key, every_n=10, every_s=3600)
    stop = threading.Event()
    worker = threading.Thread(target=follow_spool, args=(conn, spool),
                              kwargs={"poll_interval": 0.02, "stop_event": stop, "on_tick": tick}, daemon=True)
    worker.start()
    for seed in range(3):
        generate(spool, 10, 0, random.Random(seed))
        time.sleep(0.2)
    stop.set()
    worker.join(timeout=2.0)

    cps = get_checkpoints(conn)
    assert [cp["tree_size"] for cp in cps] == [10, 20, 30]
    for cp in cps:
        payload = {k: cp[k] for k in ("node_id", "tree_size", "head_seq", "head_hash", "root_hash", "ts")}
        assert verify_payload(pub_hex, cp["signature"], payload)


# RT-11: a checkpoint was signed over a table with a missing row.
def test_rt11_checkpoint_refuses_gapped_table(tmp_path: Path) -> None:
    """With a deleted middle entry, the sidecar refuses to sign a checkpoint."""
    conn = init_db(tmp_path / "s.db")
    for _ in range(5):
        append_entry(conn, GOOD)
    conn.execute("DELETE FROM entries WHERE seq = 2")
    private_key, _ = generate_keypair()
    with pytest.raises(ValueError, match="Refusing to sign"):
        create_checkpoint(conn, "node-1", private_key)
    assert get_checkpoints(conn) == []


# RT-12: deleting a key file silently replaced the node identity.
def test_rt12_missing_pub_is_rederived_not_regenerated(tmp_path: Path) -> None:
    """Deleting the .pub file keeps the same private key and rewrites the derived public key."""
    key, pub = tmp_path / "n.key", tmp_path / "n.pub"
    _, pub_hex = load_or_generate_keypair(key, pub)
    pem = key.read_bytes()
    pub.unlink()
    _, pub_hex_again = load_or_generate_keypair(key, pub)
    assert key.read_bytes() == pem
    assert pub_hex_again == pub_hex == pub.read_text(encoding="utf-8")


def test_rt12_missing_private_key_refuses(tmp_path: Path) -> None:
    """Deleting the private key does not silently create a new identity."""
    key, pub = tmp_path / "n.key", tmp_path / "n.pub"
    load_or_generate_keypair(key, pub)
    key.unlink()
    with pytest.raises(FileNotFoundError, match="refusing"):
        load_or_generate_keypair(key, pub)
    assert not key.exists()


def test_rt12_swapped_pub_file_refuses(tmp_path: Path) -> None:
    """A public key file that does not match the private key is an error."""
    key, pub = tmp_path / "n.key", tmp_path / "n.pub"
    load_or_generate_keypair(key, pub)
    pub.write_text(generate_keypair()[1], encoding="utf-8")
    with pytest.raises(ValueError, match="does not match"):
        load_or_generate_keypair(key, pub)


# RT-13: non-string signature or key crashed verify_payload.
@pytest.mark.parametrize("pub, sig", [(None, "00"), ("00" * 32, None), (123, 456), ("zz", "zz")])
def test_rt13_verify_payload_never_raises(pub: object, sig: object) -> None:
    """Garbage key or signature values verify as False instead of raising."""
    assert verify_payload(pub, sig, {"a": 1}) is False  # type: ignore[arg-type]


# RT-14: Merkle accepted uppercase or padded hex.
@pytest.mark.parametrize("bad", ["A" * 64, " " + "a" * 64, "a" * 63, "g" * 64])
def test_rt14_merkle_rejects_noncanonical_hash(bad: str) -> None:
    """Only 64 lowercase hex characters are valid entry hashes."""
    with pytest.raises(ValueError):
        merkle_root_hex(["a" * 64, bad])


# RT-15: the Merkle tree shape was not checked beyond the 5 contract vectors.
def _leaf(h: str) -> bytes:
    """Leaf hash per CONTRACT section 4, written out independently of sidecar.merkle."""
    return hashlib.sha256(b"\x00" + bytes.fromhex(h)).digest()


def _node(left: bytes, right: bytes) -> bytes:
    """Node hash per CONTRACT section 4, written out independently of sidecar.merkle."""
    return hashlib.sha256(b"\x01" + left + right).digest()


def test_rt15_merkle_shape_matches_hand_built_trees() -> None:
    """Roots for 3, 5, 6, 7 and 8 leaves match trees built by hand with the contract split rule."""
    h = [f"{i:064x}" for i in range(1, 9)]
    l = [_leaf(x) for x in h]
    n01, n23, n45, n67 = _node(l[0], l[1]), _node(l[2], l[3]), _node(l[4], l[5]), _node(l[6], l[7])
    expected = {
        3: _node(n01, l[2]),
        5: _node(_node(n01, n23), l[4]),
        6: _node(_node(n01, n23), n45),
        7: _node(_node(n01, n23), _node(n45, l[6])),
        8: _node(_node(n01, n23), _node(n45, n67)),
    }
    for size, root in expected.items():
        assert merkle_root_hex(h[:size]) == root.hex(), f"size {size}"
