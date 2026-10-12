"""Validate a spool file against CONTRACT.md section 2 (RawEvent)."""
import argparse
import json
import re
import sys
import tomllib
from datetime import datetime
from pathlib import Path
from typing import Any

from sidecar.canon import canonical_json_bytes

FIELDS = ("source", "ts", "actor", "event_type", "details")
SOURCES = {"app", "db", "host"}
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
EVENT_TYPE_RE = re.compile(r"^[a-z][a-z0-9_]*$")


def _reject_constant(name: str) -> None:
    """Reject NaN and Infinity, which are not valid JSON."""
    raise ValueError(f"non-standard JSON constant {name}")


def _reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Build a JSON object, rejecting duplicate keys (readers disagree on which one wins)."""
    obj: dict[str, Any] = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError(f"duplicate key '{key}'")
        obj[key] = value
    return obj


def check_ts(ts: str) -> bool:
    """Return True if ts is UTC ISO 8601 with seconds precision and a trailing Z."""
    if not TS_RE.match(ts):
        return False
    try:
        datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return False
    return True


def find_floats(obj: Any, path: str = "details") -> list[str]:
    """Return the paths of every float inside obj, at any depth."""
    if isinstance(obj, float):
        return [path]
    if isinstance(obj, dict):
        return [p for k, v in obj.items() for p in find_floats(v, f"{path}.{k}")]
    if isinstance(obj, list):
        return [p for i, v in enumerate(obj) for p in find_floats(v, f"{path}[{i}]")]
    return []


def validate_event(obj: Any, allowed_types: set[str] | None = None) -> list[str]:
    """Return contract errors for one parsed RawEvent; empty means valid."""
    if not isinstance(obj, dict):
        return ["line is not a JSON object"]
    errors = [f"missing field '{f}'" for f in FIELDS if f not in obj]
    errors += [f"unexpected field '{k}'" for k in obj if k not in FIELDS]
    for name in ("source", "ts", "actor", "event_type"):
        if name in obj and not isinstance(obj[name], str):
            errors.append(f"'{name}' must be a string")
    if "details" in obj and not isinstance(obj["details"], dict):
        errors.append("'details' must be an object")
    if errors:
        return errors
    if obj["source"] not in SOURCES:
        errors.append(f"unknown source '{obj['source']}'")
    if not check_ts(obj["ts"]):
        errors.append(f"bad timestamp '{obj['ts']}' (want YYYY-MM-DDTHH:MM:SSZ)")
    if not obj["actor"]:
        errors.append("'actor' must not be empty (use 'unknown')")
    if not EVENT_TYPE_RE.match(obj["event_type"]):
        errors.append(f"event_type '{obj['event_type']}' is not lowercase snake_case")
    elif allowed_types and obj["event_type"] not in allowed_types:
        errors.append(f"event_type '{obj['event_type']}' not in profile allow-list")
    errors += [f"float at {p} (use a string)" for p in find_floats(obj["details"])]
    if not errors:
        try:
            canonical_json_bytes(obj)
        except UnicodeEncodeError:
            errors.append("not encodable as UTF-8 (lone surrogate escape such as \\ud800)")
    return errors


def parse_line(raw: str, allowed_types: set[str] | None = None) -> tuple[dict[str, Any] | None, list[str]]:
    """Parse and check one spool line (without its newline); return (event, errors)."""
    if not raw.strip():
        return None, ["blank line"]
    errors = []
    if raw.endswith("\r"):
        errors.append("line ends with \\r\\n (use \\n only)")
        raw = raw[:-1]
    try:
        obj = json.loads(raw, parse_constant=_reject_constant, object_pairs_hook=_reject_duplicates)
        errors += validate_event(obj, allowed_types)
    except ValueError as exc:
        return None, errors + [f"bad JSON: {exc}"]
    except RecursionError:
        return None, errors + ["bad JSON: nested too deeply"]
    return (None if errors else obj), errors


def validate_line(raw: str, allowed_types: set[str] | None = None) -> list[str]:
    """Parse one spool line (without its newline) and return contract errors."""
    return parse_line(raw, allowed_types)[1]


def validate_file(path: Path, allowed_types: set[str] | None = None) -> tuple[int, list[tuple[int, str]]]:
    """Validate a spool file; return (line count, [(line number, error)])."""
    data = path.read_bytes()
    if not data:
        return 0, []
    chunks = data.split(b"\n")
    complete = data.endswith(b"\n")
    if complete:
        chunks = chunks[:-1]
    errors: list[tuple[int, str]] = []
    for num, chunk in enumerate(chunks, start=1):
        try:
            raw = chunk.decode("utf-8")
        except UnicodeDecodeError:
            errors.append((num, "not valid UTF-8"))
            continue
        errors += [(num, e) for e in validate_line(raw, allowed_types)]
    if not complete:
        errors.append((len(chunks), "last line has no trailing newline"))
    return len(chunks), errors


def load_allowed_types(config_path: Path) -> set[str] | None:
    """Read the profile's event_types allow-list; None means any snake_case type."""
    with open(config_path, "rb") as f:
        config = tomllib.load(f)
    types = config.get("profile", {}).get("event_types", [])
    if not isinstance(types, list) or not all(isinstance(t, str) for t in types):
        raise ValueError("[profile] event_types must be a list of strings")
    return set(types) or None


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: exit 0 if valid, 1 if any line fails, 2 on usage or I/O error."""
    parser = argparse.ArgumentParser(prog="python -m tools.validate_spool", description=__doc__)
    parser.add_argument("path", type=Path, help="spool file to check")
    parser.add_argument("--config", type=Path, help="profile (config.toml) with an optional allow-list")
    args = parser.parse_args(argv)
    try:
        allowed = load_allowed_types(args.config) if args.config else None
        total, errors = validate_file(args.path, allowed)
    except (OSError, ValueError, tomllib.TOMLDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    for num, msg in errors:
        print(f"line {num}: {msg}")
    if errors:
        bad = len({num for num, _ in errors})
        print(f"FAIL: {len(errors)} error(s) in {bad} of {total} line(s)")
        return 1
    print(f"OK: {total} line(s) valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
