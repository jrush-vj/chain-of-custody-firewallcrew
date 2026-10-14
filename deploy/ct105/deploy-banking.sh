#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="/opt/chain-of-custody"
APP_DIR="${REPO_DIR}/banking-system"
STATE_DIR="/var/lib/banking-deploy"
STATE_FILE="${STATE_DIR}/last-successful-commit"
BRANCH="main"

log() {
  printf '%s %s\n' "$(date --utc +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

[[ -d "${REPO_DIR}/.git" ]] || fail "Repository is not cloned at ${REPO_DIR}"
[[ -f "${APP_DIR}/docker-compose.yml" ]] || fail "Banking Compose file is missing"
[[ -f "${APP_DIR}/.env" ]] || fail "Create ${APP_DIR}/.env from .env.example and set strong secrets"

branch="$(git -C "$REPO_DIR" branch --show-current)"
[[ "$branch" == "$BRANCH" ]] || fail "Expected checked-out branch ${BRANCH}, found ${branch:-detached HEAD}"

if [[ -n "$(git -C "$REPO_DIR" status --porcelain --untracked-files=normal)" ]]; then
  fail "Repository has local changes; refusing unattended deployment"
fi

git -C "$REPO_DIR" fetch --quiet origin "$BRANCH"
target_commit="$(git -C "$REPO_DIR" rev-parse "origin/${BRANCH}")"
current_commit="$(git -C "$REPO_DIR" rev-parse HEAD)"

if [[ "$current_commit" != "$target_commit" ]]; then
  git -C "$REPO_DIR" merge-base --is-ancestor HEAD "origin/${BRANCH}" \
    || fail "Remote history is not a fast-forward; refusing to rewrite the server checkout"
  git -C "$REPO_DIR" merge --ff-only "origin/${BRANCH}"
fi

last_success=""
if [[ -f "$STATE_FILE" ]]; then
  last_success="$(cat "$STATE_FILE")"
fi

if [[ "$last_success" == "$target_commit" ]]; then
  log "Already deployed ${target_commit}"
  exit 0
fi

if [[ -n "$last_success" ]] && git -C "$REPO_DIR" cat-file -e "${last_success}^{commit}" 2>/dev/null; then
  git -C "$REPO_DIR" merge-base --is-ancestor "$last_success" "$target_commit" \
    || fail "Deployment history changed; manual review is required"
  if git -C "$REPO_DIR" diff --quiet "$last_success" "$target_commit" -- banking-system; then
    install -d -m 0750 "$STATE_DIR"
    printf '%s\n' "$target_commit" > "${STATE_FILE}.tmp"
    mv "${STATE_FILE}.tmp" "$STATE_FILE"
    log "No banking-system changes in ${target_commit}; app was not rebuilt"
    exit 0
  fi
fi

docker compose --project-directory "$APP_DIR" -f "${APP_DIR}/docker-compose.yml" config --quiet
docker compose --project-directory "$APP_DIR" -f "${APP_DIR}/docker-compose.yml" \
  up -d --build --remove-orphans postgres backend frontend

curl --fail --silent --show-error --retry 30 --retry-connrefused --retry-delay 2 \
  http://127.0.0.1:8081/health >/dev/null \
  || fail "Backend health check failed"
curl --fail --silent --show-error --retry 30 --retry-connrefused --retry-delay 2 \
  http://127.0.0.1:3001/ >/dev/null \
  || fail "Frontend health check failed"

install -d -m 0750 "$STATE_DIR"
printf '%s\n' "$target_commit" > "${STATE_FILE}.tmp"
mv "${STATE_FILE}.tmp" "$STATE_FILE"
log "Deployed banking-system commit ${target_commit}"
