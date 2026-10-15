"""Layer 3 response with a safe demo default and an explicitly confirmed full-lockout mode.

The demo path remains scoped to one non-root account. Full mode captures evidence, stops the site,
locks interactive accounts, and requires a saved-state 2-of-3-key recovery.

CLI:
  python3 l3_lockout.py lock [reason]         run the configured mode
  python3 l3_lockout.py unlock KEY KEY        restore the configured mode
  python3 l3_lockout.py keys ROOT_ONLY_FILE   write keys; print hashes only
  python3 l3_lockout.py status                report the configured mode's lock state

Standard library only.
"""

import getpass
import hashlib
import json
import os
import secrets
import shlex
import signal
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
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
FULL_CONFIRMATION = "I_UNDERSTAND_ROOT_LOCKOUT"
BREAK_GLASS_DEFAULT = "coc-break-glass"
UNLOCK_HASHES_FILE = os.environ.get(
    "COC_L3_UNLOCK_HASHES",
    os.path.join(STATE_DIR, "unlock-key-hashes.json"),
)


class FullLockoutRefused(Exception):
    """Raised when full mode has not met every explicit safety prerequisite."""


def configured_mode():
    mode = os.environ.get("COC_L3_MODE", "demo").strip().lower()
    if mode not in {"demo", "full"}:
        raise FullLockoutRefused("COC_L3_MODE must be either 'demo' or 'full'")
    return mode


def full_mode_confirmed():
    return os.environ.get("COC_L3_FULL_CONFIRM") == FULL_CONFIRMATION


def monitor_account():
    """Return the account identity of the monitor process."""
    try:
        return pwd.getpwuid(os.getuid()).pw_name
    except (AttributeError, KeyError, OSError):
        return getpass.getuser()


def break_glass_account():
    return os.environ.get("COC_L3_BREAK_GLASS_ACCOUNT", BREAK_GLASS_DEFAULT)


def keep_accounts():
    configured = {
        name.strip()
        for name in os.environ.get("COC_KEEP_ACCOUNTS", "").split(",")
        if name.strip()
    }
    configured.add(break_glass_account())
    configured.add(monitor_account())
    return configured


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
    uids = set(uid) if isinstance(uid, (list, tuple, set)) else {uid}
    found = []
    for entry in root.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid in keep or pid == 1:
            continue
        if _process_uid(root, pid) not in uids:
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
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
    except subprocess.TimeoutExpired as error:
        return {
            "cmd": command,
            "ran": True,
            "rc": 124,
            "out": error.stdout or "",
            "error": "command timed out",
        }
    except OSError as error:
        return {
            "cmd": command,
            "ran": False,
            "rc": 127,
            "out": "",
            "error": str(error),
        }
    return {
        "cmd": command,
        "ran": True,
        "rc": result.returncode,
        "out": result.stdout,
        "error": result.stderr,
    }


def _command_succeeded(result):
    return isinstance(result, dict) and result.get("rc") == 0


def disable_login(name):
    """usermod -L (password lock) + an expiry date in the past: two independent ways in, both closed."""
    results = [run(["usermod", "-L", name]), run(["usermod", "--expiredate", "1", name])]
    return all(_command_succeeded(result) for result in results), results


def enable_login(name):
    results = [run(["usermod", "-U", name]), run(["usermod", "--expiredate", "", name])]
    return all(_command_succeeded(result) for result in results), results


def write_evidence(record):
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    path = os.path.join(STATE_DIR, f"lockout-{record['id']}.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(record, handle, indent=2)
    os.chmod(path, 0o600)
    return path


def _full_interactive_users(passwd_path="/etc/passwd"):
    users = []
    for line in Path(passwd_path).read_text(encoding="utf-8").splitlines():
        parts = line.split(":")
        if len(parts) < 7:
            continue
        name, shell = parts[0], parts[6]
        if shell and not shell.endswith(("nologin", "false")):
            users.append(name)
    if "root" not in users:
        users.insert(0, "root")
    return users


def _require_full_mode():
    if configured_mode() != "full":
        raise FullLockoutRefused("set COC_L3_MODE=full to use the full lockout")
    if not full_mode_confirmed():
        raise FullLockoutRefused(
            f"full mode requires COC_L3_FULL_CONFIRM={FULL_CONFIRMATION}"
        )
    account = monitor_account()
    if account == "root":
        raise FullLockoutRefused(
            "full mode refuses to run while the monitor account is root; "
            "the monitor must run as a separate non-root account"
        )
    if getattr(os, "geteuid", lambda: 0)() != 0:
        raise FullLockoutRefused("full mode system actions must run with root privileges")

    break_glass = break_glass_account()
    if break_glass not in keep_accounts():
        raise FullLockoutRefused("COC_KEEP_ACCOUNTS must include the break-glass account")
    try:
        pwd.getpwnam(break_glass)
    except KeyError as error:
        raise FullLockoutRefused(
            f"break-glass account {break_glass!r} does not exist; run setup-break-glass.sh"
        ) from error

    password_status = run(["passwd", "-S", break_glass])
    status = password_status.get("out", "").split()
    if not _command_succeeded(password_status) or len(status) < 2 or status[1] != "P":
        raise FullLockoutRefused(
            f"break-glass account {break_glass!r} must have an active password hash"
        )

    try:
        with open(UNLOCK_HASHES_FILE, encoding="utf-8") as handle:
            hashes = json.load(handle)
    except (OSError, ValueError) as error:
        raise FullLockoutRefused(
            "2-of-3 full-mode unlock hashes are missing; run generate-unlock-keys.sh"
        ) from error
    if not isinstance(hashes, dict) or len(hashes) != 3 or any(
        not isinstance(value, str) or len(value) != 64
        for value in hashes.values()
    ):
        raise FullLockoutRefused("full-mode unlock hash file is invalid")


def _account_state(name):
    status = run(["passwd", "-S", name])
    fields = status.get("out", "").split()
    if not _command_succeeded(status) or len(fields) < 2:
        raise FullLockoutRefused(f"cannot read password status for {name!r}")
    shadow = run(["getent", "shadow", name])
    shadow_fields = shadow.get("out", "").strip().split(":")
    if not _command_succeeded(shadow) or len(shadow_fields) < 8:
        raise FullLockoutRefused(f"cannot read account expiry for {name!r}")
    return {
        "name": name,
        "password_status": fields[1],
        "expire_days": shadow_fields[7],
    }


def _capture_evidence(evidence_dir):
    captures = {}
    for label, command in (
        ("ps.txt", ["ps", "-ef"]),
        ("ss.txt", ["ss", "-tnp"]),
        ("who.txt", ["who"]),
    ):
        result = subprocess.run(command, capture_output=True, text=True, timeout=20)
        if result.returncode != 0:
            raise FullLockoutRefused(
                f"evidence capture failed for {label}: {(result.stderr or '').strip()}"
            )
        captures[label] = result.stdout
        with open(os.path.join(evidence_dir, label), "w", encoding="utf-8") as handle:
            handle.write(result.stdout)

    log_dir = os.environ.get("COC_BANK_LOG_DIR", "/var/log/bank-demo")
    log_hashes = []
    if os.path.isdir(log_dir):
        for directory, _subdirs, filenames in os.walk(log_dir):
            for filename in sorted(filenames):
                path = os.path.join(directory, filename)
                if os.path.islink(path):
                    continue
                digest = hashlib.sha256()
                with open(path, "rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(chunk)
                log_hashes.append({"path": path, "sha256": digest.hexdigest()})
    with open(os.path.join(evidence_dir, "bank-log-hashes.json"), "w", encoding="utf-8") as handle:
        json.dump(log_hashes, handle, indent=2)
    return {"captures": sorted(captures), "bank_log_hashes": log_hashes}


def _seal_evidence_directory(evidence_dir):
    result = run(["chattr", "+a", evidence_dir])
    if not _command_succeeded(result):
        message = result.get("out") or result.get("error") or "chattr failed"
        print(f"Layer 3 evidence warning: append-only attribute unavailable: {message}", file=sys.stderr)
        return False
    return True


def generate_unlock_keys(output_path):
    """Write keys to a private file and return only their SHA-256 hashes for display."""
    if not output_path:
        raise FullLockoutRefused("provide a root-only output file path")
    mode = configured_mode()
    holders = ("SOC lead", "Auditor", "Compliance officer")
    if mode == "full":
        values = {holder: secrets.token_urlsafe(32) for holder in holders}
        hashes = {
            holder: hashlib.sha256(value.encode("utf-8")).hexdigest()
            for holder, value in values.items()
        }
        os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
        with open(UNLOCK_HASHES_FILE, "x", encoding="utf-8") as handle:
            json.dump(hashes, handle, indent=2)
        os.chmod(UNLOCK_HASHES_FILE, 0o600)
    else:
        values = dict(demo_keys.DEMO_KEYS)
        hashes = {
            holder: hashlib.sha256(value.encode("utf-8")).hexdigest()
            for holder, value in values.items()
        }

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(output_path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            for holder, value in values.items():
                handle.write(f"{holder}: {value}\n")
    except BaseException:
        os.unlink(output_path)
        raise
    os.chmod(output_path, 0o600)
    return hashes


def _full_unlock_keys_valid(keys):
    try:
        with open(UNLOCK_HASHES_FILE, encoding="utf-8") as handle:
            hashes = json.load(handle)
    except (OSError, ValueError):
        return False
    actual = {hashlib.sha256(key.strip().encode("utf-8")).hexdigest() for key in keys}
    expected = set(hashes.values())
    return len(actual & expected) >= 2


def _read_active_state():
    pointer = os.path.join(STATE_DIR, "active-full-lockout.json")
    try:
        with open(pointer, encoding="utf-8") as handle:
            state_path = json.load(handle)["state_file"]
        with open(state_path, encoding="utf-8") as handle:
            return state_path, json.load(handle)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise FullLockoutRefused("no valid full-lockout state file is available to unlock") from error


def full_lock(reason, now=None):
    """Run the opt-in full response. All recovery state is captured before account changes."""
    _require_full_mode()
    pointer = os.path.join(STATE_DIR, "active-full-lockout.json")
    if os.path.exists(pointer):
        raise FullLockoutRefused("an active full-lockout recovery state already exists")
    moment = now if now is not None else time.time()
    quarantine_id = f"qf-{int(moment)}"
    evidence_dir = os.path.join(STATE_DIR, quarantine_id)
    os.makedirs(evidence_dir, mode=0o700, exist_ok=False)
    evidence = _capture_evidence(evidence_dir)
    _seal_evidence_directory(evidence_dir)

    keep = keep_accounts()
    users = [name for name in _full_interactive_users() if name not in keep]
    account_states = [_account_state(name) for name in users]
    recovery_state = {
        "id": quarantine_id,
        "action": "lock",
        "reason": reason,
        "users": account_states,
        "evidence": evidence,
        "evidence_dir": evidence_dir,
        "recorded_at": datetime.fromtimestamp(moment, timezone.utc).isoformat(timespec="seconds"),
    }
    state_path = os.path.join(evidence_dir, "state.json")
    with open(state_path, "w", encoding="utf-8") as handle:
        json.dump(recovery_state, handle, indent=2)
    os.chmod(state_path, 0o600)
    with open(pointer, "w", encoding="utf-8") as handle:
        json.dump({"state_file": state_path}, handle)
    os.chmod(pointer, 0o600)

    compose = os.environ.get(
        "COC_BANK_COMPOSE",
        os.path.join(os.environ.get("APP_DIR", "/opt/chain-of-custody/banking-system"), "docker-compose.yml"),
    )
    configured_site_down = os.environ.get("COC_SITE_DOWN_CMD")
    site_down = (
        shlex.split(configured_site_down)
        if configured_site_down
        else ["docker", "compose", "-f", compose, "stop", "frontend"]
    )
    if not site_down or any(
        token.rsplit("/", 1)[-1] in {"reboot", "shutdown", "poweroff", "halt"}
        for token in site_down
    ):
        raise FullLockoutRefused("COC_SITE_DOWN_CMD contains a forbidden power-control command")
    site_result = run(site_down)
    if not _command_succeeded(site_result):
        print(
            f"Layer 3 site-down command failed: {site_result.get('out') or site_result.get('error')}",
            file=sys.stderr,
        )
    nologin = run(["touch", "/etc/nologin"])
    locked = {}
    for account in account_states:
        name = account["name"]
        locked[name] = []
        if account["password_status"] != "L":
            locked[name].append(run(["passwd", "-l", name]))
        locked[name].append(run(["usermod", "--expiredate", "1", name]))
    sessions = end_sessions([pwd.getpwnam(name).pw_uid for name in users], dry_run=False)

    failed = []
    if not _command_succeeded(site_result):
        failed.append("site_down")
    if not _command_succeeded(nologin):
        failed.append("nologin")
    for name, results in locked.items():
        if any(not _command_succeeded(result) for result in results):
            failed.append(f"account:{name}")
    if any(not item.get("killed", False) for item in sessions):
        failed.append("sessions")
    complete = not failed
    record = {
        **recovery_state,
        "site_down": site_result,
        "nologin": nologin,
        "locked": locked,
        "sessions_ended": sessions,
        "break_glass_account": break_glass_account(),
        "break_glass_available": True,
        "dry_run": False,
        "action_state": "quarantined" if complete else "partial",
        "failed_actions": failed,
        "completed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    with open(state_path, "w", encoding="utf-8") as handle:
        json.dump(record, handle, indent=2)
    os.chmod(state_path, 0o600)
    summary_status = "QUARANTINED" if complete else "PARTIAL QUARANTINE"
    event = {
        "layer": 3,
        "trigger": "quarantine:locked",
        "state": "alert",
        "summary": f"Layer 3 FULL {summary_status}: {reason} — {len(users)} account(s) targeted"[:200],
        "detail": {
            "quarantine_id": quarantine_id,
            "reason": reason[:300],
            "mode": "full",
            "dry_run": False,
            "action_state": record["action_state"],
            "failed_actions": failed,
            "users": ",".join(users),
            "site_down": "REAL: " + " ".join(site_down),
            "lockout": (
                f"REAL: /etc/nologin; targeted {len(users)} account(s); "
                f"ended {sum(1 for item in sessions if item.get('killed'))} session(s)"
            ),
            "evidence": evidence_dir,
            "break_glass_available": True,
            "unlock_command": "Run unlock.sh on ct105 with any 2 of the 3 keys; website approvals only record votes.",
        },
        "who": {},
    }
    return event, record


def full_unlock(keys, now=None):
    """Restore the saved pre-lock state. No account list is rediscovered and no service is restarted."""
    if not _full_unlock_keys_valid(keys):
        return None, False
    state_path, record = _read_active_state()
    if record.get("action") != "lock" or record.get("dry_run"):
        raise FullLockoutRefused("saved full-lockout state is not an active real lockout")
    nologin = run(["rm", "-f", "/etc/nologin"])
    restored = {}
    for account in record["users"]:
        name = account["name"]
        steps = []
        if account["password_status"] == "P":
            steps.append(run(["passwd", "-u", name]))
        elif account["password_status"] == "NP":
            steps.append(run(["passwd", "-d", name]))
        expiry = account["expire_days"]
        expiry_date = ""
        if expiry not in {"", "-1"}:
            expiry_date = (datetime(1970, 1, 1) + timedelta(days=int(expiry))).date().isoformat()
        steps.append(run(["usermod", "--expiredate", expiry_date, name]))
        restored[name] = steps
    failed = []
    if not _command_succeeded(nologin):
        failed.append("nologin")
    for name, results in restored.items():
        if any(not _command_succeeded(result) for result in results):
            failed.append(f"account:{name}")
    moment = now if now is not None else time.time()
    record.update({
        "action": "unlock" if not failed else "lock",
        "action_state": "restored" if not failed else "partial_restore",
        "last_unlock_attempt": restored,
        "nologin_removed": nologin,
        "failed_restore_actions": failed,
        "unlocked_at": datetime.fromtimestamp(moment, timezone.utc).isoformat(timespec="seconds"),
    })
    with open(state_path, "w", encoding="utf-8") as handle:
        json.dump(record, handle, indent=2)
    pointer = os.path.join(STATE_DIR, "active-full-lockout.json")
    if not failed and os.path.exists(pointer):
        os.remove(pointer)
    state = "normal" if not failed else "alert"
    summary = (
        f"Layer 3 FULL release: {len(restored)} account(s) restored from saved state"
        if not failed
        else f"Layer 3 FULL partial release: {len(failed)} action(s) need recovery"
    )
    event = {
        "layer": 3,
        "trigger": "quarantine:released" if not failed else "quarantine:locked",
        "state": state,
        "summary": summary[:200],
        "detail": {
            "quarantine_id": record["id"],
            "mode": "full",
            "dry_run": False,
            "action_state": record["action_state"],
            "failed_actions": failed,
            "users": ",".join(restored),
            "break_glass_available": True,
        },
        "who": {},
    }
    return event, not failed


def is_locked(name):
    result = run(["passwd", "-S", name])
    # `passwd -S` prints "name L ..." when locked, "name P ..." or "name NP ..." otherwise.
    fields = result.get("out", "").split()
    return _command_succeeded(result) and fields[1:2] == ["L"]


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
            reason = " ".join(sys.argv[2:]) or "manual lockout demo"
            if configured_mode() == "full":
                event, record = full_lock(reason)
                print(json.dumps(event))
            else:
                event, ok = lock(reason)
                print(f"demo account locked: {ok}")
                print(json.dumps(event))
        elif command == "unlock":
            if configured_mode() == "full":
                event, ok = full_unlock(sys.argv[2:])
                label = "full lockout restored"
            else:
                event, ok = unlock(sys.argv[2:])
                label = "demo account unlocked"
            if not ok and event is None:
                sys.exit("refused: need 2 distinct correct keys for the configured mode")
            print(f"{label}: {ok}")
            print(json.dumps(event))
        elif command == "keys":
            if len(sys.argv) != 3:
                sys.exit("usage: l3_lockout.py keys ROOT_ONLY_OUTPUT_FILE")
            for holder, digest in generate_unlock_keys(sys.argv[2]).items():
                print(f"{holder}: sha256:{digest}")
        elif command == "status":
            if configured_mode() == "full":
                try:
                    _read_active_state()
                    print("full lockout: active")
                except FullLockoutRefused:
                    print("full lockout: not active")
            else:
                name, _uid = resolve_demo_user()
                print(f"{name}: {'locked' if is_locked(name) else 'not locked'}")
        else:
            sys.exit("usage: l3_lockout.py lock|unlock KEY KEY|keys ROOT_ONLY_OUTPUT_FILE|status")
    except UnsafeTarget as error:
        sys.exit(f"refusing: {error}")
    except FullLockoutRefused as error:
        sys.exit(f"refusing full lockout: {error}")


if __name__ == "__main__":
    main()
