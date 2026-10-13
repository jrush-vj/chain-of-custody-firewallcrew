import json
from pathlib import Path

from coc.spooldiff import compare_spool, describe
from sidecar.ingest import ingest_batch
from sidecar.store import init_db


def test_spool_vs_record_reports_changed_amount(tmp_path: Path) -> None:
    event = {
        "source": "db",
        "ts": "2026-01-01T00:00:00Z",
        "actor": "unknown",
        "event_type": "transaction_created",
        "details": {"amount": 5000},
    }
    spool = tmp_path / "events.jsonl"
    spool.write_bytes((json.dumps(event) + "\n").encode("utf-8"))
    conn = init_db(tmp_path / "sidecar.db")
    try:
        assert ingest_batch(conn, spool) == 1
        assert compare_spool(tmp_path / "sidecar.db", spool)["changed"] == []

        event["details"]["amount"] = 5
        spool.write_bytes((json.dumps(event) + "\n").encode("utf-8"))
        report = compare_spool(tmp_path / "sidecar.db", spool)

        assert len(report["changed"]) == 1
        assert "details.amount recorded 5000, spool now 5" in describe(report["changed"][0])
    finally:
        conn.close()
