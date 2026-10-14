#!/usr/bin/env bash
# Install the Layer 1 honeypot wrappers on ct105. Run as root:
#   bash /opt/chain-of-custody/deploy/ct105/layer1/install-wrappers.sh
# Creates /usr/local/coc-trip/bin/<command> symlinks for every watched command that exists on
# this host, and puts that directory first in PATH for login shells via /etc/profile.d.
set -euo pipefail

if [ "$(id -u)" != 0 ]; then
  echo "run as root"; exit 1
fi

here="$(cd "$(dirname "$0")" && pwd)"
bin=/usr/local/coc-trip/bin
spool_dir=/var/spool/coc-layer1

install -d -m 0755 "$bin" "$spool_dir"
install -m 0755 "$here/coc-trip-wrapper.sh" /usr/local/coc-trip/wrapper.sh
touch "$spool_dir/commands.jsonl"
chmod 0640 "$spool_dir/commands.jsonl"

installed=()
for name in nano vi vim sed rm mv cp truncate shred tee; do
  if command -v "$name" >/dev/null 2>&1; then
    ln -sf /usr/local/coc-trip/wrapper.sh "$bin/$name"
    installed+=("$name")
  fi
done

cat > /etc/profile.d/coc-layer1.sh <<'EOF'
# Chain of Custody Layer 1: route watched commands through the tripwire wrappers.
export PATH="/usr/local/coc-trip/bin:$PATH"
EOF
chmod 0644 /etc/profile.d/coc-layer1.sh

echo "wrappers installed: ${installed[*]}"
echo "login shells pick them up on next login; the attack script sets PATH itself"
