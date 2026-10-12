"""D7 tests: heartbeat client loop, counter persistence, resilience, and checkpoint upload."""
import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

import httpx
import pytest

from sidecar.checkpoint import create_checkpoint
from sidecar.heartbeat import (
    build_heartbeat,
    get_persisted_counter,
    get_uploaded_tree_size,
    pulse_once,
    run_heartbeat_loop,
    send_heartbeat,
    set_persisted_counter,
    start_heartbeat_thread,
    upload_pending_checkpoints,
)
from sidecar.keys import generate_keypair, verify_payload
from sidecar.store import append_entry, init_db
from witness.app import create_app


@pytest.fixture
def test_setup(tmp_path: Path) -> dict[str, Any]:
    """Create a temporary test environment with a sidecar DB and a witness app."""
    priv, pub = generate_keypair()
    node_id = "node-1"

    nodes_file = tmp_path / "witness_nodes.toml"
    nodes_file.write_text(f'[nodes]\n"{node_id}" = "{pub}"\n', encoding="utf-8")

    witness_db = tmp_path / "witness.db"
    witness_cfg = tmp_path / "witness_config.toml"
    witness_cfg.write_text(
        f'[heartbeat]\ninterval_s = 30\n[witness]\ndb_path = "{witness_db.as_posix()}"\n'
        f'port = 8800\nnodes_file = "{nodes_file.as_posix()}"\n',
        encoding="utf-8",
    )

    app = create_app(witness_cfg)
    sidecar_db_path = tmp_path / "sidecar.db"
    sidecar_conn = init_db(sidecar_db_path)

    return {
        "priv": priv,
        "pub": pub,
        "node_id": node_id,
        "sidecar_db": sidecar_db_path,
        "sidecar_conn": sidecar_conn,
        "app": app,
    }


def test_build_heartbeat(test_setup: dict[str, Any]) -> None:
    """Build and verify heartbeat payloads for empty and populated databases."""
    conn = test_setup["sidecar_conn"]
    priv = test_setup["priv"]
    pub = test_setup["pub"]
    node_id = test_setup["node_id"]

    hb_empty = build_heartbeat(conn, node_id, priv, counter=1)
    assert hb_empty["node_id"] == node_id
    assert hb_empty["hb_counter"] == 1
    assert hb_empty["head_seq"] == -1
    assert hb_empty["tree_size"] == 0
    assert hb_empty["head_hash"] == "0" * 64
    payload_no_sig = {k: v for k, v in hb_empty.items() if k != "signature"}
    assert verify_payload(pub, hb_empty["signature"], payload_no_sig)

    append_entry(
        conn,
        {
            "ts": "2026-10-12T09:15:30Z",
            "source": "app",
            "actor": "alice",
            "event_type": "user_login",
            "details": {"ip": "10.0.0.1"},
        },
    )

    hb_one = build_heartbeat(conn, node_id, priv, counter=2)
    assert hb_one["hb_counter"] == 2
    assert hb_one["head_seq"] == 0
    assert hb_one["tree_size"] == 1
    assert hb_one["head_hash"] != "0" * 64
    payload_one_no_sig = {k: v for k, v in hb_one.items() if k != "signature"}
    assert verify_payload(pub, hb_one["signature"], payload_one_no_sig)


def test_pulse_sequence_and_witness_recording(test_setup: dict[str, Any]) -> None:
    """Run sequential pulses through TestClient and verify witness intake."""
    from fastapi.testclient import TestClient

    conn = test_setup["sidecar_conn"]
    priv = test_setup["priv"]
    node_id = test_setup["node_id"]
    app = test_setup["app"]

    with TestClient(app) as client:
        ok1, streak1 = pulse_once(conn, client, node_id, priv, "http://testserver", 0)
        assert ok1 is True
        assert streak1 == 0
        assert get_persisted_counter(conn) == 1

        append_entry(
            conn,
            {
                "ts": "2026-10-12T09:15:30Z",
                "source": "app",
                "actor": "alice",
                "event_type": "user_login",
                "details": {"action": "login"},
            },
        )
        ok2, streak2 = pulse_once(conn, client, node_id, priv, "http://testserver", 0)
        assert ok2 is True
        assert streak2 == 0
        assert get_persisted_counter(conn) == 2

        resp = client.get(f"/heartbeats?node_id={node_id}&limit=10")
        assert resp.status_code == 200
        hb_list = resp.json()
        assert len(hb_list) == 2
        assert [h["hb_counter"] for h in hb_list] == [1, 2]

        alerts_resp = client.get(f"/alerts?node_id={node_id}")
        assert alerts_resp.status_code == 200
        assert alerts_resp.json() == []


def test_checkpoint_upload_to_witness(test_setup: dict[str, Any]) -> None:
    """Verify that generated checkpoints are uploaded and not re-uploaded."""
    from fastapi.testclient import TestClient

    conn = test_setup["sidecar_conn"]
    priv = test_setup["priv"]
    node_id = test_setup["node_id"]
    app = test_setup["app"]

    append_entry(
        conn,
        {
            "ts": "2026-10-12T09:15:30Z",
            "source": "app",
            "actor": "bob",
            "event_type": "transfer",
            "details": {"amt": 100},
        },
    )
    cp = create_checkpoint(conn, node_id, priv)
    assert cp is not None

    with TestClient(app) as client:
        count = upload_pending_checkpoints(conn, client, "http://testserver")
        assert count == 1
        assert get_uploaded_tree_size(conn) == 1

        count_again = upload_pending_checkpoints(conn, client, "http://testserver")
        assert count_again == 0

        resp = client.get(f"/checkpoints?node_id={node_id}")
        assert resp.status_code == 200
        checkpoints = resp.json()
        assert len(checkpoints) == 1
        assert checkpoints[0]["tree_size"] == 1


def test_witness_down_retry_and_resumption(test_setup: dict[str, Any]) -> None:
    """Verify failed pulses still advance the counter, and the witness accepts the gap with no replay."""
    from fastapi.testclient import TestClient

    conn = test_setup["sidecar_conn"]
    priv = test_setup["priv"]
    node_id = test_setup["node_id"]
    app = test_setup["app"]

    with TestClient(app) as client:
        ok1, streak1 = pulse_once(conn, client, node_id, priv, "http://testserver", 0)
        assert ok1 is True
        assert get_persisted_counter(conn) == 1

    # Witness is down: simulated with invalid port/non-responsive client
    dead_transport = httpx.MockTransport(lambda req: httpx.Response(503))
    dead_client = httpx.Client(transport=dead_transport, base_url="http://deadwitness")
    try:
        ok_fail, streak_fail = pulse_once(conn, dead_client, node_id, priv, "http://deadwitness", 0)
        assert ok_fail is False
        assert streak_fail == 1
        assert get_persisted_counter(conn) == 2

        # Next pulse uses a NEW counter 3: a counter is never reused, even if the send failed
        ok_fail2, streak_fail2 = pulse_once(conn, dead_client, node_id, priv, "http://deadwitness", streak_fail)
        assert ok_fail2 is False
        assert streak_fail2 == 2
        assert get_persisted_counter(conn) == 3
    finally:
        dead_client.close()

    # Witness is back up: receives counter 4 (gap after 1) and accepts it without COUNTER_REPLAY
    with TestClient(app) as client:
        ok_resumed, streak_resumed = pulse_once(conn, client, node_id, priv, "http://testserver", streak_fail2)
        assert ok_resumed is True
        assert streak_resumed == 0
        assert get_persisted_counter(conn) == 4

        alerts_resp = client.get(f"/alerts?node_id={node_id}")
        assert alerts_resp.status_code == 200
        assert alerts_resp.json() == []


def test_sidecar_restart_resumes_counter_without_replay(test_setup: dict[str, Any]) -> None:
    """Verify restarting sidecar loads persisted counter and increments cleanly."""
    from fastapi.testclient import TestClient

    db_path = test_setup["sidecar_db"]
    priv = test_setup["priv"]
    node_id = test_setup["node_id"]
    app = test_setup["app"]

    with TestClient(app) as client:
        conn1 = init_db(db_path)
        ok1, _ = pulse_once(conn1, client, node_id, priv, "http://testserver", 0)
        assert ok1 is True
        assert get_persisted_counter(conn1) == 1
        conn1.close()

        # Simulate sidecar restart: open fresh connection
        conn2 = init_db(db_path)
        assert get_persisted_counter(conn2) == 1

        ok2, _ = pulse_once(conn2, client, node_id, priv, "http://testserver", 0)
        assert ok2 is True
        assert get_persisted_counter(conn2) == 2

        alerts_resp = client.get(f"/alerts?node_id={node_id}")
        assert alerts_resp.status_code == 200
        assert alerts_resp.json() == []
        conn2.close()


def test_start_heartbeat_thread_lifecycle(test_setup: dict[str, Any]) -> None:
    """Verify background heartbeat thread runs and stops gracefully."""
    db_path = test_setup["sidecar_db"]
    priv = test_setup["priv"]
    node_id = test_setup["node_id"]

    stop_event = threading.Event()
    th = start_heartbeat_thread(
        db_path=db_path,
        node_id=node_id,
        private_key=priv,
        witness_url="http://localhost:9999",
        interval_s=0.05,
        stop_event=stop_event,
        timeout_s=0.1,
    )
    assert th.is_alive()
    time.sleep(0.15)
    stop_event.set()
    th.join(timeout=3.0)
    assert not th.is_alive()
