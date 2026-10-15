"""Layer 3 quarantine for ct105: a DRY RUN. It records what Layer 3 would do and executes none of it.

Triggered by the monitor when the bank-to-witness link is compromised (the approved witness settings
changed, or no contact with the witness for QUARANTINE_AFTER_S). The planned response, in order:

  1. take the public site down                         (recorded, not executed)
  2. log out every login session and banking session   (recorded, not executed; accounts stay
                                                        unlocked)
  3. restore the approved witness link settings        (recorded; the real restore runs from the
                                                        website's "Restore to normal" button)
  4. recreate the backend so it reconnects             (recorded, not executed)

No reboot or power-control command is part of the response.

The only command run is `who`, read-only, to count the login sessions that would be logged out.
Standard library only.
"""

import json
import os
import subprocess
import time
from datetime import datetime, timezone

STATE_DIR = os.environ.get("COC_L3_STATE", "/var/lib/coc-layer3")


def login_session_count():
    """Number of login sessions on this host (read-only)."""
    try:
        output = subprocess.run(["who"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return 0
    return len([line for line in output.splitlines() if line.strip()])


def build_plan(sessions):
    """The recorded response, as two lists of plain-language actions."""
    site_down = ["take the public banking site down (docker compose stop frontend)"]
    response = [
        f"log out every login session on ct105: {sessions} session(s); accounts are not locked",
        "log out every banking customer session (revoke all issued session tokens)",
        "restore the approved witness link settings (WITNESS_URL in banking-system/.env, docker-compose.yml)",
        "recreate the backend container so it reconnects to the witness",
    ]
    return site_down, response


def run_dry(reason, now=None):
    """Record a dry-run quarantine and return the layer-3 event to send to the witness."""
    moment = now if now is not None else time.time()
    quarantine_id = f"q-{int(moment)}"
    site_down, response = build_plan(login_session_count())
    record = {
        "quarantine_id": quarantine_id,
        "dry_run": True,
        "reason": reason,
        "recorded_at": datetime.fromtimestamp(moment, timezone.utc).isoformat(timespec="seconds"),
        "site_down": site_down,
        "response": response,
    }
    evidence = os.path.join(STATE_DIR, f"quarantine-{quarantine_id}.json")
    try:
        os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
        with open(evidence, "w", encoding="utf-8") as handle:
            json.dump(record, handle, indent=2)
        os.chmod(evidence, 0o600)
    except OSError:
        evidence = "(not written)"
    return {
        "layer": 3,
        "trigger": "quarantine:locked",
        "state": "alert",
        "summary": f"Layer 3 dry run: {reason}"[:200],
        # Flat string values only; the witness turns the newline-joined lists back into rows.
        "detail": {
            "quarantine_id": quarantine_id,
            "reason": reason[:300],
            "dry_run": True,
            "site_down": "\n".join(site_down),
            "lockout": "\n".join(response),
            "evidence": evidence,
        },
        "who": {},
    }
