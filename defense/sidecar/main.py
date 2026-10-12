"""Sidecar runner: spool ingestion plus signed checkpoints according to profile config."""
import argparse
import json
import logging
import signal
import sqlite3
import sys
import threading
import tomllib
from pathlib import Path

from sidecar.checkpoint import make_checkpoint_tick
import httpx
from sidecar.heartbeat import send_tamper_alert, start_heartbeat_thread
from sidecar.ingest import IngestStopError, follow_spool
from sidecar.keys import load_or_generate_keypair
from sidecar.store import count_entries, get_entries, init_db
from tools.validate_spool import load_allowed_types

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("sidecar")


def _tamper_detail(conn: sqlite3.Connection, spool_path: Path, error: IngestStopError) -> str:
    """Describe the changed field when both the saved and current event are readable."""
    try:
        entries = get_entries(conn, from_seq=max(0, count_entries(conn) - 1), limit=1)
        current = json.loads(spool_path.read_text(encoding="utf-8").splitlines()[-1])
        old = entries[0] if entries else {}
        old_value = old.get("details", {}).get("new", {}).get("amount")
        new_value = current.get("details", {}).get("new", {}).get("amount")
        if old_value is not None and new_value is not None and old_value != new_value:
            return f"log changed: transaction amount {old_value} -> {new_value}; {error}"
    except (OSError, IndexError, KeyError, TypeError, ValueError):
        pass
    return f"local log integrity failure: {error}"


def run_sidecar(config_path: Path, witness_url_override: str | None = None) -> int:
    """Initialize store and run sidecar ingestion using the given config file."""
    if not config_path.exists():
        logger.error("Configuration file not found: %s", config_path)
        return 2

    with open(config_path, "rb") as f:
        config = tomllib.load(f)

    db_path = Path(config["paths"]["db_path"])
    spool_path = Path(config["paths"]["spool_path"])
    allowed_types = load_allowed_types(config_path)
    private_key, public_hex = load_or_generate_keypair(
        Path(config["paths"]["private_key_path"]), Path(config["paths"]["public_key_path"])
    )

    conn = init_db(db_path)
    on_tick = make_checkpoint_tick(
        conn,
        config["node"]["node_id"],
        private_key,
        int(config["checkpoint"]["every_n"]),
        int(config["checkpoint"]["every_s"]),
    )
    logger.info("Initialized sidecar database at %s (current entries: %d)", db_path, count_entries(conn))
    logger.info("Node public key: %s", public_hex)
    logger.info("Starting ingest following %s", spool_path)

    stop_event = threading.Event()

    def handle_signal(sig: int, _frame: object) -> None:
        logger.info("Received termination signal %s, stopping ingest...", sig)
        stop_event.set()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    hb_cfg = config.get("heartbeat", {})
    witness_url = witness_url_override or hb_cfg.get("witness_url")
    hb_interval_s = float(hb_cfg.get("interval_s", 30))
    hb_thread = None
    if witness_url:
        logger.info("Starting heartbeat to witness at %s (interval: %ss)", witness_url, hb_interval_s)
        hb_thread = start_heartbeat_thread(
            db_path=db_path,
            node_id=config["node"]["node_id"],
            private_key=private_key,
            witness_url=witness_url,
            interval_s=hb_interval_s,
            stop_event=stop_event,
        )

    exit_code = 0
    try:
        follow_spool(conn, spool_path, allowed_types=allowed_types, stop_event=stop_event, on_tick=on_tick)
    except IngestStopError as exc:
        detail = _tamper_detail(conn, spool_path, exc)
        logger.error("STOPPING INGEST: %s", detail)
        if hb_thread and witness_url:
            try:
                with httpx.Client() as client:
                    if send_tamper_alert(client, witness_url, config["node"]["node_id"], private_key, detail):
                        logger.info("Sent SPOOL_TAMPER alert to witness")
            except Exception:
                logger.exception("Unable to send SPOOL_TAMPER alert to witness")
        exit_code = 1
    except KeyboardInterrupt:
        logger.info("Interrupted by user, stopping...")
    finally:
        stop_event.set()
        if hb_thread and hb_thread.is_alive():
            hb_thread.join(timeout=3.0)
        logger.info("Sidecar stopped. Total entries: %d", count_entries(conn))
        conn.close()

    return exit_code


def main(argv: list[str] | None = None) -> int:
    """CLI entry point for sidecar."""
    parser = argparse.ArgumentParser(prog="python -m sidecar.main", description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("config.toml"), help="profile configuration path")
    parser.add_argument("--witness-url", default=None,
                        help="override [heartbeat] witness_url (in Compose: http://witness:8800)")
    args = parser.parse_args(argv)
    return run_sidecar(args.config, args.witness_url)


if __name__ == "__main__":
    sys.exit(main())
