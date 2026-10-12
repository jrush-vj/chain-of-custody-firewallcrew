"""Regression tests for red-team findings RT-28 to RT-38 and carried RT-16, RT-27 (see docs/red-team/RED_TEAM_D8_D10.md)."""
import json
import re
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import verifier.checks as vchecks
from sidecar.canon import GENESIS_PREV_HASH, compute_entry_hash
from sidecar.checkpoint import create_checkpoint
from sidecar.heartbeat import build_heartbeat, pulse_once
from sidecar.keys import generate_keypair
from sidecar.store import append_entry, get_connection, init_db
from verifier.__main__ import main as verifier_main
from witness.app import MAX_BODY_BYTES, create_app

NODE = "node-1"
CP_KEYS = ("node_id", "tree_size", "head_seq", "head_hash", "root_hash", "ts", "signature")


def _event(i: int) -> dict[str, Any]:
    """Build one valid RawEvent."""
    return {"ts": "2026-10-12T09:15:30Z", "source": "app", "actor": f"u{i}", "event_type": "transfer",
            "details": {"amount": str(i)}}


@pytest.fixture
def env(tmp_path: Path) -> dict[str, Any]:
    """Sidecar DB with 6 entries and a checkpoint, witness that saw one heartbeat and the checkpoint."""
    priv, pub = generate_keypair()
    (tmp_path / "nodes.toml").write_text(f'[nodes]\n"{NODE}" = "{pub}"\n', encoding="utf-8")
    (tmp_path / "w.toml").write_text(
        f'[heartbeat]\ninterval_s = 30\n[witness]\ndb_path = "{(tmp_path / "w.db").as_posix()}"\n'
        f'port = 8800\nnodes_file = "{(tmp_path / "nodes.toml").as_posix()}"\n', encoding="utf-8")
    app = create_app(tmp_path / "w.toml")
    (tmp_path / "node1.pub").write_text(pub, encoding="utf-8")
    conn = init_db(tmp_path / "s.db")
    for i in range(6):
        append_entry(conn, _event(i))
    create_checkpoint(conn, NODE, priv)
    with TestClient(app) as c:
        pulse_once(conn, c, NODE, priv, "http://testserver", 0)
    return {"dir": tmp_path, "priv": priv, "app": app, "conn": conn}


def _rechain(conn: Any, start: int) -> None:
    """Recompute prev_hash and hash from `start` to the head, as an attacker with DB access would."""
    head = conn.execute("SELECT MAX(seq) FROM entries").fetchone()[0]
    for s in range(start, head + 1):
        prev_row = conn.execute("SELECT hash FROM entries WHERE seq = ?", (s - 1,)).fetchone()
        prev = prev_row["hash"] if prev_row else GENESIS_PREV_HASH
        r = conn.execute("SELECT * FROM entries WHERE seq = ?", (s,)).fetchone()
        h = compute_entry_hash(seq=s, ts=r["ts"], source=r["source"], actor=r["actor"],
                               event_type=r["event_type"], details=json.loads(r["details"]), prev_hash=prev)
        conn.execute("UPDATE entries SET prev_hash = ?, hash = ? WHERE seq = ?", (prev, h, s))


def _rewrite_and_resign(env: dict[str, Any]) -> None:
    """Edit seq 2, re-chain, replace the local checkpoint with one signed by the stolen key."""
    conn = env["conn"]
    conn.execute("UPDATE entries SET details = ? WHERE seq = 2", (json.dumps({"amount": "999999"}),))
    _rechain(conn, 2)
    conn.execute("DELETE FROM checkpoints")
    create_checkpoint(conn, NODE, env["priv"])


def _verify(env: dict[str, Any], node_id: str | None = NODE) -> dict[str, Any]:
    """Run the verifier with the witness."""
    d = env["dir"]
    with TestClient(env["app"]) as c:
        return vchecks.verify(d / "s.db", d / "node1.pub", witness_url="http://testserver", node_id=node_id, client=c)


def _codes(report: dict[str, Any]) -> set[str]:
    """Return the set of verdict codes."""
    return {v["code"] for v in report["verdicts"]}


def test_rt28_forged_witness_history_with_stolen_key_is_fork(env: dict[str, Any]) -> None:
    """RT-28: re-sending the forged head to the witness must not hide the rewrite."""
    _rewrite_and_resign(env)
    cp = env["conn"].execute("SELECT * FROM checkpoints ORDER BY tree_size DESC LIMIT 1").fetchone()
    with TestClient(env["app"]) as c:
        c.post("/heartbeat", json=build_heartbeat(env["conn"], NODE, env["priv"], 50))
        c.post("/checkpoint", json={k: cp[k] for k in CP_KEYS})
    report = _verify(env)
    assert "FORK" in _codes(report)
    assert any("different head_hash values" in v["detail"] for v in report["verdicts"])


def test_rt28_witness_seq_rollback_alert_is_truncation(env: dict[str, Any]) -> None:
    """RT-28: a heartbeat with a lower head (truncate, then report) shows up as TRUNCATION."""
    conn = env["conn"]
    conn.execute("DELETE FROM entries WHERE seq >= 3")
    with TestClient(env["app"]) as c:
        c.post("/heartbeat", json=build_heartbeat(conn, NODE, env["priv"], 60))
    for i in range(10):  # regrow past the old head so the plain head comparison passes
        append_entry(conn, _event(100 + i))
    conn.execute("DELETE FROM checkpoints")
    report = _verify(env)
    assert any(v["code"] == "TRUNCATION" and "SEQ_ROLLBACK" in v["detail"] for v in report["verdicts"])


def test_rt29_unknown_node_id_fails_closed(env: dict[str, Any]) -> None:
    """RT-29: an edited node_id that the witness never saw is a verifier failure, never clean."""
    _rewrite_and_resign(env)
    with pytest.raises(RuntimeError, match="no heartbeats or checkpoints"):
        _verify(env, node_id="ghost")
    with pytest.raises(ValueError, match="needs a node id"):
        _verify(env, node_id=None)


def test_rt29_cli_node_id_overrides_config(env: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    """RT-29: --node-id wins over the audited host's config; the ghost id in config is ignored."""
    d = env["dir"]
    cfg = d / "config.toml"
    cfg.write_text(f'[node]\nnode_id = "ghost"\n[paths]\ndb_path = "{(d / "s.db").as_posix()}"\n'
                   f'public_key_path = "{(d / "node1.pub").as_posix()}"\n', encoding="utf-8")
    seen: list[str] = []
    real_fetch = vchecks.fetch_witness

    def fake_fetch(node_id: str, url: str, client: Any = None) -> Any:
        seen.append(node_id)
        with TestClient(env["app"]) as c:
            return real_fetch(node_id, "http://testserver", client=c)

    monkeypatch.setattr(vchecks, "fetch_witness", fake_fetch)
    assert verifier_main(["--config", str(cfg), "--witness", "http://x"]) == 2
    assert verifier_main(["--config", str(cfg), "--witness", "http://x", "--node-id", NODE]) == 0
    assert seen == ["ghost", NODE]


def test_rt30_live_append_during_verify_is_not_truncation(env: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    """RT-30: a new entry plus heartbeat during the verifier run gives no false TRUNCATION."""
    d, real_verify_entries = env["dir"], vchecks.verify_entries

    def racing_verify_entries(conn: Any) -> Any:
        result = real_verify_entries(conn)  # the local snapshot is fixed by now
        writer = get_connection(d / "s.db")
        append_entry(writer, _event(99))
        with TestClient(env["app"]) as c:
            pulse_once(writer, c, NODE, env["priv"], "http://testserver", 0)
        writer.close()
        return result

    monkeypatch.setattr(vchecks, "verify_entries", racing_verify_entries)
    report = _verify(env)
    assert report["clean"] is True, report["verdicts"]


def test_rt36_silence_verdict_says_when(env: dict[str, Any]) -> None:
    """RT-36: the SILENCE verdict carries the witness's receive time."""
    from witness import store as wstore
    w = wstore.connect(env["dir"] / "w.db")
    wstore.insert_alert(w, NODE, "SILENCE", "no valid heartbeat", "2026-10-12T10:00:00Z", 1.0)
    w.close()
    silence = [v for v in _verify(env)["verdicts"] if v["code"] == "SILENCE"]
    assert len(silence) == 1 and "2026-10-12T10:00:00Z" in silence[0]["detail"]


def test_rt27_witness_rejects_large_bodies(env: dict[str, Any]) -> None:
    """RT-27: oversized bodies are refused, declared or chunked, and nothing is stored."""
    big = b'{"x":"' + b"a" * (MAX_BODY_BYTES + 10) + b'"}'
    with TestClient(env["app"]) as c:
        before = len(c.get("/alerts", params={"node_id": NODE}).json())
        r = c.post("/heartbeat", content=big, headers={"content-type": "application/json"})
        assert r.status_code == 413
        r = c.post("/heartbeat", content=iter([big[:8000], big[8000:]]), headers={"content-type": "application/json"})
        assert r.status_code == 400  # reading stops at the limit; FastAPI answers 400
        assert len(c.get("/alerts", params={"node_id": NODE}).json()) == before
        assert c.post("/heartbeat", json=build_heartbeat(env["conn"], NODE, env["priv"], 70)).json() == {"status": "ok"}


def test_rt32_witness_nodes_file_override(tmp_path: Path) -> None:
    """RT-32: --nodes-file lets the witness start when the profile's nodes_file is not in its volume."""
    _, pub = generate_keypair()
    nodes = tmp_path / "etc" / "witness_nodes.toml"
    nodes.parent.mkdir()
    nodes.write_text(f'[nodes]\n"{NODE}" = "{pub}"\n', encoding="utf-8")
    cfg = tmp_path / "config.toml"
    cfg.write_text(f'[heartbeat]\ninterval_s = 30\n[witness]\ndb_path = "{(tmp_path / "w.db").as_posix()}"\n'
                   f'port = 8800\nnodes_file = "{(tmp_path / "missing.toml").as_posix()}"\n', encoding="utf-8")
    with pytest.raises(FileNotFoundError):
        create_app(cfg)
    assert create_app(cfg, nodes_file=nodes) is not None


def test_rt31_rt33_compose_paths_match_the_profile() -> None:
    """RT-31/32/33: spool at /app/spool read-only, witness by service name, nodes file mounted."""
    compose = Path("defence-compose.yml").read_text(encoding="utf-8")
    assert re.search(r"\$\{SPOOL_DIR:-\./spool\}:/app/spool:ro", compose)
    assert '"--witness-url", "http://witness:8800"' in compose
    assert "./data/witness_nodes.toml:/etc/coc/witness_nodes.toml:ro" in compose
    assert '"--nodes-file", "/etc/coc/witness_nodes.toml"' in compose
    sidecar_block = compose.split("  witness:")[0]
    assert "witness-data" not in sidecar_block  # the sidecar never mounts the witness volume


def test_rt34_dockerignore_keeps_secrets_out() -> None:
    """RT-34: keys, DBs, config and the spool never reach the image builder."""
    ignored = Path(".dockerignore").read_text(encoding="utf-8").split()
    for pattern in ("data/", "spool/", "config.toml", "*.key", "*.db", ".venv/"):
        assert pattern in ignored


def test_rt16_requirements_pinned() -> None:
    """RT-16: every requirement has an exact version."""
    lines = [ln.strip() for ln in Path("requirements.txt").read_text(encoding="utf-8").splitlines()]
    reqs = [ln for ln in lines if ln and not ln.startswith("#")]
    assert reqs and all(re.fullmatch(r"[A-Za-z0-9_.-]+==[0-9][0-9A-Za-z.]*", r) for r in reqs)
