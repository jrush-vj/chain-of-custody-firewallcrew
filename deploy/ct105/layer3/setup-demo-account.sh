#!/usr/bin/env bash
# Create the Layer 3 demo account: coc-demo-intruder. This is the ONLY account the real lockout script
# is ever allowed to touch (l3_lockout.py checks this independently, three ways, every time it runs).
# It has no sudo, no group memberships beyond its own, and is not in the forbidden-name list.
#
# Run once on ct105 as root:
#   bash /opt/chain-of-custody/deploy/ct105/layer3/setup-demo-account.sh
#
# To demo "pushing someone out": open a second terminal on ct105 and run `su - coc-demo-intruder`
# (password printed below) to simulate an admin/hacker session, then trigger the lockout from the
# first terminal. No SSH or network config is touched to make this possible.
set -uo pipefail

if [ "${COC_SKIP_HOST_CHECK:-0}" != 1 ] && [ "$(hostname)" != ct105-ai ]; then
  echo "WRONG HOST: $(hostname)"; exit 1
fi

user="${COC_DEMO_USER:-coc-demo-intruder}"

if [ "$user" = root ] || [ "$user" = "$(whoami)" ]; then
  echo "refusing: $user is not a safe demo account name"; exit 1
fi

if id "$user" >/dev/null 2>&1; then
  echo "$user already exists"
else
  useradd -m -s /bin/bash -c "Layer 3 demo account (not a real admin, no sudo)" "$user"
  echo "created $user"
fi

# A fixed, printed, demo-only password. Not used for anything except this local demo session.
password="coc-demo-$(id -u "$user")"
echo "${user}:${password}" | chpasswd
echo "password set to: $password"

uid="$(id -u "$user")"
if [ "$uid" -lt 1000 ]; then
  echo "PROBLEM: $user has uid $uid, expected >= 1000; the lockout script will refuse to act on it"
  exit 1
fi

if groups "$user" | grep -qE '\b(sudo|wheel|admin|root)\b'; then
  echo "PROBLEM: $user is in an admin group; removing it is required before this is safe to use"
  exit 1
fi

echo
echo "RESULT: $user is set up (uid $uid, no sudo)."
echo "Demo: open a second terminal on ct105 and run:  su - $user"
echo "Then trigger a lockout from the first terminal:"
echo "  python3 $(cd "$(dirname "$0")" && pwd)/l3_lockout.py lock \"manual demo\""
