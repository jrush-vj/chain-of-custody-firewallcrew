#!/usr/bin/env bash
# Print the 3 fixed demo unlock keys. Does not touch any account; safe to run any time, including
# before triggering a lockout, so a presenter can show the keys ahead of the demo.
#
# Run on ct105:
#   bash /opt/chain-of-custody/deploy/ct105/layer3/generate-unlock-keys.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
python3 "$here/l3_lockout.py" keys
