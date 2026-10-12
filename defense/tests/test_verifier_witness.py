"""D8 tests: verifier online checks with witness for TRUNCATION, FORK, and SILENCE."""
import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
import pytest

from sidecar.canon import compute_entry_hash
from sidecar.heartbeat import pulse_once
from sidecar.keys import generate_keypair
from sidecar.store import append_entry, init_db
from verifier import __main__ as verifier_main
from verifier.checks import verify
from witness import store as witness_store
from witness.app import create_app


@pytest.fixture
def test_env(tmp_path: Path) -> dict[str, Any]:
    """Setup a test environment with sidecar DB, witness app, and config file."""
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

    db_path = tmp_path / "sidecar.db"
    pub_path = tmp_path / "node1.pub"
    pub_path.write_text(pub, encoding="utf-8")
    priv_path = tmp_path / "node1.key"

    config_path = tmp_path / "config.toml"
    config_path.write_text(
        f'[node]\nnode_id = "{node_id}"\n'
        f'[paths]\ndb_path = "{db_path.as_posix()}"\n'
        f'public_key_path = "{pub_path.as_posix()}"\n'
        f'private_key_path = "{priv_path.as_posix()}"\n'
        f'spool_path = "spool.jsonl"\n',
        encoding="utf-8",
    )

    conn = init_db(db_path)
    for i in range(5):
        append_entry(
            conn,
            {
                "ts": "2026-10-12T09:15:30Z",
                "source": "app",
                "actor": f"user{i}",
                "event_type": "login",
                "details": {"seq_idx": i},
            },
        )

    # Pulse witness so it records head_seq=4
    with TestClient(app) as client:
        pulse_once(conn, client, node_id, priv, "http://testserver", 0)

    return {
        "node_id": node_id,
        "conn": conn,
        "db_path": db_path,
        "pub_path": pub_path,
        "config_path": config_path,
        "app": app,
        "witness_db": witness_db,
    }


def test_clean_with_witness(test_env: dict[str, Any]) -> None:
    """Unmodified database matching witness records reports clean and exits 0."""
    with TestClient(test_env["app"]) as client:
        res = verify(
            test_env["db_path"],
            test_env["pub_path"],
            witness_url="http://testserver",
            node_id=test_env["node_id"],
            client=client,
        )
        assert res["clean"] is True
        assert res["verdicts"] == []
        assert res["checked_entries"] == 5


def test_truncation_detection(test_env: dict[str, Any]) -> None:
    """Deleting tail entries produces TRUNCATION verdict."""
    conn = test_env["conn"]
    # Delete seq 3 and seq 4 (witness recorded up to 4)
    conn.execute("DELETE FROM entries WHERE seq >= 3")

    with TestClient(test_env["app"]) as client:
        res = verify(
            test_env["db_path"],
            test_env["pub_path"],
            witness_url="http://testserver",
            node_id=test_env["node_id"],
            client=client,
        )
        assert res["clean"] is False
        trunc_verdicts = [v for v in res["verdicts"] if v["code"] == "TRUNCATION"]
        assert len(trunc_verdicts) == 1
        assert trunc_verdicts[0]["seq_from"] == 3
        assert trunc_verdicts[0]["seq_to"] == 4


def test_fork_detection(test_env: dict[str, Any]) -> None:
    """Rewriting from an entry and re-chaining forward produces FORK verdict."""
    conn = test_env["conn"]
    # Rewrite entry 2 and re-chain entries 3 and 4 forward
    conn.execute(
        "UPDATE entries SET details = ? WHERE seq = 2",
        (json.dumps({"forged": True}),),
    )
    # Recompute hashes for 2, 3, 4 so chain is internally consistent
    for s in (2, 3, 4):
        prev = conn.execute("SELECT hash FROM entries WHERE seq = ?", (s - 1,)).fetchone()["hash"]
        row = conn.execute("SELECT * FROM entries WHERE seq = ?", (s,)).fetchone()
        new_h = compute_entry_hash(
            seq=s,
            ts=row["ts"],
            source=row["source"],
            actor=row["actor"],
            event_type=row["event_type"],
            details=json.loads(row["details"]),
            prev_hash=prev,
        )
        conn.execute("UPDATE entries SET prev_hash = ?, hash = ? WHERE seq = ?", (prev, new_h, s))

    with TestClient(test_env["app"]) as client:
        res = verify(
            test_env["db_path"],
            test_env["pub_path"],
            witness_url="http://testserver",
            node_id=test_env["node_id"],
            client=client,
        )
        assert res["clean"] is False
        fork_verdicts = [v for v in res["verdicts"] if v["code"] == "FORK"]
        assert len(fork_verdicts) > 0
        assert fork_verdicts[0]["seq_from"] == 4  # seq 4 was recorded in witness heartbeat


def test_silence_detection(test_env: dict[str, Any]) -> None:
    """Witness alert of type SILENCE produces SILENCE verdict."""
    # Insert a SILENCE alert directly into witness database
    w_conn = witness_store.connect(test_env["witness_db"])
    witness_store.insert_alert(
        w_conn,
        test_env["node_id"],
        "SILENCE",
        "silence threshold exceeded",
        "2026-10-12T10:00:00Z",
        1800000000.0,
    )
    w_conn.close()

    with TestClient(test_env["app"]) as client:
        res = verify(
            test_env["db_path"],
            test_env["pub_path"],
            witness_url="http://testserver",
            node_id=test_env["node_id"],
            client=client,
        )
        assert res["clean"] is False
        silence_verdicts = [v for v in res["verdicts"] if v["code"] == "SILENCE"]
        assert len(silence_verdicts) == 1


def test_cli_exit_code_and_unreachable_witness(test_env: dict[str, Any], monkeypatch: Any) -> None:
    """CLI exits 2 when witness service cannot be reached."""
    config_path = test_env["config_path"]

    # Dead witness port
    code = verifier_main.main(["--config", str(config_path), "--witness", "http://127.0.0.1:9999"])
    assert code == 2
