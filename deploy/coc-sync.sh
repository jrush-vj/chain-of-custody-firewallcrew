#!/usr/bin/env bash
# Sync a host checkout to origin/main, then apply that host's role.
#
#   bash deploy/coc-sync.sh <repo-dir> witness   # Oracle VPS: install witness files and restart
#   bash deploy/coc-sync.sh <repo-dir> check     # ct105: pull only, then report banking health
#
# Run as the owner of <repo-dir> (ubuntu on Oracle, root on ct105). sudo is used only for
# installing files and restarting services. The script refuses to run unless the checkout
# is on main and clean, so it never overwrites local work.
set -euo pipefail

repo="${1:?usage: coc-sync.sh <repo-dir> witness|check}"
role="${2:?usage: coc-sync.sh <repo-dir> witness|check}"
witness_dir="${WITNESS_DIR:-/opt/banking-witness}"
witness_files=(server.js auditor.html store.js reconcile.js package.json)

case "$role" in
  witness|check) ;;
  *) echo "unknown role: $role (use witness or check)" >&2; exit 2 ;;
esac

git_in() { git -c "safe.directory=$repo" -C "$repo" "$@"; }

branch="$(git_in branch --show-current)"
if [ "$branch" != main ]; then
  echo "refusing: checkout is on '$branch', not main" >&2
  exit 1
fi
# Untracked files are ignored here on purpose: a fast-forward pull refuses to overwrite them,
# and host-only config such as ct105 defense/config.toml must stay untracked.
if [ -n "$(git_in status --porcelain --untracked-files=no)" ]; then
  echo "refusing: tracked files have local changes (review, do not force):" >&2
  git_in status --short --untracked-files=no >&2
  exit 1
fi

git_in fetch --quiet origin main
git_in pull --ff-only --quiet origin main
echo "checkout: $(git_in log --oneline -1)"

if [ "$role" = witness ]; then
  for f in "${witness_files[@]}"; do
    sudo install -m 0644 "$repo/witness/$f" "$witness_dir/$f"
  done
  sudo systemctl restart banking-witness.service
  sleep 3
  curl --fail -s http://127.0.0.1:8787/health >/dev/null && echo HEALTH_OK
  curl --fail -s http://127.0.0.1:8787/status >/dev/null && echo STATUS_OK
  curl --fail -s https://witness.jrushvj.dev/ | grep -F 'Witness · Auditor' >/dev/null && echo DASHBOARD_OK
  sudo systemctl is-active banking-witness.service
else
  curl --fail -s http://127.0.0.1:8081/health >/dev/null && echo BACKEND_OK
  curl --fail -s http://127.0.0.1:3001/ >/dev/null && echo FRONTEND_OK
  curl --fail -s https://witness.jrushvj.dev/health >/dev/null && echo WITNESS_REACHABLE
fi
