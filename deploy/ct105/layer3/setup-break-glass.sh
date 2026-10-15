#!/usr/bin/env bash
# Create the account that remains available during a full Layer 3 lockout.
# The generated password is displayed once; only its system password hash is retained.
set -euo pipefail

if [ "${COC_SKIP_HOST_CHECK:-0}" != 1 ] && [ "$(hostname)" != ct105-ai ]; then
  echo "WRONG HOST: $(hostname)" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "refusing: run this script as root" >&2
  exit 1
fi

user="${COC_L3_BREAK_GLASS_ACCOUNT:-coc-break-glass}"
if id "$user" >/dev/null 2>&1; then
  echo "refusing: $user already exists; do not replace credentials silently" >&2
  exit 1
fi

password="$(openssl rand -base64 48)"
useradd --create-home --shell /bin/bash --user-group \
  --comment "Layer 3 break-glass recovery account" "$user"
printf '%s:%s\n' "$user" "$password" | chpasswd

status="$(passwd -S "$user" | awk '{print $2}')"
if [ "$status" != "P" ]; then
  echo "failed to establish an active password hash for $user" >&2
  exit 1
fi

echo "Break-glass account created: $user"
echo "Password (shown once; not stored in plaintext): $password"
echo "Store it securely off-host. This account must be included in COC_KEEP_ACCOUNTS."
