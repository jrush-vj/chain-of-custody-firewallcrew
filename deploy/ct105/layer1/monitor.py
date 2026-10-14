#!/usr/bin/env python3
"""Layer 1 monitor for ct105: reports changes to the protected bank log directory to the witness.

Detection only: it reports changes, it never blocks them. Standard library only.

Approved state lives in STATE_DIR/baseline/. The first run copies the current files there.
A change that matches the approved copy is reported as "restored" (state normal). Any other
change is reported as an alert with a diff against the approved copy. Run `approve` after a
change you accept, so later changes are measured against it.

Environment (all required unless a default is shown):
  WATCH_DIR            default /var/log/bank-demo
  STATE_DIR            default /var/lib/coc-layer1
  WITNESS_URL          e.g. https://witness.jrushvj.dev
  WITNESS_NODE_ID      e.g. ct105-ai
  WITNESS_HMAC_SECRET  same secret the banking witness uses; never printed
  POLL_S               default 2

Usage:
  python3 monitor.py run       # poll forever (systemd service)
  python3 monitor.py approve   # accept current files as the new approved baseline
"""

import difflib
import hashlib
import hmac
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

WATCH_DIR = os.environ.get("WATCH_DIR", "/var/log/bank-demo")
STATE_DIR = os.environ.get("STATE_DIR", "/var/lib/coc-layer1")
BASELINE_DIR = os.path.join(STATE_DIR, "baseline")
POLL_S = float(os.environ.get("POLL_S", "2"))
DIFF_LIMIT = 3800  # the witness rejects any single detail value above 4000 characters
SUMMARY_LIMIT = 200


def log(message):
    print(f"{datetime.now().strftime('%H:%M:%S')} {message}", flush=True)


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def current_files():
    """name -> sha256 for every regular file in WATCH_DIR (directories are ignored)."""
    if not os.path.isdir(WATCH_DIR):
        return {}
    return {
        name: sha256_of(os.path.join(WATCH_DIR, name))
        for name in sorted(os.listdir(WATCH_DIR))
        if os.path.isfile(os.path.join(WATCH_DIR, name))
    }


def read_text(path):
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


def baseline_hashes():
    if not os.path.isdir(BASELINE_DIR):
        return {}
    return {
        name: sha256_of(os.path.join(BASELINE_DIR, name))
        for name in sorted(os.listdir(BASELINE_DIR))
    }


def diff_against_baseline(name, current_path):
    before = read_text(os.path.join(BASELINE_DIR, name)) if os.path.exists(os.path.join(BASELINE_DIR, name)) else ""
    after = read_text(current_path) if current_path and os.path.exists(current_path) else ""
    lines = difflib.unified_diff(before.splitlines(), after.splitlines(), "approved", "current", lineterm="")
    text = "\n".join(lines)
    return text[:DIFF_LIMIT]


def build_event(name, previous_hash, current_hash, approved_hash):
    """One layer event for a file that changed since the last report."""
    path = os.path.join(WATCH_DIR, name)
    if current_hash is None:
        action = "removed"
    elif previous_hash is None:
        action = "created"
    else:
        action = "modified"
    restored = current_hash is not None and current_hash == approved_hash
    if restored:
        state = "normal"
        summary = f"{name} is back to the approved content"
    else:
        state = "alert"
        summary = f"{name} {action} outside the approved baseline"
    return {
        "layer": 1,
        "trigger": f"file_{action}",
        "state": state,
        "summary": summary[:SUMMARY_LIMIT],
        "detail": {
            "cmd": f"{action} {WATCH_DIR}/{name}",
            "result": "restored" if restored else "recorded",
            "rule": "" if restored else "Protected log changed outside the approved baseline",
            "file": name,
            "action": action,
            "approved_sha256": approved_hash or "",
            "current_sha256": current_hash or "",
            "diff": diff_against_baseline(name, path if current_hash else None),
            "observed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    }


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


def run():
    for name in ("WITNESS_URL", "WITNESS_NODE_ID", "WITNESS_HMAC_SECRET"):
        if not os.environ.get(name):
            sys.exit(f"missing {name}")
    if not os.path.isdir(BASELINE_DIR):
        log("no approved baseline yet; approving the current files")
        approve()

    reported = dict(current_files())  # what the witness was last told about each file
    pending = []
    log(f"watching {WATCH_DIR} every {POLL_S}s")
    while True:
        now = current_files()
        approved = baseline_hashes()
        for name in sorted(set(reported) | set(now)):
            if reported.get(name) == now.get(name):
                continue
            pending.append(build_event(name, reported.get(name), now.get(name), approved.get(name)))
            reported[name] = now.get(name)
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
