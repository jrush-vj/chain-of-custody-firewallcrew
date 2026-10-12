#!/bin/sh
set -eu

: "${WITNESS_NODE_ID:?Set WITNESS_NODE_ID in Railway variables}"
: "${WITNESS_NODE_PUBLIC_KEY:?Set WITNESS_NODE_PUBLIC_KEY in Railway variables}"

mkdir -p /data
cat > /data/witness_nodes.toml <<EOF
[nodes]
$WITNESS_NODE_ID = "$WITNESS_NODE_PUBLIC_KEY"
EOF

port="${PORT:-8800}"
sed -i "s/^port = .*/port = ${port}/" /app/config.toml

exec python -m witness.app \
  --config /app/config.toml \
  --host 0.0.0.0
