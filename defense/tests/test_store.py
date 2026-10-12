"""D2 tests: canonical JSON, contract test vectors, and SQLite store chain."""
import json
import random
from pathlib import Path

from sidecar.canon import (
    GENESIS_PREV_HASH,
    canonical_json_bytes,
    canonical_json_str,
    compute_entry_hash,
)
from sidecar.store import (
    append_entry,
    count_entries,
    get_entries,
    get_entry,
    get_last_entry,
    init_db,
)
from tools.gen_events import make_event

ROOT = Path(__file__).resolve().parents[1]
SAMPLE_PATH = ROOT / "samples" / "events.sample.jsonl"

EXPECTED_ENTRY_0_CANONICAL = (
    '{"actor":"asha","details":{"ip":"10.0.0.5"},"event_type":"login_success",'
    '"prev_hash":"0000000000000000000000000000000000000000000000000000000000000000",'
    '"seq":0,"source":"app","ts":"2026-10-12T09:15:30Z"}'
)

EXPECTED_HASHES = [
    "6838b198eaec15fe5a4e73266e04f912bd99c230c81dcae534fd0e3d019a8053",
    "75397be4962e1d5a605cf9bda41ba3cc1e6b8100b2abcc0409b96735e3d44711",
    "20da29a9023ae11b33d97e95c4c2563762cc51aca7dcb7964dd6f70a088e75b3",
    "9b6e549dae35527ebabf1a2a63160c4fce5c4419b67bae7807b0ea28f05d3a6d",
    "5f169c5466e1a9d2f292cd8f6c061c5915f03986deb2ac21be626e562eeaf61b",
]


def test_canonical_json_format() -> None:
    """Verify canonical JSON matches CONTRACT.md entry 0 canonical representation."""
    entry_payload = {
        "seq": 0,
        "ts": "2026-10-12T09:15:30Z",
        "source": "app",
        "actor": "asha",
        "event_type": "login_success",
        "details": {"ip": "10.0.0.5"},
        "prev_hash": GENESIS_PREV_HASH,
    }
    encoded = canonical_json_str(entry_payload)
    assert encoded == EXPECTED_ENTRY_0_CANONICAL
    assert canonical_json_bytes(entry_payload) == EXPECTED_ENTRY_0_CANONICAL.encode("utf-8")


def test_five_sample_entry_hashes(tmp_path: Path) -> None:
    """Verify the first 5 sample lines produce the exact hashes from CONTRACT.md section 3."""
    db_file = tmp_path / "sidecar.db"
    conn = init_db(db_file)

    sample_lines = SAMPLE_PATH.read_text(encoding="utf-8").strip().splitlines()
    sample_events = [json.loads(line) for line in sample_lines[:5]]

    appended_entries = []
    for raw in sample_events:
        entry = append_entry(conn, raw)
        appended_entries.append(entry)

    assert len(appended_entries) == 5
    for i, expected_hash in enumerate(EXPECTED_HASHES):
        assert appended_entries[i]["seq"] == i
        assert appended_entries[i]["hash"] == expected_hash

    assert appended_entries[0]["prev_hash"] == GENESIS_PREV_HASH
    for i in range(1, 5):
        assert appended_entries[i]["prev_hash"] == appended_entries[i - 1]["hash"]


def test_100_entries_unbroken_chain(tmp_path: Path) -> None:
    """Appending 100 generated entries yields an unbroken, strictly verified hash chain."""
    db_file = tmp_path / "sidecar.db"
    conn = init_db(db_file)

    rng = random.Random(42)
    for _ in range(100):
        raw_event = make_event(rng, "2026-10-12T10:00:00Z")
        append_entry(conn, raw_event)

    assert count_entries(conn) == 100

    entries = get_entries(conn)
    assert len(entries) == 100

    for i, entry in enumerate(entries):
        assert entry["seq"] == i
        if i == 0:
            assert entry["prev_hash"] == GENESIS_PREV_HASH
        else:
            assert entry["prev_hash"] == entries[i - 1]["hash"]

        recomputed = compute_entry_hash(
            seq=entry["seq"],
            ts=entry["ts"],
            source=entry["source"],
            actor=entry["actor"],
            event_type=entry["event_type"],
            details=entry["details"],
            prev_hash=entry["prev_hash"],
        )
        assert entry["hash"] == recomputed


def test_db_queries_and_wal_mode(tmp_path: Path) -> None:
    """Verify WAL mode is enabled and querying by sequence number works."""
    db_file = tmp_path / "test_wal.db"
    conn = init_db(db_file)

    mode = conn.execute("PRAGMA journal_mode;").fetchone()[0]
    assert mode.lower() == "wal"

    assert get_last_entry(conn) is None
    assert get_entry(conn, 0) is None

    sample_event = {"source": "app", "ts": "2026-10-12T09:15:30Z", "actor": "asha",
                    "event_type": "login_success", "details": {"ip": "10.0.0.5"}}
    inserted = append_entry(conn, sample_event, received_at="2026-10-12T09:15:31Z")

    last = get_last_entry(conn)
    assert last is not None
    assert last["seq"] == 0
    assert last["hash"] == inserted["hash"]
    assert last["received_at"] == "2026-10-12T09:15:31Z"

    queried = get_entry(conn, 0)
    assert queried is not None
    assert queried["details"] == {"ip": "10.0.0.5"}
