#!/usr/bin/env bash
# Put Layers 1, 2 and 3 back to normal on ct105: the bank log to its approved content, every transaction
# changed by the Layer 2 demo to its original value, and the witness link settings to the approved ones.
# Run as root on ct105 (the website's "Restore to normal" button runs this through the monitor):
#   bash /opt/chain-of-custody/deploy/ct105/restore-normal.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
bash "$here/layer1/restore-layer1.sh" || echo "Layer 1 restore reported a problem"
bash "$here/layer2/restore-layer2.sh" || echo "Layer 2 restore reported a problem"
bash "$here/layer3/restore-config.sh" || echo "Layer 3 restore reported a problem"
