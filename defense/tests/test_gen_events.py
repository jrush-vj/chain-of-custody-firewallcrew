"""D1 tests: event generator."""
import random
from pathlib import Path

from tools.gen_events import TEMPLATES, generate, main
from tools.validate_spool import main as validate_main
from tools.validate_spool import validate_file


def test_1000_generated_lines_pass(tmp_path: Path) -> None:
    """A 1,000 line generated spool passes the validator."""
    spool = tmp_path / "spool" / "events.jsonl"
    assert main(["--out", str(spool), "--count", "1000", "--rate", "0", "--seed", "1"]) == 0
    total, errors = validate_file(spool)
    assert total == 1000
    assert errors == []
    assert validate_main([str(spool)]) == 0


def test_generator_covers_all_templates(tmp_path: Path) -> None:
    """Every source and event type template appears, including non-standard ones."""
    spool = tmp_path / "events.jsonl"
    generate(spool, 1000, 0, random.Random(2))
    text = spool.read_text(encoding="utf-8")
    for source, event_type, _, _ in TEMPLATES:
        assert f'"event_type":"{event_type}"' in text
        assert f'"source":"{source}"' in text


def test_seed_is_deterministic(tmp_path: Path) -> None:
    """The same seed gives the same events (timestamps aside)."""
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    generate(a, 50, 0, random.Random(7))
    generate(b, 50, 0, random.Random(7))
    strip = lambda p: [line.split('"ts":')[0] + line.split('"actor"')[1] for line in p.read_text().splitlines()]
    assert strip(a) == strip(b)


def test_appends_never_truncate(tmp_path: Path) -> None:
    """Running twice appends to the spool instead of rewriting it."""
    spool = tmp_path / "events.jsonl"
    generate(spool, 10, 0, random.Random(3))
    generate(spool, 5, 0, random.Random(4))
    assert validate_file(spool)[0] == 15


def test_spool_path_from_profile(tmp_path: Path, monkeypatch) -> None:
    """Without --out, the spool path comes from the profile."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "config.toml").write_text('[paths]\nspool_path = "spool/events.jsonl"\n')
    assert main(["--count", "3", "--rate", "0"]) == 0
    assert validate_file(tmp_path / "spool" / "events.jsonl") == (3, [])
