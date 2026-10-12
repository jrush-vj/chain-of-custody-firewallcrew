"""Witness input validation and the five alert rules from CONTRACT.md section 5."""
import re
import sqlite3
import tomllib
from pathlib import Path
from typing import Any

from sidecar.keys import verify_payload
from tools.validate_spool import check_ts
from witness import store

HB_FIELDS = ("node_id", "hb_counter", "head_seq", "head_hash", "tree_size", "ts", "signature")
CP_FIELDS = ("node_id", "tree_size", "head_seq", "head_hash", "root_hash", "ts", "signature")
INT_FIELDS = ("hb_counter", "head_seq", "tree_size")
HASH_FIELDS = ("head_hash", "root_hash")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
NODE_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
MAX_INT = 2**62
SILENCE_MARGIN_S = 15
UNKNOWN_NODE = "(unknown)"  # alert bucket for node_ids not in nodes_file; NODE_ID_RE can never match it


def load_nodes(path: Path) -> dict[str, str]:
    """Read the trusted node map: [nodes] node_id = "<hex public key>"."""
    with open(path, "rb") as f:
        nodes = tomllib.load(f).get("nodes", {})
    if not isinstance(nodes, dict) or not all(isinstance(v, str) for v in nodes.values()):
        raise ValueError("[nodes] must map node_id to a hex public key string")
    return dict(nodes)


def payload_errors(body: Any, fields: tuple[str, ...]) -> list[str]:
    """Return strict shape errors for a heartbeat or checkpoint body; empty means well-formed."""
    if not isinstance(body, dict):
        return ["body must be a JSON object"]
    errors = [f"missing field '{f}'" for f in fields if f not in body]
    errors += [f"unexpected field '{k}'" for k in body if k not in fields]
    if errors:
        return errors
    for name in (n for n in INT_FIELDS if n in fields):
        v = body[name]
        if not isinstance(v, int) or isinstance(v, bool) or abs(v) >= MAX_INT:
            errors.append(f"'{name}' must be an integer")
    for name in (n for n in HASH_FIELDS if n in fields):
        if not isinstance(body[name], str) or not HEX64_RE.match(body[name]):
            errors.append(f"'{name}' must be 64 lowercase hex characters")
    if not isinstance(body["node_id"], str) or not NODE_ID_RE.match(body["node_id"]):
        errors.append("'node_id' must match [A-Za-z0-9_.-]{1,64}")
    if not isinstance(body["ts"], str) or not check_ts(body["ts"]):
        errors.append("'ts' must be YYYY-MM-DDTHH:MM:SSZ")
    if not isinstance(body["signature"], str) or len(body["signature"]) > 256:
        errors.append("'signature' must be a string of at most 256 characters")
    if errors:
        return errors
    is_heartbeat = "hb_counter" in fields
    if is_heartbeat and body["hb_counter"] < 1:
        errors.append("'hb_counter' starts at 1")
    if body["tree_size"] < (0 if is_heartbeat else 1):
        errors.append("'tree_size' is too small")
    if body["head_seq"] != body["tree_size"] - 1:
        errors.append("'head_seq' must equal tree_size - 1")
    return errors


def signature_ok(nodes: dict[str, str], body: dict[str, Any]) -> bool:
    """Return True if the body is signed by the key the witness trusts for its node_id."""
    pub = nodes.get(body["node_id"])
    unsigned = {k: v for k, v in body.items() if k != "signature"}
    return pub is not None and verify_payload(pub, body["signature"], unsigned)


def _alert(code: str, detail: str) -> dict[str, str]:
    """Build an alert object."""
    return {"code": code, "detail": detail}


def bad_signature_alert(nodes: dict[str, str], body: dict[str, Any]) -> dict[str, str]:
    """Build the BAD_SIGNATURE alert, saying whether the node is unknown or the signature is wrong."""
    if body["node_id"] not in nodes:
        return _alert("BAD_SIGNATURE", "node_id is not listed in nodes_file")
    return _alert("BAD_SIGNATURE", "signature does not verify against the node's public key")


def check_fork(conn: sqlite3.Connection, node_id: str, head_seq: int, head_hash: str) -> list[dict[str, str]]:
    """FORK: this head_seq was seen before with a different head_hash."""
    if store.hashes_at_seq(conn, node_id, head_seq) - {head_hash}:
        return [_alert("FORK", f"head_seq {head_seq} was seen before with a different head_hash")]
    return []


def evaluate_heartbeat(conn: sqlite3.Connection, hb: dict[str, Any]) -> list[dict[str, str]]:
    """Apply COUNTER_REPLAY, SEQ_ROLLBACK and FORK to a signature-valid heartbeat."""
    node, counter = hb["node_id"], hb["hb_counter"]
    last = store.last_counter(conn, node)
    replay = last is not None and counter <= last
    if replay and store.heartbeat_exists(conn, node, counter, hb["signature"]):
        return [_alert("COUNTER_REPLAY", f"hb_counter {counter} was already received")]
    alerts = []
    if replay:
        alerts.append(_alert("COUNTER_REPLAY", f"hb_counter {counter} is not greater than last seen {last}"))
    high = store.highest_head_seq(conn, node)
    if high is not None and hb["head_seq"] < high:
        alerts.append(_alert("SEQ_ROLLBACK", f"head_seq {hb['head_seq']} is lower than highest seen {high}"))
    return alerts + check_fork(conn, node, hb["head_seq"], hb["head_hash"])


def evaluate_checkpoint(conn: sqlite3.Connection, cp: dict[str, Any]) -> tuple[list[dict[str, str]], bool]:
    """Return (alerts, is_duplicate) for a signature-valid checkpoint."""
    node = cp["node_id"]
    alerts = check_fork(conn, node, cp["head_seq"], cp["head_hash"])
    existing = store.get_checkpoint_at(conn, node, cp["tree_size"])
    if existing is None:
        return alerts, False
    if existing["head_hash"] == cp["head_hash"] and existing["root_hash"] == cp["root_hash"]:
        return alerts, True
    if not alerts:
        alerts.append(_alert("FORK", f"tree_size {cp['tree_size']} was seen before with a different root_hash"))
    return alerts, False


def silence_alert(
    conn: sqlite3.Connection, node_id: str, now: float, interval_s: float, started_at: float
) -> dict[str, str] | None:
    """SILENCE once per streak: no fresh heartbeat for more than 2 * interval_s + 15 seconds."""
    window = 2 * interval_s + SILENCE_MARGIN_S
    reference = max(store.last_fresh_epoch(conn, node_id) or 0.0, started_at)
    if now - reference <= window:
        return None
    last_alert = store.last_alert_epoch(conn, node_id, "SILENCE")
    if last_alert is not None and last_alert > reference:
        return None
    return _alert("SILENCE", f"no valid heartbeat for more than {window:g} seconds")
