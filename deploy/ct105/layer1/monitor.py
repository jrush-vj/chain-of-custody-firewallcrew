#!/usr/bin/env python3
"""Layer 1 monitor for ct105: reports tripwire activity on the protected bank log to the witness.

Three kinds of event, all sent as signed layer-1 events:
  1. Commands: lines the honeypot wrappers (coc-trip-wrapper.sh) append to the spool when a watched
     command's arguments touch WATCH_DIR. Each one is an alert with the command, who ran it and where.
  2. Files: the content of WATCH_DIR compared with the approved baseline. A change that matches the
     approved copy is reported as "restored" (state normal); any other change is an alert, with the
     original and current content.
  3. Tripwire status: whether the wrappers and the login profile are in place. Reported on change.

Detection only: nothing is blocked. Standard library only.

Approved state lives in STATE_DIR/baseline/. The first run copies the current files there. Run
`approve` after a change you accept, so later changes are measured against it.

Environment:
  WATCH_DIR            default /var/log/bank-demo
  STATE_DIR            default /var/lib/coc-layer1
  COMMANDS_SPOOL       default /var/spool/coc-layer1/commands.jsonl
  TRIP_BIN             default /usr/local/coc-trip/bin
  PROFILE_FILE         default /etc/profile.d/coc-layer1.sh
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
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "layer3"))
import l3_config_guard as config_guard  # noqa: E402
import l3_quarantine  # noqa: E402
import l3_lockout  # noqa: E402
import demo_keys  # noqa: E402

# When Layer 3 fires automatically, push the demo account out for real (see l3_lockout.py: it refuses
# to touch anything but that one non-root account, however this is set). Set to "0" to fall back to the
# pure dry-run report instead, e.g. while testing on a host with no demo account.
LAYER3_REAL_LOCKOUT = os.environ.get("COC_LAYER3_REAL_LOCKOUT", "1") == "1"

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "layer2"))
import bank_reader  # noqa: E402

WATCH_DIR = os.environ.get("WATCH_DIR", "/var/log/bank-demo")
STATE_DIR = os.environ.get("STATE_DIR", "/var/lib/coc-layer1")
COMMANDS_SPOOL = os.environ.get("COMMANDS_SPOOL", "/var/spool/coc-layer1/commands.jsonl")
TRIP_BIN = os.environ.get("TRIP_BIN", "/usr/local/coc-trip/bin")
PROFILE_FILE = os.environ.get("PROFILE_FILE", "/etc/profile.d/coc-layer1.sh")
BASELINE_DIR = os.path.join(STATE_DIR, "baseline")
OFFSET_FILE = os.path.join(STATE_DIR, "commands.offset")
POLL_S = float(os.environ.get("POLL_S", "2"))
SNAPSHOT_LIMIT = 3000  # keeps one event well under the witness's 16 KB request limit
SUMMARY_LIMIT = 200
ARM_CHECK_S = 10
RESTORE_CHECK_S = 5
HEARTBEAT_S = float(os.environ.get("HEARTBEAT_S", "30"))
CONFIG_CHECK_S = 5
QUARANTINE_AFTER_S = float(os.environ.get("QUARANTINE_AFTER_S", "45"))
# While this file exists every witness request fails, which simulates a cut network link in the demo.
CUT_FLAG = os.environ.get("COC_WITNESS_CUT_FLAG", "/var/lib/coc-demo/witness-cut")
_last_contact = time.time()
# Send the witness a copy of the bank's transaction rows (allowlisted columns, read-only role).
BANK_SYNC = os.environ.get("COC_BANK_SYNC", "1") == "1"
ROWS_PER_POST = 40            # the witness accepts at most this many rows per request
_sweep_position = 0           # where the rotating hash sample resumes
_bank_error_logged_at = 0.0
RESTORE_SCRIPT = os.environ.get("RESTORE_SCRIPT", "/opt/chain-of-custody/deploy/ct105/restore-normal.sh")
WRAPPED_COMMANDS = ["nano", "vi", "vim", "sed", "rm", "mv", "cp", "truncate", "shred", "tee"]


# Every time the monitor prints is Indian Standard Time, whatever the server's time zone is.
IST = timezone(timedelta(hours=5, minutes=30), "IST")


def log(message):
    print(f"{datetime.now(IST).strftime('%H:%M:%S')} {message}", flush=True)


def clip(text, limit=SNAPSHOT_LIMIT):
    return text if len(text) <= limit else text[:limit] + "\n...(truncated)"


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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
            "observed_at": now_iso(),
        },
    }


# ---------- honeypot command spool ----------

def command_event(record):
    """Alert for one spooled command, or None if it does not touch the watched path."""
    command = str(record.get("command", ""))
    args = str(record.get("args", ""))
    if WATCH_DIR not in args:
        return None
    who = str(record.get("user", "unknown"))
    cwd = str(record.get("cwd", ""))
    tty = str(record.get("tty", ""))
    text = f"{command} {args}".strip()
    observed = datetime.fromtimestamp(float(record.get("ts", time.time())), timezone.utc)
    return {
        "layer": 1,
        "trigger": "command_executed",
        "state": "alert",
        "summary": f"{who} ran on the bank log: {text}"[:SUMMARY_LIMIT],
        "detail": {
            "cmd": text,
            "result": "caught",
            "rule": "Command run on the protected bank log path",
            "cwd": cwd,
            "tty": tty,
            "observed_at": observed.isoformat(timespec="seconds"),
        },
        "who": {"user": who, "cwd": cwd, "tty": tty, "src_ip": "local"},
    }


def read_new_commands(state):
    """Alert events for spool lines appended since the last call."""
    if not os.path.exists(COMMANDS_SPOOL):
        return []
    if os.path.getsize(COMMANDS_SPOOL) < state["offset"]:
        state["offset"] = 0  # spool was truncated or rotated
    events = []
    with open(COMMANDS_SPOOL, "rb") as handle:
        handle.seek(state["offset"])
        chunk = handle.read()
        state["offset"] = handle.tell()
    for raw in chunk.decode("utf-8", errors="replace").splitlines():
        try:
            record = json.loads(raw)
        except ValueError:
            continue
        event = command_event(record)
        if event:
            events.append(event)
    return events


def load_offset():
    try:
        with open(OFFSET_FILE, encoding="utf-8") as handle:
            return int(handle.read().strip())
    except (OSError, ValueError):
        # First start: begin at the end of the spool, so old lines are not replayed.
        return os.path.getsize(COMMANDS_SPOOL) if os.path.exists(COMMANDS_SPOOL) else 0


def save_offset(offset):
    with open(OFFSET_FILE, "w", encoding="utf-8") as handle:
        handle.write(str(offset))


# ---------- tripwire status ----------

def tripwire_status():
    """(armed, wrapper_count). Armed means the login profile exists and wrappers are installed."""
    wrappers = [name for name in WRAPPED_COMMANDS if os.access(os.path.join(TRIP_BIN, name), os.X_OK)]
    armed = os.path.isfile(PROFILE_FILE) and len(wrappers) > 0
    return armed, len(wrappers)


def status_event(armed, count):
    if armed:
        return {"layer": 1, "trigger": "tripwire_armed", "state": "normal",
                "summary": f"tripwire armed: {count} honeypot commands wrapped on the bank log",
                "detail": {"result": "armed", "rules": str(count)}}
    return {"layer": 1, "trigger": "tripwire_disarmed", "state": "alert",
            "summary": "tripwire disarmed: honeypot wrappers or login profile are missing",
            "detail": {"result": "disarmed",
                       "rule": "Honeypot wrappers missing: watched commands are not being recorded"}}


# ---------- witness transport ----------

def open_witness(request, timeout=10):
    """The one place witness requests are sent. Honours the simulated cut and records the last contact."""
    global _last_contact
    if os.path.exists(CUT_FLAG):
        raise urllib.error.URLError("simulated network cut (flag file present)")
    response = urllib.request.urlopen(request, timeout=timeout)
    _last_contact = time.time()
    return response


def signed_request(method, path, body=b""):
    """A witness request signed with the shared HMAC secret. The signature covers method, path, time, body."""
    url = os.environ["WITNESS_URL"].rstrip("/") + path
    timestamp = str(int(time.time() * 1000))
    signature = hmac.new(
        os.environ["WITNESS_HMAC_SECRET"].encode("utf-8"),
        f"{method}\n{path}\n{timestamp}\n{body.decode('utf-8')}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    headers = {
        # Python's default agent string is blocked by the Cloudflare bot rules in front of the witness.
        "user-agent": "coc-layer1-monitor/1.0",
        "x-witness-node": os.environ["WITNESS_NODE_ID"],
        "x-witness-timestamp": timestamp,
        "x-witness-signature": signature,
    }
    if body:
        headers["content-type"] = "application/json"
    return urllib.request.Request(url, data=body or None, method=method, headers=headers)


def post_event(event):
    """Send one signed event. Returns True when the witness accepted it."""
    request = signed_request("POST", "/v1/layer-events", json.dumps(event).encode("utf-8"))
    try:
        with open_witness(request, timeout=10) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError) as error:
        log(f"witness unreachable, will retry: {error}")
        return False


# ---------- website restore ----------

def check_restore_request():
    """If the website has queued a restore, run restore-normal.sh and report the result back.

    The witness only ever queues a fixed action with no parameters. This side pulls it with a
    signed request, so no port on ct105 is opened.
    """
    try:
        with open_witness(signed_request("GET", "/v1/restore-pending"), timeout=10) as response:
            pending = json.loads(response.read().decode("utf-8")).get("pending")
    except (urllib.error.URLError, OSError, ValueError) as error:
        log(f"restore check unavailable: {error}")
        return
    if not pending:
        return
    log(f"restore requested at {pending.get('requested_at')}; running restore-normal")
    try:
        result = subprocess.run(["bash", RESTORE_SCRIPT], capture_output=True, text=True, timeout=600)
        ok = result.returncode == 0
        output = result.stdout.splitlines()
        layer1 = sum(1 for line in output if line.startswith("restored ") and "approved copy" in line)
        layer2 = sum(1 for line in output if line.startswith("restored transaction #"))
        layer3 = sum(1 for line in output if line.startswith("restored config:"))
        summary = f"Layer 1: {layer1} file(s) restored; Layer 2: {layer2} row(s) restored; Layer 3: {layer3} setting(s) restored"
        if not ok:
            summary = f"restore script exited {result.returncode}: " + (result.stderr.strip() or "see ct105 logs")
    except (OSError, subprocess.SubprocessError) as error:
        ok, summary = False, f"restore could not run: {error}"
    body = json.dumps({"id": pending["id"], "ok": ok, "summary": summary[:300]}).encode("utf-8")
    try:
        with open_witness(signed_request("POST", "/v1/restore-ack", body), timeout=10):
            pass
        log(f"restore {'completed' if ok else 'failed'}: {summary}")
    except (urllib.error.URLError, OSError) as error:
        log(f"restore acknowledgement not delivered, will retry: {error}")


# ---------- heartbeat ----------

def collect_bank_view():
    """The bank summary for this heartbeat, or None when it cannot be read. The heartbeat still goes
    out without it: a missed heartbeat is itself an alert, so it must never wait on the database."""
    global _sweep_position, _bank_error_logged_at
    if not BANK_SYNC:
        return None
    try:
        view, _sweep_position = bank_reader.build_view(_sweep_position)
        return view
    except bank_reader.BankReadError as error:
        if time.time() - _bank_error_logged_at > 600:
            log(f"bank view unavailable, sending the heartbeat without it: {error}")
            _bank_error_logged_at = time.time()
        return None


def sync_rows(need):
    """Send the rows the witness asked for, in rounds, until it has everything it needs."""
    sent, stored = 0, None
    for _ in range(20):
        if not need:
            break
        try:
            rows = bank_reader.rows_by_ids(need[:ROWS_PER_POST])
        except bank_reader.BankReadError as error:
            log(f"could not read the rows the witness asked for: {error}")
            break
        if not rows:
            break  # they disappeared from the bank in the meantime; the witness will notice
        body = json.dumps({"rows": rows}).encode("utf-8")
        try:
            with open_witness(signed_request("POST", "/v1/records", body), timeout=10) as response:
                reply = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError) as error:
            log(f"could not send rows to the witness: {error}")
            break
        sent += len(rows)
        stored = reply.get("stored_count")
        just_sent = {row["id"] for row in rows}
        need = [i for i in reply.get("need_rows", []) if i not in just_sent]
    if sent:
        log(f"sent {sent} bank row(s) to the witness; it now holds {stored}")


def send_heartbeat():
    """One signed heartbeat. Never queued or retried: a missed beat is what the witness watches for.

    seq is the clock in milliseconds, so it keeps rising across monitor restarts and the witness can
    reject replays. It is sent whether or not anything is being tampered with. When the bank can be
    read, it also carries a compact view of the bank; the witness answers with the rows it still needs.
    """
    payload = {"seq": int(time.time() * 1000), "interval_s": HEARTBEAT_S}
    view = collect_bank_view()
    if view is not None:
        payload["bank"] = view
    try:
        with open_witness(signed_request("POST", "/v1/heartbeat", json.dumps(payload).encode("utf-8")), timeout=5) as response:
            reply = json.loads(response.read().decode("utf-8") or "{}")
    except (urllib.error.URLError, OSError, ValueError) as error:
        log(f"heartbeat not delivered: {error}")
        return False
    if reply.get("sync_error"):
        log(f"the witness rejected the bank view: {reply['sync_error']}")
    need = (reply.get("sync") or {}).get("need_rows") or []
    if need:
        sync_rows(need)
    return True


# ---------- layer 3 ----------

def layer3_trigger_reason():
    """Why Layer 3 should respond right now, or None. Two causes: the approved witness link settings
    changed, or this host has had no contact with the witness for QUARANTINE_AFTER_S."""
    changes = config_guard.drift()
    if changes:
        return "approved witness link settings changed: " + ", ".join(change["item"] for change in changes)
    silent = time.time() - _last_contact
    if silent > QUARANTINE_AFTER_S:
        return f"no contact with the witness for {int(silent)} s"
    return None


def respond_to_layer3(reason):
    """Build the layer-3 event for a newly-detected compromise: a real, demo-account-only lockout when
    LAYER3_REAL_LOCKOUT is on and the demo account exists, otherwise the dry-run report. Never raises:
    an unsafe or missing target falls back to the dry run rather than taking any real action."""
    if LAYER3_REAL_LOCKOUT:
        try:
            event, locked = l3_lockout.lock(reason)
            log(f"LAYER 3 (real, demo account only): {reason}; locked={locked}")
            for holder, key in demo_keys.DEMO_KEYS.items():
                log(f"  unlock key — {holder}: {key}")
            return event
        except l3_lockout.UnsafeTarget as error:
            log(f"LAYER 3 real lockout refused ({error}); falling back to a dry-run report")
    log(f"LAYER 3 (dry run): {reason}")
    return l3_quarantine.run_dry(reason)


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
    state = {"offset": load_offset()}
    save_offset(state["offset"])
    armed, count = tripwire_status()
    pending = [status_event(armed, count)]
    last_armed, next_status_check = armed, time.time() + ARM_CHECK_S
    next_restore_check = time.time() + RESTORE_CHECK_S
    next_heartbeat = time.time()  # the first heartbeat goes out immediately
    next_config_check = time.time() + CONFIG_CHECK_S
    layer3_reason = None  # set while a quarantine is recorded, so it fires once per compromise
    if config_guard.load_baseline() is None:
        log("no approved witness link settings yet; run l3_config_guard.py approve to arm the config check")
    log(f"watching {WATCH_DIR} and spool {COMMANDS_SPOOL}; armed={armed} wrappers={count}")

    while True:
        approved = baseline_hashes()
        now = current_files()
        for name in sorted(set(reported) | set(now)):
            if reported.get(name) != now.get(name):
                pending.append(file_event(name, reported.get(name), now.get(name), approved.get(name)))
                reported[name] = now.get(name)
        pending.extend(read_new_commands(state))
        save_offset(state["offset"])
        if time.time() >= next_status_check:
            armed, count = tripwire_status()
            if armed != last_armed:
                pending.append(status_event(armed, count))
                last_armed = armed
            next_status_check = time.time() + ARM_CHECK_S
        if time.time() >= next_restore_check:
            check_restore_request()
            next_restore_check = time.time() + RESTORE_CHECK_S
        if time.time() >= next_heartbeat:
            send_heartbeat()
            next_heartbeat = time.time() + HEARTBEAT_S
        if time.time() >= next_config_check:
            reason = layer3_trigger_reason()
            if reason and not layer3_reason:
                layer3_reason = reason
                pending.append(respond_to_layer3(reason))
            elif not reason and layer3_reason:
                log("layer 3 conditions cleared; armed again")
                layer3_reason = None
            next_config_check = time.time() + CONFIG_CHECK_S

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
