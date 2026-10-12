"""D3 tests: spool file ingestion, restart resilience, and edge case handling."""
import random
import threading
import time
from pathlib import Path

import pytest

from sidecar.ingest import follow_spool, ingest_batch
from sidecar.store import count_entries, get_entries, get_state, init_db
from tools.gen_events import append_event, generate, make_event

VALID_EVENT_1 = {
    "source": "app",
    "ts": "2026-10-12T09:15:30Z",
    "actor": "asha",
    "event_type": "login_success",
    "details": {"ip": "10.0.0.5"},
}

VALID_EVENT_2 = {
    "source": "db",
    "ts": "2026-10-12T09:16:02Z",
    "actor": "asha",
    "event_type": "transaction_created",
    "details": {"txn_id": "1001", "amount": "1250.00"},
}


def test_ingest_from_spool_grows(tmp_path: Path) -> None:
    """Entry count in database grows as lines are appended to the spool."""
    db_file = tmp_path / "sidecar.db"
    spool_file = tmp_path / "events.jsonl"
    conn = init_db(db_file)

    generate(spool_file, count=25, rate=0, rng=random.Random(1))
    ingested = ingest_batch(conn, spool_file)

    assert ingested == 25
    assert count_entries(conn) == 25
    assert int(get_state(conn, "spool_offset") or "0") == spool_file.stat().st_size


def test_stop_and_restart_no_duplicates_no_missed(tmp_path: Path) -> None:
    """Stopping and restarting sidecar ingest avoids duplicate entries and misses."""
    db_file = tmp_path / "sidecar.db"
    spool_file = tmp_path / "events.jsonl"

    conn = init_db(db_file)
    generate(spool_file, count=20, rate=0, rng=random.Random(2))
    assert ingest_batch(conn, spool_file) == 20
    conn.close()

    generate(spool_file, count=15, rate=0, rng=random.Random(3))

    conn2 = init_db(db_file)
    new_ingested = ingest_batch(conn2, spool_file)
    assert new_ingested == 15
    assert count_entries(conn2) == 35

    entries = get_entries(conn2)
    assert len(entries) == 35
    for i, entry in enumerate(entries):
        assert entry["seq"] == i


def test_partial_line_handling(tmp_path: Path) -> None:
    """A half-written line at the end of the spool is not ingested until completed."""
    db_file = tmp_path / "sidecar.db"
    spool_file = tmp_path / "events.jsonl"
    conn = init_db(db_file)

    append_event(spool_file, VALID_EVENT_1)

    half_line = b'{"source":"db","ts":"2026-10-12T09:16:02Z"'
    with open(spool_file, "ab") as f:
        f.write(half_line)

    ingested = ingest_batch(conn, spool_file)
    assert ingested == 1
    assert count_entries(conn) == 1

    rest_of_line = b',"actor":"asha","event_type":"transaction_created","details":{"amount":"10.00"}}\n'
    with open(spool_file, "ab") as f:
        f.write(rest_of_line)

    ingested_second = ingest_batch(conn, spool_file)
    assert ingested_second == 1
    assert count_entries(conn) == 2


def test_bad_lines_skipped_without_crashing(tmp_path: Path) -> None:
    """Corrupted lines and contract-violating lines are skipped while valid ones are kept."""
    db_file = tmp_path / "sidecar.db"
    spool_file = tmp_path / "events.jsonl"
    conn = init_db(db_file)

    append_event(spool_file, VALID_EVENT_1)

    with open(spool_file, "ab") as f:
        f.write(b"not valid json at all\n")
        f.write(b'{"source":"db","ts":"2026-10-12T09:16:02Z","actor":"asha","event_type":"custom_type","details":{"amount":12.5}}\n')
        f.write(b'{"source":"db","ts":"2026-10-12T09:16:02Z","actor":"asha","event_type":"disallowed_type","details":{}}\n')

    append_event(spool_file, VALID_EVENT_2)

    ingested = ingest_batch(conn, spool_file, allowed_types={"login_success", "transaction_created"})
    assert ingested == 2
    assert count_entries(conn) == 2

    entries = get_entries(conn)
    assert entries[0]["event_type"] == "login_success"
    assert entries[1]["event_type"] == "transaction_created"
    assert entries[1]["seq"] == 1


def test_spool_file_shrunk_raises_error(tmp_path: Path) -> None:
    """If the spool file shrinks or is truncated, a RuntimeError is raised."""
    db_file = tmp_path / "sidecar.db"
    spool_file = tmp_path / "events.jsonl"
    conn = init_db(db_file)

    generate(spool_file, count=10, rate=0, rng=random.Random(4))
    ingest_batch(conn, spool_file)

    with open(spool_file, "wb") as f:
        f.write(b'{"source":"app"}\n')

    with pytest.raises(RuntimeError, match="shrunk or replaced"):
        ingest_batch(conn, spool_file)


def test_live_generator_and_follow_spool(tmp_path: Path) -> None:
    """Generator and sidecar running together continuously ingest events."""
    db_file = tmp_path / "sidecar.db"
    spool_file = tmp_path / "events.jsonl"
    conn = init_db(db_file)

    stop_event = threading.Event()
    worker = threading.Thread(
        target=follow_spool,
        args=(conn, spool_file),
        kwargs={"poll_interval": 0.05, "stop_event": stop_event},
        daemon=True,
    )
    worker.start()

    rng = random.Random(5)
    for _ in range(30):
        append_event(spool_file, make_event(rng, "2026-10-12T09:30:00Z"))
        time.sleep(0.01)

    time.sleep(0.3)
    stop_event.set()
    worker.join(timeout=2.0)

    assert count_entries(conn) == 30
