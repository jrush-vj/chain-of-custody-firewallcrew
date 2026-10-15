"""Post one layer event JSON (read from stdin) to the witness, signed the same way the monitor does.
Used by lockout.sh/unlock.sh so a manually-triggered demo shows up on the witness page immediately,
without waiting for the monitor's own poll loop.

Needs WITNESS_URL, WITNESS_NODE_ID, WITNESS_HMAC_SECRET in the environment (same as the monitor).
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "layer1"))
import monitor  # noqa: E402


def main():
    event = json.load(sys.stdin)
    if monitor.post_event(event):
        print("reported to the witness")
    else:
        sys.exit("could not reach the witness; the event is saved in the evidence file only")


if __name__ == "__main__":
    main()
