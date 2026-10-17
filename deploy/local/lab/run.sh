#!/usr/bin/env bash
# Run a command inside coc-lab with the lab environment loaded, e.g.
#   docker exec coc-lab bash /opt/chain-of-custody/deploy/local/lab/run.sh bash deploy/ct105/coc.sh attack 2
. /opt/chain-of-custody/deploy/local/lab/monitor.env.sh || exit 1
cd /opt/chain-of-custody
exec "$@"
