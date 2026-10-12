"""D9: Self-test tampering suite covering 5 core attacks and clean baseline."""
import json
import tempfile
from pathlib import Path
from typing import Any, Callable

from fastapi.testclient import TestClient

from sidecar.canon import compute_entry_hash
from sidecar.heartbeat import pulse_once
from sidecar.keys import generate_keypair
from sidecar.store import append_entry, get_connection, init_db
from verifier.checks import verify
from witness.app import create_app


def create_baseline(tmp_path: Path, count: int = 6) -> tuple[Path, Path, str, Any, Any]:
    """Create a clean baseline database, key, and witness with pulses and checkpoints."""
    priv, pub = generate_keypair()
    node_id = "node-1"

    nodes_file = tmp_path / "witness_nodes.toml"
    nodes_file.write_text(f'[nodes]\n"{node_id}" = "{pub}"\n', encoding="utf-8")

    witness_db = tmp_path / "witness.db"
    witness_cfg = tmp_path / "wcfg.toml"
    witness_cfg.write_text(
        f'[heartbeat]\ninterval_s = 30\n[witness]\ndb_path = "{witness_db.as_posix()}"\n'
        f'port = 8800\nnodes_file = "{nodes_file.as_posix()}"\n',
        encoding="utf-8",
    )
    app = create_app(witness_cfg)

    db_path = tmp_path / "sidecar.db"
    pub_path = tmp_path / "node1.pub"
    pub_path.write_text(pub, encoding="utf-8")

    conn = init_db(db_path)
    for i in range(count):
        append_entry(
            conn,
            {
                "ts": "2026-10-12T09:15:30Z",
                "source": "app",
                "actor": f"user{i}",
                "event_type": "transfer",
                "details": {"amount": (i + 1) * 100},
            },
        )
    conn.close()

    conn_read = get_connection(db_path)
    with TestClient(app) as client:
        pulse_once(conn_read, client, node_id, priv, "http://testserver", 0)
    conn_read.close()

    return db_path, pub_path, node_id, app, priv


def tamper_edit(db_path: Path) -> None:
    """Tamper 1: Edit a field in place at seq 2 without updating its hash."""
    conn = get_connection(db_path)
    conn.execute("UPDATE entries SET details = ? WHERE seq = 2", (json.dumps({"amount": 999999}),))
    conn.close()


def tamper_delete_middle(db_path: Path) -> None:
    """Tamper 2: Delete an entry from the middle of the log (seq 2)."""
    conn = get_connection(db_path)
    conn.execute("DELETE FROM entries WHERE seq = 2")
    conn.close()


def tamper_truncate_tail(db_path: Path) -> None:
    """Tamper 3: Delete tail entries (seq 4 and seq 5) after witness recorded them."""
    conn = get_connection(db_path)
    conn.execute("DELETE FROM entries WHERE seq >= 4")
    conn.close()


def tamper_reorder(db_path: Path) -> None:
    """Tamper 4: Swap payload contents of two adjacent entries (seq 1 and seq 2)."""
    conn = get_connection(db_path)
    r1 = conn.execute("SELECT actor, details FROM entries WHERE seq = 1").fetchone()
    r2 = conn.execute("SELECT actor, details FROM entries WHERE seq = 2").fetchone()
    conn.execute("UPDATE entries SET actor = ?, details = ? WHERE seq = 1", (r2["actor"], r2["details"]))
    conn.execute("UPDATE entries SET actor = ?, details = ? WHERE seq = 2", (r1["actor"], r1["details"]))
    conn.close()


def tamper_fork_rewrite(db_path: Path) -> None:
    """Tamper 5: Rewrite from seq 2 and re-chain hashes forward (clean local chain, forked from witness)."""
    conn = get_connection(db_path)
    conn.execute("UPDATE entries SET details = ? WHERE seq = 2", (json.dumps({"amount": 7777}),))
    for s in range(2, 6):
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
    conn.close()


ATTACK_SPECS: list[tuple[str, Callable[[Path], None] | None, str]] = [
    ("Clean baseline", None, "CLEAN"),
    ("Edit in place", tamper_edit, "EDIT"),
    ("Delete in middle", tamper_delete_middle, "SEQ_GAP"),
    ("Truncate tail", tamper_truncate_tail, "TRUNCATION"),
    ("Reorder two entries", tamper_reorder, "EDIT"),
    ("Fork and rewrite", tamper_fork_rewrite, "FORK"),
]


def run_suite(base_dir: Path | None = None) -> list[tuple[str, str, str, str]]:
    """Execute all tampering scenarios, return row tuples: (attack, expected, actual, status)."""
    results: list[tuple[str, str, str, str]] = []
    tmp_root = base_dir or Path(tempfile.mkdtemp(prefix="tamper_suite_"))

    for idx, (name, tamper_fn, expected_code) in enumerate(ATTACK_SPECS):
        step_dir = tmp_root / f"case_{idx}"
        step_dir.mkdir(parents=True, exist_ok=True)
        db_path, pub_path, node_id, app, _ = create_baseline(step_dir)

        if tamper_fn is not None:
            tamper_fn(db_path)

        with TestClient(app) as client:
            rep = verify(db_path, pub_path, witness_url="http://testserver", node_id=node_id, client=client)

        codes = [v["code"] for v in rep["verdicts"]]
        actual_code = "CLEAN" if (rep["clean"] and not codes) else (codes[0] if codes else "NONE")
        status = "PASS" if (expected_code == "CLEAN" and rep["clean"]) or (expected_code in codes) else "FAIL"
        results.append((name, expected_code, actual_code, status))

    return results


def format_table(rows: list[tuple[str, str, str, str]]) -> str:
    """Format suite results into an ASCII table."""
    headers = ("Attack", "Expected Verdict", "Actual Verdict", "Status")
    col_w = [max(len(h), max(len(r[i]) for r in rows)) for i, h in enumerate(headers)]
    sep = "+" + "+".join("-" * (w + 2) for w in col_w) + "+"

    lines = [sep]
    lines.append("| " + " | ".join(h.ljust(col_w[i]) for i, h in enumerate(headers)) + " |")
    lines.append(sep)
    for r in rows:
        lines.append("| " + " | ".join(r[i].ljust(col_w[i]) for i in range(len(headers))) + " |")
    lines.append(sep)
    return "\n".join(lines)


def test_tampering_suite(tmp_path: Path) -> None:
    """Assert all tampering attacks are detected with expected verdicts and print summary table."""
    rows = run_suite(tmp_path)
    table_str = format_table(rows)
    print("\n" + table_str)
    for attack, expected, actual, status in rows:
        assert status == "PASS", f"Attack '{attack}' failed: expected {expected}, got {actual}"


if __name__ == "__main__":
    rows = run_suite()
    print("\n" + format_table(rows))
