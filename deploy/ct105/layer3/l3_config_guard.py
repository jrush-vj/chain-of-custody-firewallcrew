#!/usr/bin/env python3
"""Layer 3 config guard for ct105: watches the settings that connect the bank to the witness.

The bank reaches the witness through WITNESS_URL (and WITNESS_NODE_ID) in banking-system/.env, which
docker-compose.yml loads. Editing those can cut the bank off from the witness. This module remembers
the approved values, reports drift, and restores them.

Only the two named .env keys are ever read, kept, or printed; every other line in .env (passwords,
secrets) is passed through untouched. Standard library only.

Usage:
  python3 l3_config_guard.py approve   # remember the current values as approved (run at install)
  python3 l3_config_guard.py status    # print any drift; exit 1 if there is some
  python3 l3_config_guard.py restore   # put the approved values back; prints 'restored config: <item>'

Environment (defaults suit ct105):
  COC_BANK_ENV      /opt/chain-of-custody/banking-system/.env
  COC_BANK_COMPOSE  /opt/chain-of-custody/banking-system/docker-compose.yml
  COC_L3_STATE      /var/lib/coc-layer3
"""

import hashlib
import json
import os
import shutil
import sys
import tempfile

WATCHED_KEYS = ("WITNESS_URL", "WITNESS_NODE_ID")


def paths():
    state = os.environ.get("COC_L3_STATE", "/var/lib/coc-layer3")
    return {
        "env": os.environ.get("COC_BANK_ENV", "/opt/chain-of-custody/banking-system/.env"),
        "compose": os.environ.get("COC_BANK_COMPOSE", "/opt/chain-of-custody/banking-system/docker-compose.yml"),
        "state": state,
        "baseline": os.path.join(state, "config-baseline.json"),
        "compose_copy": os.path.join(state, "docker-compose.approved.yml"),
    }


def _unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def read_watched_values(env_path):
    """{key: value} for the watched keys only. Other lines are skipped without being stored."""
    values = {}
    try:
        with open(env_path, encoding="utf-8") as handle:
            for line in handle:
                key, separator, rest = line.rstrip("\r\n").partition("=")
                if separator and key.strip() in WATCHED_KEYS:
                    values[key.strip()] = _unquote(rest)
    except OSError:
        pass
    return values


def file_sha256(path):
    try:
        with open(path, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()
    except OSError:
        return ""


def current_snapshot():
    p = paths()
    return {"env": read_watched_values(p["env"]), "compose_sha256": file_sha256(p["compose"])}


def load_baseline():
    try:
        with open(paths()["baseline"], encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def approve():
    p = paths()
    os.makedirs(p["state"], mode=0o700, exist_ok=True)
    snapshot = current_snapshot()
    with open(p["baseline"], "w", encoding="utf-8") as handle:
        json.dump(snapshot, handle, indent=2)
    os.chmod(p["baseline"], 0o600)
    if os.path.exists(p["compose"]):
        shutil.copyfile(p["compose"], p["compose_copy"])
        os.chmod(p["compose_copy"], 0o600)
    return snapshot


def drift():
    """List of {item, approved, current} for everything that differs from the approved baseline.
    Empty when nothing differs, and also when no baseline has been approved yet."""
    baseline = load_baseline()
    if baseline is None:
        return []
    now = current_snapshot()
    changes = []
    for key in WATCHED_KEYS:
        approved, current = baseline["env"].get(key), now["env"].get(key)
        if approved is not None and approved != current:
            changes.append({"item": key, "approved": approved, "current": current or "(missing)"})
    if baseline["compose_sha256"] and baseline["compose_sha256"] != now["compose_sha256"]:
        changes.append({"item": "docker-compose.yml", "approved": baseline["compose_sha256"][:12],
                        "current": (now["compose_sha256"] or "(missing)")[:12]})
    return changes


def _atomic_write(path, data):
    """Replace a file's contents, keeping its permissions and owner."""
    directory = os.path.dirname(path)
    handle, temp_path = tempfile.mkstemp(dir=directory, prefix=".coc-restore-")
    try:
        with os.fdopen(handle, "wb") as out:
            out.write(data)
        shutil.copymode(path, temp_path)
        try:
            info = os.stat(path)
            os.chown(temp_path, info.st_uid, info.st_gid)
        except (AttributeError, PermissionError, OSError):
            pass
        os.replace(temp_path, path)
    except BaseException:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
        raise


def restore():
    """Put the approved values back. Returns the list of items restored."""
    baseline = load_baseline()
    if baseline is None:
        raise SystemExit("no approved baseline: run 'l3_config_guard.py approve' at install time")
    p = paths()
    restored = []

    # .env: rewrite only the watched lines, byte-for-byte everything else.
    wanted = {key: baseline["env"][key] for key in WATCHED_KEYS if key in baseline["env"]}
    if os.path.exists(p["env"]) and wanted:
        with open(p["env"], "rb") as handle:
            original = handle.read().decode("utf-8")
        lines = original.splitlines(keepends=True)
        seen = set()
        for index, line in enumerate(lines):
            key = line.split("=", 1)[0].strip()
            if "=" in line and key in wanted:
                ending = line[len(line.rstrip("\r\n")):]
                replacement = f"{key}={wanted[key]}{ending or chr(10)}"
                if line != replacement:
                    restored.append(key)
                lines[index] = replacement
                seen.add(key)
        for key in wanted:
            if key not in seen:
                if lines and not lines[-1].endswith("\n"):
                    lines[-1] += "\n"
                lines.append(f"{key}={wanted[key]}\n")
                restored.append(key)
        updated = "".join(lines)
        if updated != original:
            _atomic_write(p["env"], updated.encode("utf-8"))

    # docker-compose.yml: copy the approved version back if it changed.
    if baseline["compose_sha256"] and os.path.exists(p["compose_copy"]) \
            and file_sha256(p["compose"]) != baseline["compose_sha256"]:
        if os.path.exists(p["compose"]):
            with open(p["compose_copy"], "rb") as handle:
                _atomic_write(p["compose"], handle.read())
        else:
            shutil.copyfile(p["compose_copy"], p["compose"])
        restored.append("docker-compose.yml")
    return restored


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    if command == "approve":
        snapshot = approve()
        print("approved:", ", ".join(f"{k}={v}" for k, v in snapshot["env"].items()) or "(no watched keys found)",
              "| compose sha256", snapshot["compose_sha256"][:12])
    elif command == "status":
        changes = drift()
        if load_baseline() is None:
            print("no approved baseline yet")
            sys.exit(2)
        for change in changes:
            print(f"DRIFT {change['item']}: approved {change['approved']} -> current {change['current']}")
        print("no drift" if not changes else f"{len(changes)} item(s) differ from the approved settings")
        sys.exit(1 if changes else 0)
    elif command == "restore":
        for item in restore():
            print(f"restored config: {item}")
    else:
        sys.exit("usage: l3_config_guard.py approve|status|restore")


if __name__ == "__main__":
    main()
