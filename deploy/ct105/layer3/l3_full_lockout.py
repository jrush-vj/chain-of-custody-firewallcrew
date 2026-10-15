"""Layer 3 FULL lockout: every configured interactive user, root included. NOT the demo-scoped lockout.

This is a separate, deliberately-gated capability from l3_lockout.py (which only ever touches the
one demo account and is what runs automatically). This module can lock out root. If the trigger
condition is a network cut, that is also when SSH access disappears — so unlocking needs a way in
that does not depend on the guest's own network or login system. Read RECOVERY.md and verify that
path actually works, on a cloned copy of the host, before this is ever run for real anywhere else.
This module is never imported by monitor.py's automatic trigger; it is only reachable through
full-lockout.sh / full-unlock.sh, which require an explicit opt-in on top of calling it.

Fixed order, matching cybersec/layers/l3_quarantine/quarantine.py (independently tested 18/18 in a
real container): capture -> seal evidence -> site down -> lock out every configured user and end
their sessions -> report. Never reboots (a REBOOT-style command in site_down/site_up is refused).

Users: "auto" (default) discovers root plus every account with uid >= 1000 and a real login shell
from /etc/passwd, same rule the reference implementation uses. Or set COC_L3_FULL_USERS to an
explicit comma-separated list (e.g. "root,alice,coc-demo-intruder").

Standard library only.
"""

import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import pwd  # POSIX only
except ImportError:
    import types as _types

    def _no_such_user(name):
        raise KeyError(name)

    pwd = _types.SimpleNamespace(getpwnam=_no_such_user)

SIGKILL = getattr(signal, "SIGKILL", 9)
STATE_DIR = os.environ.get("COC_L3_STATE", "/var/lib/coc-layer3")
APP_DIR = os.environ.get("APP_DIR", "/opt/chain-of-custody/banking-system")
NEVER = ("reboot", "shutdown", "poweroff", "halt", "init 0", "init 6", "kexec")  # refused, always


class ConfiguredBadly(Exception):
    """A site_down/site_up command looked like a reboot. Refused before anything runs."""


def interactive_users(passwd_path="/etc/passwd"):
    """root plus every account with uid >= 1000 and a real login shell. Service accounts excluded."""
    users = []
    try:
        for line in Path(passwd_path).read_text(encoding="utf-8").splitlines():
            parts = line.split(":")
            if len(parts) < 7:
                continue
            name, uid_text, shell = parts[0], parts[2], parts[6]
            try:
                uid = int(uid_text)
            except ValueError:
                continue
            if name == "root" or (uid >= 1000 and name != "nobody" and shell and not shell.endswith(("nologin", "false"))):
                users.append(name)
    except OSError:
        users = ["root"]
    return users


def configured_users():
    raw = os.environ.get("COC_L3_FULL_USERS", "auto")
    if raw == "auto":
        return interactive_users()
    return [name.strip() for name in raw.split(",") if name.strip()]


def _uids(users):
    out = []
    for name in users:
        try:
            out.append(pwd.getpwnam(name).pw_uid)
        except KeyError:
            pass
    return out


def _check_not_reboot(commands):
    for cmd in commands:
        if any(bad in cmd for bad in NEVER):
            raise ConfiguredBadly(f"refusing a reboot/shutdown-style command: {cmd!r}")


# ---------- ending login sessions for a set of users, without ever killing ourselves ----------
# Same technique as l3_lockout.py's demo-scoped version, generalized to many uids instead of one.

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


def login_sessions_of(uids, proc_root="/proc"):
    """[{pid, cmd}] for every process belonging to any of `uids` that is in a login session
    (has a controlling terminal, or a login uid PAM set), excluding this process and its ancestors."""
    root = Path(proc_root)
    if not root.is_dir():
        return []
    keep = _ancestor_pids(root)
    uid_set = set(uids)
    found = []
    for entry in root.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid in keep or pid == 1:
            continue
        if _process_uid(root, pid) not in uid_set:
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


def end_sessions(users, dry_run, proc_root="/proc"):
    found = login_sessions_of(_uids(users), proc_root)
    for item in found:
        if dry_run:
            item["killed"] = False
            item["dry_run"] = True
            continue
        try:
            os.kill(item["pid"], SIGKILL)
            item["killed"] = True
        except (ProcessLookupError, PermissionError) as error:
            item["killed"] = False
            item["error"] = error.__class__.__name__
    return found


# ---------- the commands: touch /etc/nologin, passwd -l, usermod --expiredate 1, site down/up ----------

def run(command, dry_run):
    if dry_run:
        return {"cmd": " ".join(command), "ran": False, "rc": None}
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=20)
        return {"cmd": " ".join(command), "ran": True, "rc": result.returncode, "out": (result.stdout + result.stderr)[-2000:]}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"cmd": " ".join(command), "ran": False, "rc": None, "error": str(error)}


def touch_nologin(dry_run):
    return run(["touch", "/etc/nologin"], dry_run)


def remove_nologin(dry_run):
    if dry_run or not os.path.exists("/etc/nologin"):
        return {"cmd": "rm -f /etc/nologin", "ran": False, "rc": None}
    try:
        os.remove("/etc/nologin")
        return {"cmd": "rm -f /etc/nologin", "ran": True, "rc": 0}
    except OSError as error:
        return {"cmd": "rm -f /etc/nologin", "ran": False, "rc": None, "error": str(error)}


def lock_user(name, dry_run):
    return [run(["passwd", "-l", name], dry_run), run(["usermod", "--expiredate", "1", name], dry_run)]


def unlock_user(name, dry_run):
    return [run(["passwd", "-u", name], dry_run), run(["usermod", "--expiredate", "", name], dry_run)]


def site_down_commands():
    return os.environ.get("COC_L3_SITE_DOWN",
                          f"docker compose -f {APP_DIR}/docker-compose.yml stop frontend backend").split(" && ")


def site_up_commands():
    return os.environ.get("COC_L3_SITE_UP",
                          f"docker compose -f {APP_DIR}/docker-compose.yml up -d").split(" && ")


def run_shell(commands, dry_run):
    return [run(cmd.split(), dry_run) for cmd in commands]


# ---------- evidence ----------

def write_evidence(record):
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    path = os.path.join(STATE_DIR, f"full-lockout-{record['id']}.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(record, handle, indent=2)
    os.chmod(path, 0o600)
    return path


# ---------- the two real actions ----------

def lock(reason, dry_run, users=None, now=None):
    """The full quarantine sequence. dry_run must be passed explicitly — there is no silent default.
    Returns (event, record). Refuses before touching anything if a configured command looks like a
    reboot/shutdown."""
    site_down_cmds, site_up_cmds = site_down_commands(), site_up_commands()
    _check_not_reboot(site_down_cmds)
    _check_not_reboot(site_up_cmds)

    moment = now if now is not None else time.time()
    quarantine_id = f"qf-{int(moment)}"
    target_users = users if users is not None else configured_users()

    site_down = run_shell(site_down_cmds, dry_run)
    nologin = touch_nologin(dry_run)
    locked = {name: lock_user(name, dry_run) for name in target_users}
    sessions = end_sessions(target_users, dry_run)

    record = {
        "id": quarantine_id,
        "action": "lock",
        "reason": reason,
        "dry_run": dry_run,
        "users": target_users,
        "site_down": site_down,
        "nologin": nologin,
        "locked": locked,
        "sessions_ended": sessions,
        "recorded_at": datetime.fromtimestamp(moment, timezone.utc).isoformat(timespec="seconds"),
    }
    evidence = write_evidence(record)

    lines = [
        ("REAL: " if not dry_run else "PLANNED: ") + "take the public banking site down (" + "; ".join(site_down_cmds) + ")",
        ("REAL: " if not dry_run else "PLANNED: ") + "touch /etc/nologin",
        *[("REAL: " if not dry_run else "PLANNED: ") + f"lock out {name}: passwd -l + usermod --expiredate 1" for name in target_users],
        ("REAL: " if not dry_run else "PLANNED: ") + f"end login sessions: {len(sessions)} process(es)",
    ]
    event = {
        "layer": 3,
        "trigger": "quarantine:locked",
        "state": "alert",
        "summary": f"Layer 3 FULL {'(dry run) ' if dry_run else ''}lockout: {reason} — {len(target_users)} user(s)"[:200],
        "detail": {
            "quarantine_id": quarantine_id,
            "reason": reason[:300],
            "dry_run": dry_run,
            "users": ",".join(target_users),
            "site_down": "\n".join(lines[:1]),
            "lockout": "\n".join(lines[1:]),
            "evidence": evidence,
        },
        "who": {},
    }
    return event, record


def unlock(dry_run, users=None, now=None):
    moment = now if now is not None else time.time()
    target_users = users if users is not None else configured_users()
    unlocked = {name: unlock_user(name, dry_run) for name in target_users}
    nologin = remove_nologin(dry_run)
    site_up = run_shell(site_up_commands(), dry_run)
    record = {
        "id": f"uf-{int(moment)}",
        "action": "unlock",
        "dry_run": dry_run,
        "users": target_users,
        "unlocked": unlocked,
        "nologin": nologin,
        "site_up": site_up,
        "recorded_at": datetime.fromtimestamp(moment, timezone.utc).isoformat(timespec="seconds"),
    }
    write_evidence(record)
    event = {
        "layer": 3,
        "trigger": "quarantine:released",
        "state": "normal",
        "summary": f"Layer 3 FULL {'(dry run) ' if dry_run else ''}release: {len(target_users)} user(s) restored"[:200],
        "detail": {"quarantine_id": record["id"], "dry_run": dry_run, "users": ",".join(target_users)},
        "who": {},
    }
    return event, record


def main():
    args = sys.argv[1:]
    real = "--real" in args
    args = [a for a in args if a != "--real"]
    command = args[0] if args else "status"
    dry_run = not real

    if command == "lock":
        event, record = lock(" ".join(args[1:]) or "manual full-lockout demo", dry_run)
        print(json.dumps({"event": event, "record": record}, indent=2))
    elif command == "unlock":
        event, record = unlock(dry_run)
        print(json.dumps({"event": event, "record": record}, indent=2))
    elif command == "users":
        print("\n".join(configured_users()))
    else:
        sys.exit("usage: l3_full_lockout.py lock|unlock|users [--real] [reason]")


if __name__ == "__main__":
    main()
