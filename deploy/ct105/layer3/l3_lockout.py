"""Layer 3 real lockout, scoped to one demo account only. Never root, never the operator's own login,
never any other account on ct105 — no matter what triggers it or what environment variable is set.

Everything else Layer 3 would do in a real incident (take the site down, revoke banking sessions,
restore settings, reboot) stays exactly as before: recorded by l3_quarantine.py, never executed. This
module adds one real, narrow action on top: push the demo account's sessions out and disable its login,
so the demo can show an actual lockout happening without any risk of locking out ct105 itself.

CLI:
  python3 l3_lockout.py lock [reason]     disable the demo account, end its sessions, print the 3
                                          demo unlock keys, write sealed evidence, print the layer-3
                                          event (JSON) to report to the witness
  python3 l3_lockout.py unlock KEY KEY    verify 2 of the 3 demo keys, re-enable the demo account,
                                          write release evidence, print the layer-3 event (JSON)
  python3 l3_lockout.py keys              print the 3 demo keys (no account changes)
  python3 l3_lockout.py status            is the demo account currently locked?

Standard library only.
"""

import getpass
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import pwd  # POSIX only; this module runs for real only on ct105 (Linux)
except ImportError:
    import types as _types

    def _no_such_user(name):
        raise KeyError(name)

    pwd = _types.SimpleNamespace(getpwnam=_no_such_user)

SIGKILL = getattr(signal, "SIGKILL", 9)  # signal.SIGKILL does not exist on Windows

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import demo_keys  # noqa: E402
import l3_quarantine  # noqa: E402

STATE_DIR = os.environ.get("COC_L3_STATE", "/var/lib/coc-layer3")
FORBIDDEN_NAMES = {"root"}
MIN_DEMO_UID = 1000  # below this is a system/service account on most distros, never a target


class UnsafeTarget(Exception):
    """Raised instead of ever touching an account that fails the safety checks below."""


def resolve_demo_user():
    """The demo account's (name, uid), or raise. Three independent checks, all must pass:
    not on the name blocklist, not the account running this script, and a normal (non-system) uid."""
    name = os.environ.get("COC_DEMO_USER", "coc-demo-intruder")
    if name in FORBIDDEN_NAMES:
        raise UnsafeTarget(f"{name!r} is on the forbidden list")
    if name == getpass.getuser():
        raise UnsafeTarget(f"{name!r} is the account running this script")
    try:
        info = pwd.getpwnam(name)
    except KeyError as error:
        raise UnsafeTarget(f"account {name!r} does not exist; run setup-demo-account.sh first") from error
    if info.pw_uid == 0 or info.pw_uid < MIN_DEMO_UID:
        raise UnsafeTarget(f"{name!r} has uid {info.pw_uid}, not in the demo account range (>= {MIN_DEMO_UID})")
    return name, info.pw_uid


# ---------- ending the demo account's sessions, without ever touching our own ----------
# Same technique as cybersec/layers/l3_quarantine/sessions.py: a process is in a login session if it
# has a controlling terminal or a login uid (auid) set by PAM, which works without systemd/loginctl.

def _ancestor_pids(proc_root):
    seen, pid = set(), os.getpid()
    while pid and pid not in seen:
        seen.add(pid)
        try:
            stat = (proc_root / str(pid) / "stat").read_text()
            pid = int(stat[stat.rindex(")") + 2:].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return seen


def _process_uid(proc_root, pid):
    try:
        for line in (proc_root / str(pid) / "status").read_text().splitlines():
            if line.startswith("Uid:"):
                return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        pass
    return None


def login_sessions_of(uid, proc_root="/proc"):
    """[{pid, cmd}] for every process belonging to uid that has a controlling terminal or a login uid,
    excluding this script and its ancestors."""
    root = Path(proc_root)
    if not root.is_dir():
        return []
    keep = _ancestor_pids(root)
    found = []
    for entry in root.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid in keep or pid == 1:
            continue
        if _process_uid(root, pid) != uid:
            continue
        try:
            stat = (entry / "stat").read_text()
            cmd = stat[stat.index("(") + 1: stat.rindex(")")]
            tty = int(stat[stat.rindex(")") + 2:].split()[4])
        except (OSError, ValueError, IndexError):
            continue
        try:
            auid = int((entry / "loginuid").read_text().strip())
        except (OSError, ValueError):
            auid = 4294967295
        if tty != 0 or auid != 4294967295:
            found.append({"pid": pid, "cmd": cmd})
    return found


def end_sessions(uid, proc_root="/proc"):
    """Kill every session found for uid. Returns what was found (and killed, best-effort)."""
    found = login_sessions_of(uid, proc_root)
    for item in found:
        try:
            os.kill(item["pid"], SIGKILL)
            item["killed"] = True
        except (ProcessLookupError, PermissionError) as error:
            item["killed"] = False
            item["error"] = error.__class__.__name__
    return found


# ---------- locking and unlocking the account (requires root) ----------

def run(command):
    return subprocess.run(command, capture_output=True, text=True, timeout=10)


def disable_login(name):
    """usermod -L (password lock) + an expiry date in the past: two independent ways in, both closed."""
    results = [run(["usermod", "-L", name]), run(["usermod", "--expiredate", "1", name])]
    return all(result.returncode == 0 for result in results), results


def enable_login(name):
    results = [run(["usermod", "-U", name]), run(["usermod", "--expiredate", "", name])]
    return all(result.returncode == 0 for result in results), results


def write_evidence(record):
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    path = os.path.join(STATE_DIR, f"lockout-{record['id']}.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(record, handle, indent=2)
    os.chmod(path, 0o600)
    return path


def is_locked(name):
    result = run(["passwd", "-S", name])
    # `passwd -S` prints "name L ..." when locked, "name P ..." or "name NP ..." otherwise.
    return result.returncode == 0 and result.stdout.split()[1:2] == ["L"]


# ---------- the two real actions, each building the layer-3 event to report ----------

def lock(reason, now=None):
    """Real action: end the demo account's sessions and disable its login. Returns the layer-3 event."""
    name, uid = resolve_demo_user()
    moment = now if now is not None else time.time()
    quarantine_id = f"q-{int(moment)}"

    sessions = end_sessions(uid)
    ok, results = disable_login(name)
    site_down, response = l3_quarantine.build_plan(l3_quarantine.login_session_count())

    record = {
        "id": quarantine_id,
        "action": "lock",
        "demo_account": name,
        "sessions_ended": sessions,
        "login_disabled": ok,
        "reason": reason,
        "recorded_at": datetime.fromtimestamp(moment, timezone.utc).isoformat(timespec="seconds"),
    }
    evidence = write_evidence(record)

    lockout_lines = [
        f"REAL: ended {len(sessions)} session(s) for demo account {name}",
        f"REAL: disabled login for {name} (password locked + expired)",
        *response,
    ]
    return {
        "layer": 3,
        "trigger": "quarantine:locked",
        "state": "alert",
        "summary": f"Layer 3: {reason} — demo account {name} locked out".strip()[:200],
        "detail": {
            "quarantine_id": quarantine_id,
            "reason": reason[:300],
            "dry_run": False,
            "demo_account": name,
            "site_down": "\n".join(site_down),
            "lockout": "\n".join(lockout_lines),
            "evidence": evidence,
        },
        "who": {},
    }, ok


def unlock(keys, now=None):
    """Real action: verify 2 of 3 demo keys, then re-enable the demo account. Returns (event, ok)."""
    if not demo_keys.verify(keys):
        return None, False
    name, _uid = resolve_demo_user()
    moment = now if now is not None else time.time()
    ok, results = enable_login(name)
    record = {
        "id": f"u-{int(moment)}",
        "action": "unlock",
        "demo_account": name,
        "login_enabled": ok,
        "recorded_at": datetime.fromtimestamp(moment, timezone.utc).isoformat(timespec="seconds"),
    }
    write_evidence(record)
    return {
        "layer": 3,
        "trigger": "quarantine:released",
        "state": "normal",
        "summary": f"Layer 3 released: 2 of 3 key holders approved; demo account {name} re-enabled"[:200],
        "detail": {"quarantine_id": record["id"], "dry_run": False, "demo_account": name},
        "who": {},
    }, ok


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    try:
        if command == "lock":
            event, ok = lock(" ".join(sys.argv[2:]) or "manual lockout demo")
            print(f"demo account locked: {ok}")
            print("unlock keys (need 2 of 3):")
            for holder, key in demo_keys.DEMO_KEYS.items():
                print(f"  {holder}: {key}")
            print(json.dumps(event))
        elif command == "unlock":
            event, ok = unlock(sys.argv[2:])
            if not ok and event is None:
                sys.exit("refused: need 2 correct demo keys (see 'keys' to show them)")
            print(f"demo account unlocked: {ok}")
            print(json.dumps(event))
        elif command == "keys":
            for holder, key in demo_keys.DEMO_KEYS.items():
                print(f"{holder}: {key}")
        elif command == "status":
            name, _uid = resolve_demo_user()
            print(f"{name}: {'locked' if is_locked(name) else 'not locked'}")
        else:
            sys.exit("usage: l3_lockout.py lock|unlock|keys|status")
    except UnsafeTarget as error:
        sys.exit(f"refusing: {error}")


if __name__ == "__main__":
    main()
