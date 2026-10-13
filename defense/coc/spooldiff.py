"""Read-only comparison of tracked spool lines with their sidecar records."""
import json
import sqlite3
from pathlib import Path
from typing import Any

from tools.validate_spool import parse_line

EVENT_FIELDS = ("source", "ts", "actor", "event_type")


def _flatten(value: Any, path: str) -> dict[str, Any]:
    if isinstance(value, dict) and value:
        result: dict[str, Any] = {}
        for key, child in value.items():
            result.update(_flatten(child, f"{path}.{key}"))
        return result
    return {path: value}


def field_changes(recorded: dict[str, Any], current: dict[str, Any]) -> list[tuple[str, Any, Any]]:
    """Return changed field paths as (path, recorded value, current value)."""
    old = {field: recorded.get(field) for field in EVENT_FIELDS}
    new = {field: current.get(field) for field in EVENT_FIELDS}
    old.update(_flatten(recorded.get("details"), "details"))
    new.update(_flatten(current.get("details"), "details"))
    missing = object()
    changes = []
    for path in sorted(set(old) | set(new)):
        before, after = old.get(path, missing), new.get(path, missing)
        if before != after or type(before) is not type(after):
            changes.append((path, None if before is missing else before, None if after is missing else after))
    return changes


def compare_spool(db_path: Path, spool_path: Path) -> dict[str, Any]:
    """Compare tracked lines without modifying the sidecar database."""
    report: dict[str, Any] = {"tracked": 0, "untracked": 0, "changed": [], "removed_lines": 0}
    uri = f"file:{db_path.resolve().as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        total = int(conn.execute("SELECT COUNT(*) FROM entries").fetchone()[0])
        table = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='spool_lines'"
        ).fetchone()
        if not table:
            report["untracked"] = total
            return report
        rows = conn.execute(
            "SELECT e.seq, e.ts, e.source, e.actor, e.event_type, e.details, s.line_no "
            "FROM entries e JOIN spool_lines s ON s.seq=e.seq ORDER BY e.seq"
        ).fetchall()
        consumed = conn.execute(
            "SELECT value FROM ingest_state WHERE key='spool_line_no'"
        ).fetchone()
    finally:
        conn.close()

    report["tracked"] = len(rows)
    report["untracked"] = total - len(rows)
    lines = spool_path.read_bytes().split(b"\n")[:-1] if spool_path.is_file() else []
    if consumed is not None and len(lines) < int(consumed[0]):
        report["removed_lines"] = int(consumed[0]) - len(lines)

    for row in rows:
        item: dict[str, Any] = {"seq": row["seq"], "line_no": row["line_no"]}
        if row["line_no"] > len(lines):
            report["changed"].append({**item, "problem": "line is gone from the spool"})
            continue
        try:
            current, errors = parse_line(lines[row["line_no"] - 1].decode("utf-8"))
        except UnicodeDecodeError:
            current, errors = None, ["line is no longer valid UTF-8"]
        if current is None:
            report["changed"].append({**item, "problem": f"line no longer reads as an event ({errors[0]})"})
            continue
        recorded = {field: row[field] for field in EVENT_FIELDS}
        recorded["details"] = json.loads(row["details"])
        changes = field_changes(recorded, current)
        if changes:
            report["changed"].append({**item, "fields": changes})
    return report


def describe(item: dict[str, Any]) -> str:
    where = f"line {item['line_no']} (record seq {item['seq']})"
    if "problem" in item:
        return f"{where}: {item['problem']}"
    return f"{where}: " + "; ".join(
        f"{path} recorded {json.dumps(before)}, spool now {json.dumps(after)}"
        for path, before, after in item["fields"]
    )
