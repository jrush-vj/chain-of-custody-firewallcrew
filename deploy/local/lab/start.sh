#!/usr/bin/env bash
# PID 1 of the coc-lab container: prepare the ct105 stand-in, then run the Layer 1/2/3 monitor in the
# foreground so `docker logs coc-lab` (test-stack.sh lab-logs) shows everything it reports.
set -uo pipefail
. /opt/chain-of-custody/deploy/local/lab/monitor.env.sh || exit 1
ct105=/opt/chain-of-custody/deploy/ct105

# Layer 1: the protected bank log must exist before the monitor takes its first baseline.
mkdir -p /var/log/bank-demo
[ -f /var/log/bank-demo/app.log ] || printf 'txn 1 ok\ntxn 2 ok\n' > /var/log/bank-demo/app.log
bash "$ct105/layer1/install-wrappers.sh"

# Layer 3: approve the current witness link settings (WITNESS_URL / node id in .env, compose file hash).
python3 "$ct105/layer3/l3_config_guard.py" approve

echo "lab: starting monitor (witness $WITNESS_URL, node $WITNESS_NODE_ID)"
exec python3 "$ct105/layer1/monitor.py" run
