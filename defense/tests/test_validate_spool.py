"""D1 tests: spool validator."""
import json
from pathlib import Path

import pytest

from tools.validate_spool import main, validate_file, validate_line

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "samples" / "events.sample.jsonl"
GOOD = {"source": "app", "ts": "2026-10-12T09:15:30Z", "actor": "asha",
        "event_type": "login_success", "details": {"ip": "10.0.0.5"}}


def _line(**changes: object) -> str:
    """Return GOOD as a JSON line with fields changed (None value removes a field)."""
    event = {**GOOD, **changes}
    return json.dumps({k: v for k, v in event.items() if v is not None})


def _write(tmp_path: Path, content: str, name: str = "spool.jsonl") -> Path:
    """Write raw text to a file in binary mode (no newline translation)."""
    path = tmp_path / name
    path.write_bytes(content.encode("utf-8"))
    return path


def test_sample_file_passes() -> None:
    """The committed sample spool is valid."""
    total, errors = validate_file(SAMPLE)
    assert total == 12
    assert errors == []
    assert main([str(SAMPLE)]) == 0


@pytest.mark.parametrize("raw, expected", [
    ("{not json", "bad JSON"),
    ("[1, 2]", "not a JSON object"),
    (_line(actor=None), "missing field 'actor'"),
    (_line(extra="x"), "unexpected field 'extra'"),
    (_line(actor=5), "'actor' must be a string"),
    (_line(details="ip"), "'details' must be an object"),
    (_line(source="kernel"), "unknown source"),
    (_line(ts="2026-10-12T09:15:30"), "bad timestamp"),
    (_line(ts="2026-10-12T09:15:30.123Z"), "bad timestamp"),
    (_line(ts="2026-10-12T09:15:30+00:00"), "bad timestamp"),
    (_line(ts="2026-02-30T09:15:30Z"), "bad timestamp"),
    (_line(actor=""), "must not be empty"),
    (_line(event_type="LoginSuccess"), "not lowercase snake_case"),
    (_line(event_type="login-success"), "not lowercase snake_case"),
    (_line(details={"amount": 12.5}), "float at details.amount"),
    (_line(details={"items": [{"price": 1.0}]}), "float at details.items[0].price"),
    ('{"source":"app","ts":"2026-10-12T09:15:30Z","actor":"a","event_type":"x","details":{"v":NaN}}', "bad JSON"),
    ("   ", "blank line"),
    (_line() + "\r", "\\r\\n"),
])
def test_bad_line_detected(raw: str, expected: str) -> None:
    """Each kind of contract break is reported with a clear message."""
    errors = validate_line(raw)
    assert any(expected in e for e in errors), errors


def test_ints_bools_and_custom_event_types_allowed() -> None:
    """Integers, booleans and any snake_case event type are valid."""
    assert validate_line(_line(event_type="payment_approved", details={"n": 3, "ok": True, "x": None})) == []


def test_crlf_line_still_checked() -> None:
    """A CRLF line reports the line ending and its other errors too."""
    errors = validate_line(_line(details={"amount": 12.5}) + "\r")
    assert len(errors) == 2
    assert any("\\r\\n" in e for e in errors) and any("float" in e for e in errors)


def test_broken_file_fails_with_line_numbers(tmp_path: Path) -> None:
    """A file with one broken line fails, and the right line is named."""
    path = _write(tmp_path, _line() + "\n" + _line(source="kernel") + "\n" + _line() + "\n")
    total, errors = validate_file(path)
    assert total == 3
    assert [num for num, _ in errors] == [2]
    assert main([str(path)]) == 1


def test_missing_trailing_newline(tmp_path: Path) -> None:
    """A last line without a newline is reported."""
    path = _write(tmp_path, _line() + "\n" + _line())
    _, errors = validate_file(path)
    assert errors == [(2, "last line has no trailing newline")]


def test_empty_file_passes(tmp_path: Path) -> None:
    """An empty spool has no lines and no errors."""
    assert validate_file(_write(tmp_path, "")) == (0, [])


def test_allow_list_profile(tmp_path: Path) -> None:
    """A non-empty allow-list rejects other types; an empty one accepts any."""
    spool = _write(tmp_path, _line(event_type="payment_approved") + "\n")
    strict = _write(tmp_path, '[profile]\nevent_types = ["login_success"]\n', "strict.toml")
    open_ = _write(tmp_path, "[profile]\nevent_types = []\n", "open.toml")
    assert main([str(spool), "--config", str(strict)]) == 1
    assert main([str(spool), "--config", str(open_)]) == 0


def test_bad_allow_list_and_missing_file(tmp_path: Path) -> None:
    """Usage and I/O problems exit with code 2."""
    spool = _write(tmp_path, _line() + "\n")
    bad = _write(tmp_path, '[profile]\nevent_types = "login_success"\n', "bad.toml")
    assert main([str(spool), "--config", str(bad)]) == 2
    assert main([str(tmp_path / "nope.jsonl")]) == 2
