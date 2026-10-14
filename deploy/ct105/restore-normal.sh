#!/usr/bin/env bash
# Put Layers 1 and 2 back to normal on ct105: the bank log to its approved content, and every
# transaction changed by the Layer 2 demo to its original value. Run as root on ct105:
#   bash /opt/chain-of-custody/deploy/ct105/restore-normal.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
bash "$here/layer1/restore-layer1.sh" || echo "Layer 1 restore reported a problem"
bash "$here/layer2/restore-layer2.sh" || echo "Layer 2 restore reported a problem"
