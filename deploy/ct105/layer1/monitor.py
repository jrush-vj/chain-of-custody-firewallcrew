#!/usr/bin/env python3
"""Layer 1 monitor for ct105: reports tripwire activity on the protected bank log to the witness.

Two sources, both reported as signed layer-1 events:
  1. Commands: auditd records for the watched commands (rules in audit-rules.conf, key coc_l1)
     whose arguments touch WATCH_DIR. Each one is an alert with the command, who ran it and where.
  2. Files: the content of WATCH_DIR compared with the approved baseline. A change that matches the
     approved copy is reported as "restored" (state normal); any other change is an alert.
The monitor also checks that the auditd rules are loaded and reports when they are armed or disarmed.

Detection only: nothing is blocked. Standard library only.

Approved state lives in STATE_DIR/baseline/. The first run copies the current files there. Run
`approve` after a change you accept, so later changes are measured against it.

Environment:
  WATCH_DIR            default /var/log/bank-demo
  STATE_DIR            default /var/lib/coc-layer1
  AUDIT_LOG            default /var/log/audit/audit.log
  WITNESS_URL          e.g. https://witness.jrushvj.dev
  WITNESS_NODE_ID      e.g. ct105-ai
  WITNESS_HMAC_SECRET  same secret the banking witness uses; never printed
  POLL_S               default 2

Usage:
  python3 monitor.py run       # poll forever (systemd service)
  python3 monitor.py approve   # accept the current files as the approved baseline
"""

import difflib
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

WATCH_DIR = os.environ.get("WATCH_DIR", "/var/log/bank-demo")
STATE_DIR = os.environ.get("STATE_DIR", "/var/lib/coc-layer1")
AUDIT_LOG = os.environ.get("AUDIT_LOG", "/var/log/audit/audit.log")
BASELINE_DIR = os.path.join(STATE_DIR, "baseline")
OFFSET_FILE = os.path.join(STATE_DIR, "audit.offset")
POLL_S = float(os.environ.get("POLL_S", "2"))
AUDIT_KEY = "coc_l1"
SNAPSHOT_LIMIT = 3000  # keeps one event well under the witness's 16 KB request limit
SUMMARY_LIMIT = 200

AUDIT_LINE = re.compile(r"^type=(\w+) msg=audit\((\d+\.\d+):(\d+)\): (.*)$")
AUDIT_FIELD = re.compile(r'(\w+)=("(?:[^"\\]|\\.)*"|\S+)')


def log(message):
    print(f"{datetime.now().strftime('%H:%M:%S')} {message}", flush=True)


def clip(text, limit=SNAPSHOT_LIMIT):
    return text if len(text) <= limit else text[:limit] + "\n...(truncated)"


# ---------- file baseline ----------

def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def current_files():
    """name -> sha256 for every regular file in WATCH_DIR."""
    if not os.path.isdir(WATCH_DIR):
        return {}
    return {
        name: sha256_of(os.path.join(WATCH_DIR, name))
        for name in sorted(os.listdir(WATCH_DIR))
        if os.path.isfile(os.path.join(WATCH_DIR, name))
    }


def baseline_hashes():
    if not os.path.isdir(BASELINE_DIR):
        return {}
    return {name: sha256_of(os.path.join(BASELINE_DIR, name)) for name in sorted(os.listdir(BASELINE_DIR))}


def read_text(path):
    if not path or not os.path.exists(path):
        return ""
    with open(path, "rb") as handle:
        return handle.read().decode("utf-8", errors="replace")


def approve():
    """Copy the current watched files into the approved baseline, replacing the old one."""
    if os.path.isdir(BASELINE_DIR):
        shutil.rmtree(BASELINE_DIR)
    os.makedirs(BASELINE_DIR, mode=0o700)
    for name in current_files():
        shutil.copy2(os.path.join(WATCH_DIR, name), os.path.join(BASELINE_DIR, name))
    log(f"approved baseline: {sorted(os.listdir(BASELINE_DIR)) or 'empty'}")


def file_event(name, previous_hash, current_hash, approved_hash):
    """One layer event for a watched file that changed since the last report."""
    if current_hash is None:
        action = "removed"
    elif previous_hash is None:
        action = "created"
    else:
        action = "modified"
    restored = current_hash is not None and current_hash == approved_hash
    approved_text = read_text(os.path.join(BASELINE_DIR, name)) if approved_hash else ""
    current_text = read_text(os.path.join(WATCH_DIR, name)) if current_hash else ""
    diff = "\n".join(difflib.unified_diff(
        approved_text.splitlines(), current_text.splitlines(),
        "original (approved)", "now", lineterm=""))
    if restored:
        state, summary = "normal", f"{name} is back to the approved content"
        result, rule = "restored", ""
    else:
        state = "alert"
        summary = f"{name} {action} outside the approved baseline"
        result, rule = "recorded", "Protected log changed outside the approved baseline"
    return {
        "layer": 1,
        "trigger": f"file_{action}",
        "state": state,
        "summary": summary[:SUMMARY_LIMIT],
        "detail": {
            "cmd": f"{action} {os.path.join(WATCH_DIR, name)}",
            "result": result,
            "rule": rule,
            "file": name,
            "action": action,
            "approved_sha256": approved_hash or "",
            "current_sha256": current_hash or "",
            "approved_content": clip(approved_text) if approved_hash else "(no approved copy)",
            "current_content": clip(current_text) if current_hash else "(file removed)",
            "diff": clip(diff),
            "observed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    }


# ---------- auditd command capture ----------

def decode_audit_value(key, raw):
    """auditd quotes printable values and hex-encodes the rest; only argument fields need decoding."""
    if raw.startswith('"'):
        return raw[1:-1]
    if (key == "proctitle" or re.fullmatch(r"a\d+", key)) and re.fullmatch(r"[0-9A-Fa-f]+", raw) and len(raw) % 2 == 0:
        return bytes.fromhex(raw).decode("utf-8", errors="replace").replace("\x00", " ")
    return raw


def parse_fields(text):
    return {key: decode_audit_value(key, raw) for key, raw in AUDIT_FIELD.findall(text)}


def user_name(uid_text):
    try:
        import pwd  # Linux only; the monitor runs on ct105
        return pwd.getpwuid(int(uid_text)).pw_name
    except (ImportError, KeyError, ValueError, TypeError):
        return f"uid {uid_text}"


def command_event(group):
    """Build an alert from one audit event (all records sharing a serial), or None if not ours."""
    syscall = group.get("SYSCALL")
    execve = group.get("EXECVE")
    if not syscall or not execve or syscall.get("key") != AUDIT_KEY:
        return None
    argc = int(execve.get("argc", "0") or 0)
    args = [execve.get(f"a{index}", "") for index in range(argc)]
    if not any(WATCH_DIR in arg for arg in args):
        return None  # the command ran, but not on the bank log path
    command = " ".join(args)
    auid = syscall.get("auid", "")
    who_name = user_name(auid) if auid not in ("", "4294967295") else "unknown user"
    cwd = group.get("CWD", {}).get("cwd", "")
    summary = f"{who_name} ran on the bank log: {command}"
    return {
        "layer": 1,
        "trigger": "command_executed",
        "state": "alert",
        "summary": summary[:SUMMARY_LIMIT],
        "detail": {
            "cmd": command,
            "result": "caught",
            "rule": "Command run on the protected bank log path",
            "exe": syscall.get("exe", ""),
            "cwd": cwd,
            "tty": syscall.get("tty", ""),
            "pid": syscall.get("pid", ""),
            "observed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
        "who": {
            "user": who_name,
            "auid": auid,
            "uid": syscall.get("uid", ""),
            "tty": syscall.get("tty", ""),
            "cwd": cwd,
            "src_ip": "local",
        },
    }


def read_new_audit_events(state):
    """Return alert events for new watched commands in the audit log since the last call."""
    if not os.path.exists(AUDIT_LOG):
        return []
    size = os.path.getsize(AUDIT_LOG)
    if size < state["offset"]:
        state["offset"] = 0  # log rotated
    with open(AUDIT_LOG, "rb") as handle:
        handle.seek(state["offset"])
        chunk = handle.read()
        state["offset"] = handle.tell()
    groups = state["groups"]
    for raw in chunk.decode("utf-8", errors="replace").splitlines():
        match = AUDIT_LINE.match(raw)
        if not match:
            continue
        record_type, _, serial, body = match.groups()
        groups.setdefault(serial, {})[record_type] = parse_fields(body)
    events = []
    for serial in list(groups):
        event = command_event(groups[serial])
        if event:
            events.append(event)
        if event or "EXECVE" in groups[serial] or len(groups) > 200:
            del groups[serial]  # complete (or stale): forget it
    return events


def load_offset():
    try:
        with open(OFFSET_FILE, encoding="utf-8") as handle:
            return int(handle.read().strip())
    except (OSError, ValueError):
        # First start: begin at the end of the existing audit log, so old history is not replayed.
        return os.path.getsize(AUDIT_LOG) if os.path.exists(AUDIT_LOG) else 0


def save_offset(offset):
    with open(OFFSET_FILE, "w", encoding="utf-8") as handle:
        handle.write(str(offset))


# ---------- armed check ----------

def armed_status():
    """(armed, rule_count) from auditd. Armed means the coc_l1 rules are loaded."""
    try:
        listing = subprocess.run(["auditctl", "-l"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return False, 0
    count = sum(1 for line in listing.splitlines() if f"-k {AUDIT_KEY}" in line or f"key={AUDIT_KEY}" in line)
    return count > 0, count


def armed_event(armed, count):
    if armed:
        return {"layer": 1, "trigger": "tripwire_armed", "state": "normal",
                "summary": f"tripwire armed: {count} auditd rules loaded for the bank log",
                "detail": {"result": "armed", "rules": str(count)}}
    return {"layer": 1, "trigger": "tripwire_disarmed", "state": "alert",
            "summary": "tripwire disarmed: auditd rules for the bank log are not loaded",
            "detail": {"result": "disarmed", "rule": "Tripwire rules missing: commands are not being watched"}}


# ---------- witness transport ----------

def post_event(event):
    """Send one signed event. Returns True when the witness accepted it."""
    url = os.environ["WITNESS_URL"].rstrip("/") + "/v1/layer-events"
    body = json.dumps(event).encode("utf-8")
    timestamp = str(int(time.time() * 1000))
    signature = hmac.new(
        os.environ["WITNESS_HMAC_SECRET"].encode("utf-8"),
        f"POST\n/v1/layer-events\n{timestamp}\n{body.decode('utf-8')}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-witness-node": os.environ["WITNESS_NODE_ID"],
            "x-witness-timestamp": timestamp,
            "x-witness-signature": signature,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError) as error:
        log(f"witness unreachable, will retry: {error}")
        return False


# ---------- main loop ----------

def run():
    for name in ("WITNESS_URL", "WITNESS_NODE_ID", "WITNESS_HMAC_SECRET"):
        if not os.environ.get(name):
            sys.exit(f"missing {name}")
    os.makedirs(STATE_DIR, exist_ok=True)
    if not os.path.isdir(BASELINE_DIR):
        log("no approved baseline yet; approving the current files")
        approve()

    reported = dict(current_files())  # what the witness was last told about each file
    audit_state = {"offset": load_offset(), "groups": {}}
    save_offset(audit_state["offset"])
    armed, count = armed_status()
    pending = [armed_event(armed, count)]
    last_armed, next_arm_check = armed, time.time() + 10
    log(f"watching {WATCH_DIR} and auditd key {AUDIT_KEY} every {POLL_S}s; armed={armed} rules={count}")

    while True:
        approved = baseline_hashes()
        now = current_files()
        for name in sorted(set(reported) | set(now)):
            if reported.get(name) != now.get(name):
                pending.append(file_event(name, reported.get(name), now.get(name), approved.get(name)))
                reported[name] = now.get(name)
        pending.extend(read_new_audit_events(audit_state))
        save_offset(audit_state["offset"])
        if time.time() >= next_arm_check:
            armed, count = armed_status()
            if armed != last_armed:
                pending.append(armed_event(armed, count))
                last_armed = armed
            next_arm_check = time.time() + 10

        still_pending = []
        for event in pending:
            if post_event(event):
                log(f"{event['state']}: {event['summary']}")
            else:
                still_pending.append(event)
        pending = still_pending
        time.sleep(POLL_S)


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "run"
    if command == "approve":
        approve()
    elif command == "run":
        run()
    else:
        sys.exit("usage: monitor.py run|approve")
