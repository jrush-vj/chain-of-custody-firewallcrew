#!/usr/bin/env bash
# Write unlock keys to a root-only file and print only their SHA-256 hashes.
# Run as root: generate-unlock-keys.sh /root/coc-layer3-keys.txt
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo "usage: generate-unlock-keys.sh ROOT_ONLY_OUTPUT_FILE" >&2
  exit 2
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "refusing: run this script as root so the key file is root-only" >&2
  exit 1
fi
here="$(cd "$(dirname "$0")" && pwd)"
python3 "$here/l3_lockout.py" keys "$1"
chmod 0600 "$1"
echo "Unlock keys written to $1 (mode 0600). Keep a protected copy outside ct105."
