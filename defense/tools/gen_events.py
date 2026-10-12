"""Write synthetic RawEvents (CONTRACT.md section 2) to a spool file."""
import argparse
import json
import random
import sys
import time
import tomllib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

ACTORS = ["asha", "ravi", "meera", "arjun", "kiran"]
ACCOUNTS = ["Checking", "Savings", "Groceries", "Travel Fund", "Payroll", "Vendor A"]


def _amount(rng: random.Random) -> str:
    """Return a random money amount as a decimal string, never a float."""
    cents = rng.randint(100, 2_500_000)
    return f"{cents // 100}.{cents % 100:02d}"


def _ip(rng: random.Random) -> str:
    """Return a random private IP address."""
    return f"10.0.{rng.randint(0, 3)}.{rng.randint(2, 254)}"


def _txn_id(rng: random.Random) -> str:
    """Return a random transaction id as a string."""
    return str(rng.randint(1000, 99999))


# (source, event_type, actor is known, details builder). The last two are
# non-standard names, showing that any snake_case event type is accepted.
TEMPLATES: list[tuple[str, str, bool, Callable[[random.Random], dict[str, Any]]]] = [
    ("app", "login_success", True, lambda r: {"ip": _ip(r)}),
    ("app", "login_failed", False, lambda r: {"ip": _ip(r)}),
    ("app", "error", False, lambda r: {"message": "upstream timeout", "code": r.choice([500, 502, 504])}),
    ("db", "transaction_created", True, lambda r: {
        "txn_id": _txn_id(r), "amount": _amount(r), "currency": "INR",
        "from_account": r.choice(ACCOUNTS), "to_account": r.choice(ACCOUNTS)}),
    ("db", "transaction_updated", True, lambda r: {
        "txn_id": _txn_id(r), "field": "amount", "old": _amount(r), "new": _amount(r)}),
    ("db", "transaction_deleted", True, lambda r: {"txn_id": _txn_id(r)}),
    ("db", "account_created", True, lambda r: {"account": r.choice(ACCOUNTS), "type": "asset"}),
    ("host", "http_request", False, lambda r: {
        "method": r.choice(["GET", "POST"]), "path": r.choice(["/transactions", "/accounts", "/login"]),
        "status": r.choice(["200", "302", "404"])}),
    ("db", "payment_approved", True, lambda r: {"payment_id": _txn_id(r), "amount": _amount(r), "currency": "INR"}),
    ("app", "config_changed", True, lambda r: {"key": "session_timeout", "old": "15", "new": "30"}),
]


def utc_now() -> str:
    """Return the current UTC time as YYYY-MM-DDTHH:MM:SSZ."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def make_event(rng: random.Random, ts: str) -> dict[str, Any]:
    """Build one valid synthetic RawEvent with the given timestamp."""
    source, event_type, known_actor, details = rng.choice(TEMPLATES)
    actor = rng.choice(ACTORS) if known_actor else "unknown"
    return {"source": source, "ts": ts, "actor": actor, "event_type": event_type, "details": details(rng)}


def append_event(path: Path, event: dict[str, Any]) -> None:
    """Append one event as a single line with a single write call."""
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
    with open(path, "ab") as f:
        f.write(line.encode("utf-8"))


def generate(path: Path, count: int, rate: float, rng: random.Random) -> int:
    """Append count events (0 = forever) at rate events/second (0 = no delay)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    while count == 0 or written < count:
        append_event(path, make_event(rng, utc_now()))
        written += 1
        if rate > 0:
            time.sleep(1.0 / rate)
    return written


def spool_path_from_config(config_path: Path) -> Path:
    """Read [paths] spool_path from a profile."""
    with open(config_path, "rb") as f:
        return Path(tomllib.load(f)["paths"]["spool_path"])


def main(argv: list[str] | None = None) -> int:
    """CLI entry point for the generator."""
    parser = argparse.ArgumentParser(prog="python -m tools.gen_events", description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("config.toml"), help="profile to read spool_path from")
    parser.add_argument("--out", type=Path, help="spool file to append to (overrides the profile)")
    parser.add_argument("--count", type=int, default=100, help="events to write, 0 = run until Ctrl+C")
    parser.add_argument("--rate", type=float, default=5.0, help="events per second, 0 = as fast as possible")
    parser.add_argument("--seed", type=int, help="seed for reproducible output")
    args = parser.parse_args(argv)
    try:
        path = args.out or spool_path_from_config(args.config)
        written = generate(path, args.count, args.rate, random.Random(args.seed))
    except (OSError, KeyError, tomllib.TOMLDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 0
    print(f"wrote {written} event(s) to {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
