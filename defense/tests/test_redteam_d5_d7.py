"""Regression tests for the D5-D7 red-team findings (see docs/red-team/RED_TEAM_D5_D7.md, one test per RT id)."""
import json
import random
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from sidecar import heartbeat as hbm
from sidecar.canon import compute_entry_hash
from sidecar.checkpoint import create_checkpoint
from sidecar.keys import generate_keypair, load_or_generate_keypair
from sidecar.store import append_entry, init_db
from tools.gen_events import make_event
from verifier.__main__ import main as verifier_main
from verifier.checks import verify_offline
from witness import checks
from witness.app import create_app


def _seeded(tmp_path: Path, n: int = 15) -> tuple[sqlite3.Connection, Any, Path]:
    """A sidecar DB with n entries and one signed checkpoint over all of them."""
    priv, _ = load_or_generate_keypair(tmp_path / "n.key", tmp_path / "n.pub")
    conn = init_db(tmp_path / "s.db")
    rng = random.Random(1)
    for _ in range(n):
        append_entry(conn, make_event(rng, "2026-10-12T10:00:00Z"))
    create_checkpoint(conn, "node-1", priv)
    return conn, priv, tmp_path / "n.pub"


def _codes(report: dict[str, Any]) -> list[str]:
    """Verdict codes of a verifier report."""
    return [v["code"] for v in report["verdicts"]]


def _config(tmp_path: Path, pub: Path) -> Path:
    """A minimal profile pointing the verifier at the seeded DB and key."""
    cfg = tmp_path / "config.toml"
    cfg.write_text(f'[paths]\ndb_path = "{(tmp_path / "s.db").as_posix()}"\n'
                   f'public_key_path = "{pub.as_posix()}"\n', encoding="utf-8")
    return cfg


def _witness(tmp_path: Path) -> tuple[Any, Any, Path]:
    """A witness app trusting one fresh node-1 key; returns (private key, app, witness db path)."""
    priv, pub = generate_keypair()
    (tmp_path / "nodes.toml").write_text(f'[nodes]\nnode-1 = "{pub}"\n', encoding="utf-8")
    cfg = tmp_path / "wcfg.toml"
    cfg.write_text(f'[heartbeat]\ninterval_s = 30\n[witness]\ndb_path = "{(tmp_path / "w.db").as_posix()}"\n'
                   f'port = 8800\nnodes_file = "{(tmp_path / "nodes.toml").as_posix()}"\n', encoding="utf-8")
    return priv, create_app(cfg), tmp_path / "w.db"


# RT-17: a forged entry with seq -1 and a correct hash was invisible.
def test_rt17_negative_seq_forgery_detected(tmp_path: Path) -> None:
    """A row below seq 0 is a SEQ_GAP, and the checkpoint check still runs."""
    conn, _, pub = _seeded(tmp_path)
    ev = {"seq": -1, "ts": "2026-10-12T10:00:00Z", "source": "app", "actor": "mallory",
          "event_type": "login_success", "details": {"ip": "1.2.3.4"}, "prev_hash": "0" * 64}
    conn.execute("INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                 (-1, ev["ts"], ev["source"], ev["actor"], ev["event_type"], json.dumps(ev["details"]),
                  ev["prev_hash"], compute_entry_hash(**ev), "x"))
    report = verify_offline(tmp_path / "s.db", pub)
    assert not report["clean"]
    assert report["verdicts"][0]["code"] == "SEQ_GAP" and report["verdicts"][0]["seq_from"] == -1


# RT-18: invalid JSON in one row crashed the verifier (exit 2) and hid every other verdict.
def test_rt18_unreadable_row_is_edit_not_crash(tmp_path: Path) -> None:
    """A corrupt details field is an EDIT verdict, and other tampering is still reported."""
    conn, _, pub = _seeded(tmp_path)
    conn.execute("UPDATE entries SET details = '{not json' WHERE seq = 3")
    conn.execute("UPDATE entries SET actor = 'mallory' WHERE seq = 9")
    report = verify_offline(tmp_path / "s.db", pub)
    edits = [(v["code"], v["seq_from"]) for v in report["verdicts"] if v["code"] == "EDIT"]
    assert edits == [("EDIT", 3), ("EDIT", 9)]
    assert verifier_main(["--config", str(_config(tmp_path, pub))]) == 1


# RT-19: deleting the public key file silently switched off checkpoint checks.
def test_rt19_missing_public_key_fails_closed(tmp_path: Path) -> None:
    """With the key file gone the verifier exits 2, never 'clean'."""
    conn, _, pub = _seeded(tmp_path)
    prev = "0" * 64
    for row in conn.execute("SELECT * FROM entries ORDER BY seq").fetchall():  # full re-chain, no key needed
        ev = {"seq": row["seq"], "ts": row["ts"], "source": row["source"], "actor": "nobody",
              "event_type": row["event_type"], "details": json.loads(row["details"]), "prev_hash": prev}
        prev = compute_entry_hash(**ev)
        conn.execute("UPDATE entries SET actor = 'nobody', prev_hash = ?, hash = ? WHERE seq = ?",
                     (ev["prev_hash"], prev, row["seq"]))
    assert _codes(verify_offline(tmp_path / "s.db", pub)) == ["CHECKPOINT_MISMATCH"]
    cfg = _config(tmp_path, pub)
    pub.unlink()
    with pytest.raises(FileNotFoundError):
        verify_offline(tmp_path / "s.db", pub)
    assert verifier_main(["--config", str(cfg)]) == 2


# RT-20: deleting the tail below a signed local checkpoint went unreported.
def test_rt20_truncation_below_checkpoint_detected(tmp_path: Path) -> None:
    """A signed checkpoint covering missing entries is a CHECKPOINT_MISMATCH."""
    conn, _, pub = _seeded(tmp_path, 15)
    conn.execute("DELETE FROM entries WHERE seq >= 10")
    report = verify_offline(tmp_path / "s.db", pub)
    assert _codes(report) == ["CHECKPOINT_MISMATCH"]
    assert "covers 15 entries" in report["verdicts"][0]["detail"]


def test_rt20_garbage_hash_does_not_crash_checkpoint_check(tmp_path: Path) -> None:
    """A non-hex stored hash gives EDIT plus CHECKPOINT_MISMATCH, not a verifier crash."""
    conn, _, pub = _seeded(tmp_path)
    conn.execute("UPDATE entries SET hash = 'XYZ' WHERE seq = 4")
    codes = _codes(verify_offline(tmp_path / "s.db", pub))
    assert "EDIT" in codes and "CHECKPOINT_MISMATCH" in codes


# RT-21: --witness was silently ignored and the result said clean.
def test_rt21_witness_flag_fails_closed_until_d8(tmp_path: Path) -> None:
    """Asking for witness checks that do not exist yet is an error, not a clean result."""
    _, _, pub = _seeded(tmp_path)
    assert verifier_main(["--config", str(_config(tmp_path, pub)), "--witness", "http://127.0.0.1:9"]) == 2


# RT-22: entries and checkpoints were read in separate snapshots.
def test_rt22_checkpoint_added_during_verify_is_consistent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A checkpoint written by the sidecar mid-verify is not seen, so no false mismatch."""
    import verifier.checks as vc
    conn, priv, pub = _seeded(tmp_path, 10)
    real_verify_entries = vc.verify_entries

    def entries_then_sidecar_writes(c: sqlite3.Connection) -> Any:
        """Read entries, then let the live sidecar append and checkpoint before checkpoints are read."""
        result = real_verify_entries(c)
        for _ in range(5):
            append_entry(conn, make_event(random.Random(9), "2026-10-12T10:00:00Z"))
        create_checkpoint(conn, "node-1", priv)
        return result

    monkeypatch.setattr(vc, "verify_entries", entries_then_sidecar_writes)
    report = verify_offline(tmp_path / "s.db", pub)
    assert report["clean"], report
    assert report["checked_entries"] == 10


# RT-23: random node_ids bypassed the alert throttle and grew the witness store without limit.
def test_rt23_unknown_node_flood_is_bounded(tmp_path: Path) -> None:
    """Junk from untrusted node_ids lands in one throttled bucket."""
    _, app, wdb = _witness(tmp_path)
    client = TestClient(app)
    base = {"hb_counter": 1, "head_seq": 0, "head_hash": "a" * 64, "tree_size": 1,
            "ts": "2026-10-12T09:15:30Z", "signature": "00"}
    for i in range(200):
        r = client.post("/heartbeat", json={**base, "node_id": f"x{i}"})
        assert r.json()["alerts"][0]["code"] == "BAD_SIGNATURE"
    rows = sqlite3.connect(wdb).execute("SELECT node_id, COUNT(*) FROM alerts GROUP BY node_id").fetchall()
    assert rows == [(checks.UNKNOWN_NODE, 1)]


# RT-24: a lost reply made the next pulse reuse the counter, a false COUNTER_REPLAY.
class _LostFirstReply(httpx.BaseTransport):
    """Delivers every request to the witness, but drops the first reply (a timeout)."""

    def __init__(self, app: Any) -> None:
        """Wrap a witness app."""
        self.client, self.dropped = TestClient(app), False

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        """Forward the request; lose the reply the first time."""
        r = self.client.request(request.method, str(request.url), content=request.content,
                                headers=dict(request.headers))
        if not self.dropped:
            self.dropped = True
            raise httpx.ReadTimeout("reply lost")
        return httpx.Response(r.status_code, content=r.content, headers=r.headers)


def test_rt24_lost_reply_no_false_counter_replay(tmp_path: Path) -> None:
    """After a delivered-but-unanswered heartbeat, the next one raises no alert."""
    priv, app, _ = _witness(tmp_path)
    conn = init_db(tmp_path / "s.db")
    client = httpx.Client(transport=_LostFirstReply(app), base_url="http://w")
    assert hbm.pulse_once(conn, client, "node-1", priv, "http://w", 0)[0] is False
    append_entry(conn, make_event(random.Random(1), "2026-10-12T10:00:00Z"))
    assert hbm.pulse_once(conn, client, "node-1", priv, "http://w", 1)[0] is True
    assert TestClient(app).get("/alerts", params={"node_id": "node-1"}).json() == []


def test_rt24_crash_after_send_restart_no_false_replay(tmp_path: Path) -> None:
    """A heartbeat that reached the witness just before a crash is never re-sent with the same counter."""
    priv, app, _ = _witness(tmp_path)
    conn = init_db(tmp_path / "s.db")
    client = httpx.Client(transport=_LostFirstReply(app), base_url="http://w")
    hbm.pulse_once(conn, client, "node-1", priv, "http://w", 0)  # delivered, then the sidecar "dies"
    conn.close()
    conn = init_db(tmp_path / "s.db")  # restart
    assert hbm.pulse_once(conn, TestClient(app), "node-1", priv, "", 0)[0] is True
    assert TestClient(app).get("/alerts", params={"node_id": "node-1"}).json() == []


# RT-25: one DB error killed the heartbeat thread for good.
def test_rt25_heartbeat_thread_survives_db_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A transient error in one pulse is logged and the loop keeps pulsing."""
    priv, _, _ = _witness(tmp_path)
    init_db(tmp_path / "s.db")
    calls: list[int] = []
    real_pulse = hbm.pulse_once

    def flaky_pulse(*args: Any, **kwargs: Any) -> Any:
        """Fail the first pulse like a locked database, then behave normally."""
        calls.append(1)
        if len(calls) == 1:
            raise sqlite3.OperationalError("database is locked")
        return real_pulse(*args, **kwargs)

    monkeypatch.setattr(hbm, "pulse_once", flaky_pulse)
    stop = threading.Event()
    th = hbm.start_heartbeat_thread(tmp_path / "s.db", "node-1", priv, "http://127.0.0.1:9", 0.05, stop, 0.1)
    time.sleep(0.6)
    alive = th.is_alive()
    stop.set()
    th.join(timeout=3.0)
    assert alive and len(calls) >= 2  # a second pulse ran after the error


# RT-26: checkpoints the witness refused were only logged at DEBUG.
def test_rt26_rejected_checkpoint_upload_is_logged(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    """A checkpoint the witness will not store produces a WARNING on the sidecar."""
    priv, app, _ = _witness(tmp_path)
    conn = init_db(tmp_path / "s.db")
    append_entry(conn, make_event(random.Random(2), "2026-10-12T10:00:00Z"))
    create_checkpoint(conn, "node-1", generate_keypair()[0])  # signed with a key the witness does not trust
    with caplog.at_level("WARNING", logger="sidecar.heartbeat"):
        assert hbm.pulse_once(conn, TestClient(app), "node-1", priv, "", 0)[0] is True
    assert hbm.get_uploaded_tree_size(conn) == 0
    assert any("did not store checkpoint" in r.message for r in caplog.records)
