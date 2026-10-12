"""Tails and ingests spool file events into the hash-chained SQLite store."""
import logging
import threading
import time
from collections.abc import Callable
from pathlib import Path
from sqlite3 import Connection
from typing import Any, BinaryIO

from sidecar.canon import sha256_hex
from sidecar.store import get_state, insert_entry, set_state, write_transaction
from tools.validate_spool import parse_line

logger = logging.getLogger(__name__)
STATE_OFFSET_KEY = "spool_offset"
STATE_LAST_LINE_KEY = "spool_last_line"  # "<byte length>:<sha256 hex>" of the last consumed line


class IngestStopError(RuntimeError):
    """Ingest cannot continue safely: the spool was shrunk or replaced, or a second writer is active."""


def _check_last_line(conn: Connection, f: BinaryIO, offset: int) -> None:
    """Raise IngestStopError if the last consumed spool line is no longer the one that was ingested."""
    saved = get_state(conn, STATE_LAST_LINE_KEY)
    if saved is None or offset == 0:
        return
    length_str, expected = saved.split(":", 1)
    length = int(length_str)
    if length > offset:
        raise IngestStopError(f"Ingest state is inconsistent: last line length {length} > offset {offset}")
    f.seek(offset - length)
    if sha256_hex(f.read(length)) != expected:
        raise IngestStopError(f"Spool file shrunk or replaced: line ending at offset {offset} changed")


def _parse_raw(raw: bytes, allowed_types: set[str] | None) -> dict[str, Any] | None:
    """Decode and validate one spool line; return the event, or None (logged) if it must be skipped."""
    try:
        line = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        logger.warning("Skipping non-UTF-8 spool line: %s", exc)
        return None
    try:
        event, errors = parse_line(line, allowed_types)
    except Exception as exc:  # a validator bug must never halt ingest on one line
        event, errors = None, [f"validator error: {exc!r}"]
    if errors:
        logger.warning("Skipping invalid spool line (%s): %r", ", ".join(errors), line[:200])
    return event


def _commit_line(conn: Connection, event: dict[str, Any] | None, raw: bytes, start: int, end: int) -> None:
    """Store the entry (if any) and advance the offset in one transaction, guarded against other writers."""
    with write_transaction(conn):
        if int(get_state(conn, STATE_OFFSET_KEY) or "0") != start:
            raise IngestStopError("Spool offset moved by another writer: is a second sidecar running?")
        if event is not None:
            insert_entry(conn, event)
        line = raw + b"\n"
        set_state(conn, STATE_OFFSET_KEY, str(end))
        set_state(conn, STATE_LAST_LINE_KEY, f"{len(line)}:{sha256_hex(line)}")


def ingest_batch(
    conn: Connection,
    spool_path: Path,
    allowed_types: set[str] | None = None,
) -> int:
    """Ingest complete lines appended to the spool file since the last saved offset."""
    if not spool_path.exists():
        return 0

    saved_offset = int(get_state(conn, STATE_OFFSET_KEY) or "0")
    file_size = spool_path.stat().st_size

    if file_size < saved_offset:
        msg = f"Spool file shrunk or replaced: size {file_size} < offset {saved_offset}"
        logger.error(msg)
        raise IngestStopError(msg)

    with open(spool_path, "rb") as f:
        _check_last_line(conn, f, saved_offset)
        if file_size == saved_offset:
            return 0
        f.seek(saved_offset)
        buffer = f.read()

    last_nl = buffer.rfind(b"\n")
    if last_nl == -1:
        return 0

    ingested_count = 0
    current_offset = saved_offset
    for raw in buffer[:last_nl].split(b"\n"):
        start = current_offset
        current_offset += len(raw) + 1
        event = _parse_raw(raw, allowed_types)
        _commit_line(conn, event, raw, start, current_offset)
        if event is not None:
            ingested_count += 1

    return ingested_count


def follow_spool(
    conn: Connection,
    spool_path: Path,
    allowed_types: set[str] | None = None,
    poll_interval: float = 0.2,
    stop_event: threading.Event | None = None,
    on_tick: Callable[[], None] | None = None,
) -> None:
    """Poll the spool and ingest new lines until stopped, calling on_tick after each poll."""
    while stop_event is None or not stop_event.is_set():
        try:
            ingest_batch(conn, spool_path, allowed_types)
        except IngestStopError:
            raise
        except Exception as exc:
            logger.error("Ingest iteration error (will retry the same line): %s", exc)
        if on_tick is not None:
            try:
                on_tick()
            except Exception as exc:
                logger.error("Tick error: %s", exc)
        time.sleep(poll_interval)
