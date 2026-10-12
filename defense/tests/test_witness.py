"""D6 tests: witness endpoints, the five alert rules, strict input and insert-only storage."""
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from sidecar.keys import generate_keypair, sign_payload
from witness import checks
from witness.app import create_app

T0 = 1_800_000_000.0  # 2027-01-15T08:00:00Z
INTERVAL_S = 30
WINDOW_S = 2 * INTERVAL_S + 15
ALERT_GAP = 11  # longer than the witness's alert throttle


class Clock:
    """Controllable witness clock."""

    def __init__(self, t: float) -> None:
        """Start at time t."""
        self.t = t

    def __call__(self) -> float:
        """Return the current fake time."""
        return self.t


def h(i: int) -> str:
    """Return a distinct 64-hex hash for number i."""
    return f"{i:064x}"


def signed(priv: Any, payload: dict[str, Any]) -> dict[str, Any]:
    """Return payload plus its signature."""
    return {**payload, "signature": sign_payload(priv, payload)}


def hb(priv: Any, counter: int, head_seq: int, head_hash: str, node: str = "node-1") -> dict[str, Any]:
    """Build a signed heartbeat."""
    return signed(priv, {"node_id": node, "hb_counter": counter, "head_seq": head_seq,
                         "head_hash": head_hash, "tree_size": head_seq + 1, "ts": "2026-10-12T09:15:30Z"})


def cp(priv: Any, tree_size: int, head_hash: str, root_hash: str, node: str = "node-1") -> dict[str, Any]:
    """Build a signed checkpoint."""
    return signed(priv, {"node_id": node, "tree_size": tree_size, "head_seq": tree_size - 1,
                         "head_hash": head_hash, "root_hash": root_hash, "ts": "2026-10-12T09:15:30Z"})


@pytest.fixture
def env(tmp_path: Path) -> SimpleNamespace:
    """A witness trusting node-1, with a controllable clock and a TestClient."""
    priv, pub = generate_keypair()
    nodes = tmp_path / "nodes.toml"
    nodes.write_text(f'[nodes]\nnode-1 = "{pub}"\n', encoding="utf-8")
    cfg = tmp_path / "config.toml"
    cfg.write_text(
        f'[heartbeat]\ninterval_s = {INTERVAL_S}\n[witness]\ndb_path = "{(tmp_path / "w.db").as_posix()}"\n'
        f'port = 8800\nnodes_file = "{nodes.as_posix()}"\n', encoding="utf-8")
    clock = Clock(T0)
    app = create_app(cfg, now=clock)
    return SimpleNamespace(priv=priv, clock=clock, app=app, client=TestClient(app))


def alerts_of(env: SimpleNamespace, code: str | None = None) -> list[dict[str, Any]]:
    """Fetch stored alerts for node-1."""
    params = {"node_id": "node-1", **({"code": code} if code else {})}
    return env.client.get("/alerts", params=params).json()


def codes(response: Any) -> list[str]:
    """Return the alert codes in a heartbeat or checkpoint response."""
    return [a["code"] for a in response.json().get("alerts", [])]


def test_normal_sequence_raises_nothing(env: SimpleNamespace) -> None:
    """A healthy node sending heartbeats and a checkpoint raises no alert at all."""
    for i in range(1, 6):
        env.clock.t += INTERVAL_S
        r = env.client.post("/heartbeat", json=hb(env.priv, i, i - 1, h(i)))
        assert r.status_code == 200 and r.json() == {"status": "ok"}
        assert env.app.state.sweep_silence() == []
    r = env.client.post("/checkpoint", json=cp(env.priv, 5, h(5), h(99)))
    assert r.json() == {"status": "stored"}
    assert alerts_of(env) == []
    assert len(env.client.get("/heartbeats", params={"node_id": "node-1"}).json()) == 5
    assert len(env.client.get("/checkpoints", params={"node_id": "node-1"}).json()) == 1


def test_bad_signature_variants(env: SimpleNamespace) -> None:
    """Tampered payload, wrong key and unknown node all raise BAD_SIGNATURE and are never stored as heartbeats."""
    other, _ = generate_keypair()
    tampered = hb(env.priv, 1, 0, h(1))
    tampered["head_seq"], tampered["tree_size"] = 7, 8
    attempts = [tampered, hb(other, 1, 0, h(1)), hb(env.priv, 1, 0, h(1), node="node-9")]
    for body in attempts:
        env.clock.t += ALERT_GAP
        r = env.client.post("/heartbeat", json=body)
        assert r.status_code == 200 and codes(r) == ["BAD_SIGNATURE"]
    assert env.client.get("/heartbeats", params={"node_id": "node-1"}).json() == []
    assert len(alerts_of(env, "BAD_SIGNATURE")) == 2


def test_counter_replay_only(env: SimpleNamespace) -> None:
    """Re-sending an old valid heartbeat raises COUNTER_REPLAY and nothing else."""
    old = hb(env.priv, 2, 1, h(2))
    for body in (hb(env.priv, 1, 0, h(1)), old, hb(env.priv, 3, 2, h(3))):
        assert env.client.post("/heartbeat", json=body).json() == {"status": "ok"}
    r = env.client.post("/heartbeat", json=old)
    assert codes(r) == ["COUNTER_REPLAY"]
    assert len(env.client.get("/heartbeats", params={"node_id": "node-1"}).json()) == 3
    assert [a["code"] for a in alerts_of(env)] == ["COUNTER_REPLAY"]


def test_counter_not_advancing_with_new_content_raises_replay_and_more(env: SimpleNamespace) -> None:
    """A new signed heartbeat reusing a low counter is a replay, and its content is still checked."""
    for body in (hb(env.priv, 1, 10, h(10)), hb(env.priv, 2, 11, h(11))):
        env.client.post("/heartbeat", json=body)
    r = env.client.post("/heartbeat", json=hb(env.priv, 1, 4, h(4)))
    assert codes(r) == ["COUNTER_REPLAY", "SEQ_ROLLBACK"]


def test_seq_rollback(env: SimpleNamespace) -> None:
    """A lower head_seq with a fresh counter raises SEQ_ROLLBACK only."""
    for i, seq in enumerate((10, 11, 12), start=1):
        env.client.post("/heartbeat", json=hb(env.priv, i, seq, h(seq)))
    r = env.client.post("/heartbeat", json=hb(env.priv, 4, 5, h(5)))
    assert codes(r) == ["SEQ_ROLLBACK"]


def test_fork_on_heartbeat(env: SimpleNamespace) -> None:
    """The same head_seq with a different head_hash raises FORK only."""
    env.client.post("/heartbeat", json=hb(env.priv, 1, 10, h(10)))
    r = env.client.post("/heartbeat", json=hb(env.priv, 2, 10, h(777)))
    assert codes(r) == ["FORK"]
    assert [a["code"] for a in alerts_of(env)] == ["FORK"]


def test_checkpoint_rules(env: SimpleNamespace) -> None:
    """Checkpoints: bad signature rejected, retry is idempotent, conflicts raise FORK."""
    good = cp(env.priv, 11, h(10), h(500))
    assert env.client.post("/checkpoint", json=good).json() == {"status": "stored"}
    assert env.client.post("/checkpoint", json=good).json() == {"status": "stored"}
    rows = env.client.get("/checkpoints", params={"node_id": "node-1"}).json()
    assert len(rows) == 1 and rows[0]["root_hash"] == h(500)

    other, _ = generate_keypair()
    r = env.client.post("/checkpoint", json=cp(other, 12, h(11), h(501)))
    assert r.status_code == 400 and codes(r) == ["BAD_SIGNATURE"] and r.json()["status"] == "rejected"

    r = env.client.post("/checkpoint", json=cp(env.priv, 11, h(10), h(999)))
    assert r.json()["status"] == "stored" and codes(r) == ["FORK"]
    r = env.client.post("/checkpoint", json=cp(env.priv, 11, h(888), h(500)))
    assert codes(r) == ["FORK"]
    assert len(env.client.get("/checkpoints", params={"node_id": "node-1"}).json()) == 3


def test_heartbeat_fork_against_checkpoint(env: SimpleNamespace) -> None:
    """A heartbeat that disagrees with an earlier checkpoint at the same head_seq raises FORK."""
    env.client.post("/checkpoint", json=cp(env.priv, 11, h(10), h(500)))
    r = env.client.post("/heartbeat", json=hb(env.priv, 1, 10, h(555)))
    assert codes(r) == ["FORK"]


def test_silence_rules(env: SimpleNamespace) -> None:
    """SILENCE fires once per streak, never early, and clears when heartbeats return."""
    assert env.app.state.sweep_silence() == []
    env.clock.t = T0 + WINDOW_S
    assert env.app.state.sweep_silence() == []
    env.clock.t = T0 + WINDOW_S + 1
    assert [a["code"] for a in env.app.state.sweep_silence()] == ["SILENCE"]
    env.clock.t = T0 + 5 * WINDOW_S
    assert env.app.state.sweep_silence() == []
    assert len(alerts_of(env, "SILENCE")) == 1

    env.clock.t += 10
    assert env.client.post("/heartbeat", json=hb(env.priv, 1, 0, h(1))).json() == {"status": "ok"}
    env.clock.t += WINDOW_S
    assert env.app.state.sweep_silence() == []
    env.clock.t += 1
    assert [a["code"] for a in env.app.state.sweep_silence()] == ["SILENCE"]
    assert len(alerts_of(env, "SILENCE")) == 2


def test_replay_does_not_reset_silence(env: SimpleNamespace) -> None:
    """Only a fresh heartbeat resets the silence timer; a replayed one does not."""
    first = hb(env.priv, 1, 0, h(1))
    env.clock.t = T0 + 10
    env.client.post("/heartbeat", json=first)
    env.clock.t = T0 + 60
    assert codes(env.client.post("/heartbeat", json=first)) == ["COUNTER_REPLAY"]
    env.clock.t = T0 + 10 + WINDOW_S + 1
    assert [a["code"] for a in env.app.state.sweep_silence()] == ["SILENCE"]


def test_witness_records_its_own_clock(env: SimpleNamespace) -> None:
    """received_at comes from the witness clock, not from the client's ts."""
    body = hb(env.priv, 1, 0, h(1))
    body = signed(env.priv, {k: v for k, v in body.items() if k not in ("signature", "ts")} | {"ts": "2020-01-01T00:00:00Z"})
    env.client.post("/heartbeat", json=body)
    row = env.client.get("/heartbeats", params={"node_id": "node-1"}).json()[0]
    assert row["ts"] == "2020-01-01T00:00:00Z"
    assert row["received_at"] == "2027-01-15T08:00:00Z"


@pytest.mark.parametrize("table", ["heartbeats", "checkpoints", "alerts"])
def test_tables_are_insert_only(env: SimpleNamespace, table: str) -> None:
    """The database itself refuses UPDATE and DELETE on every witness table."""
    env.client.post("/heartbeat", json=hb(env.priv, 1, 0, h(1)))
    env.client.post("/heartbeat", json=hb(env.priv, 1, 5, h(5)))
    env.client.post("/checkpoint", json=cp(env.priv, 1, h(1), h(2)))
    conn = env.app.state.conn
    assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] >= 1
    with pytest.raises(sqlite3.DatabaseError):
        conn.execute(f"UPDATE {table} SET node_id = 'x'")
    with pytest.raises(sqlite3.DatabaseError):
        conn.execute(f"DELETE FROM {table}")


GOOD_HB = {"node_id": "node-1", "hb_counter": 1, "head_seq": 0, "head_hash": h(1),
           "tree_size": 1, "ts": "2026-10-12T09:15:30Z", "signature": "00"}


@pytest.mark.parametrize("mutation", [
    {"hb_counter": 1.5}, {"hb_counter": True}, {"hb_counter": "1"}, {"hb_counter": 0},
    {"head_seq": 5}, {"head_seq": 2**70, "tree_size": 2**70 + 1}, {"head_hash": "XYZ"}, {"head_hash": "A" * 64},
    {"ts": "2026-10-12 09:15:30"}, {"node_id": "../etc"}, {"node_id": "n" * 65}, {"node_id": 7},
    {"signature": "0" * 300}, {"extra": 1}, {"signature": None},
])
def test_malformed_heartbeats_are_422_and_not_stored(env: SimpleNamespace, mutation: dict[str, Any]) -> None:
    """Ill-formed bodies are refused outright and leave no trace."""
    r = env.client.post("/heartbeat", json={**GOOD_HB, **mutation})
    assert r.status_code == 422 and r.json()["status"] == "invalid"
    assert env.client.get("/heartbeats", params={"node_id": "node-1"}).json() == []
    assert alerts_of(env) == []


def test_other_malformed_bodies(env: SimpleNamespace) -> None:
    """Non-object JSON, missing fields and bad JSON are all 422."""
    assert env.client.post("/heartbeat", json=[1, 2]).status_code == 422
    assert env.client.post("/heartbeat", json={k: v for k, v in GOOD_HB.items() if k != "ts"}).status_code == 422
    assert env.client.post("/heartbeat", content=b"{not json", headers={"content-type": "application/json"}).status_code == 422
    assert env.client.post("/checkpoint", json={**GOOD_HB, "hb_counter": 1}).status_code == 422
    assert env.client.post("/checkpoint", json=cp(env.priv, 0, h(1), h(2))).status_code == 422


def test_junk_flood_does_not_bury_a_real_alert(env: SimpleNamespace) -> None:
    """Hundreds of bad-signature requests store one alert row, and a later FORK stays easy to find."""
    other, _ = generate_keypair()
    for i in range(300):
        env.client.post("/heartbeat", json=hb(other, i + 1, 0, h(1)))
    assert len(alerts_of(env, "BAD_SIGNATURE")) == 1
    env.client.post("/heartbeat", json=hb(env.priv, 1, 10, h(10)))
    env.client.post("/heartbeat", json=hb(env.priv, 2, 10, h(11)))
    assert len(alerts_of(env, "FORK")) == 1
    assert len(alerts_of(env)) == 2


def test_list_limit_returns_newest_oldest_first(env: SimpleNamespace) -> None:
    """GET limit gives the newest N rows in ascending order."""
    for i in range(1, 6):
        env.client.post("/heartbeat", json=hb(env.priv, i, i - 1, h(i)))
    rows = env.client.get("/heartbeats", params={"node_id": "node-1", "limit": 2}).json()
    assert [r["hb_counter"] for r in rows] == [4, 5]


def test_nodes_file_must_map_strings(tmp_path: Path) -> None:
    """A malformed nodes_file is a loud error, not an empty trust list."""
    bad = tmp_path / "nodes.toml"
    bad.write_text("[nodes]\nnode-1 = 5\n", encoding="utf-8")
    with pytest.raises(ValueError):
        checks.load_nodes(bad)
    good = tmp_path / "ok.toml"
    good.write_text('[nodes]\nnode-1 = "ab"\n', encoding="utf-8")
    assert checks.load_nodes(good) == {"node-1": "ab"}
