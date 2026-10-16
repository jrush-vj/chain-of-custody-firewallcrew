#!/usr/bin/env bash
# One entry point for day-to-day work on the banking stack and the three-layer demo.
#
#   coc.sh status                         containers, health, witness link, layer services
#   coc.sh hotpatch backend               docker cp the backend source into banking-backend, restart,
#                                         health-check, and roll back automatically on failure
#   coc.sh hotpatch frontend              build the React bundle, docker cp it (and nginx config) into
#                                         banking-frontend, reload nginx, roll back on failure
#   coc.sh rollback backend|frontend      put back the files saved before the last hotpatch
#   coc.sh rebuild [service...]           full `docker compose up -d --build` (default: backend frontend)
#   coc.sh attack 1|2|3 [args]            run the Layer N attack demo (args go to the layer script)
#   coc.sh restore                        put Layers 1-3 back to normal (same as the website button)
#   coc.sh logs [backend|frontend|postgres|monitor|deploy]
#
# A hotpatch is for fast iteration: it does not change the image, so the next `rebuild` or automatic
# deploy replaces it with whatever is in Git. Dependency changes (package.json) always need `rebuild`.
#
# Environment overrides: REPO_DIR, APP_DIR, BACKEND_CONTAINER, FRONTEND_CONTAINER, BACKUP_DIR,
# BACKEND_HEALTH_URL, FRONTEND_URL, WITNESS_HEALTH_URL.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1   # keep "container:/path" intact when run from Git Bash on Windows

here="$(cd "$(dirname "$0")" && pwd)"
repo_dir="${REPO_DIR:-$(cd "$here/../.." && pwd)}"
app_dir="${APP_DIR:-$repo_dir/banking-system}"
backend_ctr="${BACKEND_CONTAINER:-banking-backend}"
frontend_ctr="${FRONTEND_CONTAINER:-banking-frontend}"
backup_dir="${BACKUP_DIR:-/var/tmp/coc-hotpatch}"
backend_health="${BACKEND_HEALTH_URL:-http://127.0.0.1:8081/health}"
frontend_url="${FRONTEND_URL:-http://127.0.0.1:3001/}"
witness_health="${WITNESS_HEALTH_URL:-https://witness.jrushvj.dev/health}"

if [ -t 1 ]; then
  c_ok=$'\e[32m'; c_bad=$'\e[31m'; c_warn=$'\e[33m'; c_dim=$'\e[2m'; c_off=$'\e[0m'
else
  c_ok=''; c_bad=''; c_warn=''; c_dim=''; c_off=''
fi
say()  { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { say "${c_ok}OK${c_off}   $*"; }
bad()  { say "${c_bad}FAIL${c_off} $*"; }
warn() { say "${c_warn}WARN${c_off} $*"; }
die()  { bad "$*"; exit 1; }

compose() { docker compose --project-directory "$app_dir" -f "$app_dir/docker-compose.yml" "$@"; }

running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }

wait_http() {   # wait_http <url> <seconds>
  local url="$1" deadline=$((SECONDS + $2))
  while [ "$SECONDS" -lt "$deadline" ]; do
    curl --fail --silent --max-time 3 "$url" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

sha_of() { sha256sum | cut -d' ' -f1; }

# ---------- status ----------

cmd_status() {
  for ctr in banking-postgres "$backend_ctr" "$frontend_ctr"; do
    if running "$ctr"; then
      health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no healthcheck{{end}}' "$ctr")"
      ok "$ctr running ${c_dim}($health)${c_off}"
    else
      bad "$ctr not running"
    fi
  done
  curl --fail -s --max-time 5 "$backend_health" >/dev/null && ok "backend /health" || bad "backend /health ($backend_health)"
  curl --fail -s --max-time 5 "$frontend_url" >/dev/null && ok "frontend" || bad "frontend ($frontend_url)"
  curl --fail -s --max-time 8 "$witness_health" >/dev/null && ok "witness reachable" || warn "witness not reachable ($witness_health)"
  if command -v systemctl >/dev/null 2>&1; then
    for unit in coc-layer1-monitor.service banking-deploy.timer; do
      state="$(systemctl is-active "$unit" 2>/dev/null || true)"
      [ "$state" = active ] && ok "$unit active" || warn "$unit ${state:-not installed}"
    done
  fi
  if git -C "$repo_dir" rev-parse --git-dir >/dev/null 2>&1; then
    say "checkout: $(git -C "$repo_dir" log --oneline -1) ${c_dim}($(git -C "$repo_dir" branch --show-current))${c_off}"
  fi
}

# ---------- backend hotpatch ----------

backend_files() {   # tracked backend source, minus build/dependency files
  git -C "$app_dir/backend" ls-files --cached --others --exclude-standard \
    | grep -Ev '^(node_modules/|Dockerfile$|\.dockerignore$|package(-lock)?\.json$)' \
    | grep -E '\.(js|mjs|cjs|json)$'
}

hotpatch_backend() {
  running "$backend_ctr" || die "$backend_ctr is not running; use: coc.sh rebuild backend"
  local src="$app_dir/backend" stamp files backup src_in_checker=""
  local here_pkg there_pkg
  here_pkg="$(sha_of < "$src/package.json")"
  there_pkg="$(docker exec "$backend_ctr" cat /app/package.json | sha_of)"
  [ "$here_pkg" = "$there_pkg" ] || die "package.json differs from the container; dependencies changed, use: coc.sh rebuild backend"

  mapfile -t files < <(backend_files)
  [ "${#files[@]}" -gt 0 ] || die "no backend source files found in $src"
  # Syntax-check before touching the container (inside a throwaway node container if the host has no node).
  local checker=(node --check)
  if ! command -v node >/dev/null 2>&1; then
    checker=(docker run --rm -v "$src:/src:ro" -w /src node:18-alpine node --check)
    src_in_checker=/src
  fi
  for f in "${files[@]}"; do
    [[ "$f" == *.json ]] && continue
    "${checker[@]}" "${src_in_checker:-$src}/$f" >/dev/null 2>&1 || die "syntax error in backend/$f; nothing was copied"
  done

  stamp="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup_dir"
  backup="$backup_dir/backend-$stamp.tar"
  # Save the container's current copy of every file we are about to overwrite.
  docker exec "$backend_ctr" sh -c 'cd /app && for f in "$@"; do [ -f "$f" ] && echo "$f"; done | tar -cf - -T -' sh "${files[@]}" > "$backup"
  ln -sf "$backup" "$backup_dir/backend-latest.tar"
  say "backup of ${#files[@]} files: $backup"

  tar -C "$src" -cf - "${files[@]}" | docker cp - "$backend_ctr:/app"
  ok "copied ${#files[@]} files into $backend_ctr:/app"
  docker restart "$backend_ctr" >/dev/null
  if wait_http "$backend_health" 60; then
    ok "backend healthy after hotpatch"
  else
    bad "backend unhealthy after hotpatch; rolling back"
    docker logs --tail 30 "$backend_ctr" 2>&1 | sed 's/^/    /'
    rollback_backend
    exit 1
  fi
}

rollback_backend() {
  local backup="$backup_dir/backend-latest.tar"
  [ -s "$backup" ] || die "no backend backup at $backup"
  docker cp - "$backend_ctr:/app" < "$backup"
  docker restart "$backend_ctr" >/dev/null
  wait_http "$backend_health" 60 && ok "backend restored from $(readlink -f "$backup")" \
    || die "backend still unhealthy after rollback; run: coc.sh rebuild backend"
}

# ---------- frontend hotpatch ----------

hotpatch_frontend() {
  running "$frontend_ctr" || die "$frontend_ctr is not running; use: coc.sh rebuild frontend"
  local src="$app_dir/frontend" stamp tmp build_ctr api_url
  api_url="$(grep -E '^FRONTEND_PUBLIC_API_URL=' "$app_dir/.env" 2>/dev/null | cut -d= -f2- || true)"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"; [ -n "${build_ctr:-}" ] && docker rm -f "$build_ctr" >/dev/null 2>&1 || true' RETURN

  say "building the React bundle (build stage of frontend/Dockerfile)"
  docker build --quiet --target build --build-arg "REACT_APP_API_URL=$api_url" -t coc-frontend-build "$src" >/dev/null
  build_ctr="$(docker create coc-frontend-build)"
  docker cp "$build_ctr:/app/build" "$tmp/build"
  [ -f "$tmp/build/index.html" ] || die "build produced no index.html"

  stamp="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup_dir/frontend-$stamp"
  docker cp "$frontend_ctr:/usr/share/nginx/html" "$backup_dir/frontend-$stamp/html"
  docker cp "$frontend_ctr:/etc/nginx/conf.d/default.conf" "$backup_dir/frontend-$stamp/default.conf"
  ln -sfn "$backup_dir/frontend-$stamp" "$backup_dir/frontend-latest"
  say "backup: $backup_dir/frontend-$stamp"

  docker exec "$frontend_ctr" sh -c 'rm -rf /usr/share/nginx/html/*'
  docker cp "$tmp/build/." "$frontend_ctr:/usr/share/nginx/html/"
  docker cp "$src/nginx/default.conf" "$frontend_ctr:/etc/nginx/conf.d/default.conf"
  if docker exec "$frontend_ctr" nginx -t >/dev/null 2>&1 && docker exec "$frontend_ctr" nginx -s reload \
     && wait_http "$frontend_url" 20; then
    ok "frontend hotpatched and nginx reloaded"
  else
    bad "frontend check failed; rolling back"
    rollback_frontend
    exit 1
  fi
}

rollback_frontend() {
  local backup="$backup_dir/frontend-latest"
  [ -d "$backup/html" ] || die "no frontend backup at $backup"
  docker exec "$frontend_ctr" sh -c 'rm -rf /usr/share/nginx/html/*'
  docker cp "$backup/html/." "$frontend_ctr:/usr/share/nginx/html/"
  docker cp "$backup/default.conf" "$frontend_ctr:/etc/nginx/conf.d/default.conf"
  docker exec "$frontend_ctr" nginx -s reload
  wait_http "$frontend_url" 20 && ok "frontend restored from $(readlink -f "$backup")" \
    || die "frontend still failing after rollback; run: coc.sh rebuild frontend"
}

# ---------- everything else ----------

cmd_rebuild() {
  local services=("$@")
  [ "${#services[@]}" -gt 0 ] || services=(backend frontend)
  compose config --quiet
  compose up -d --build "${services[@]}"
  wait_http "$backend_health" 90 && ok "backend healthy" || die "backend unhealthy after rebuild"
  wait_http "$frontend_url" 30 && ok "frontend up" || die "frontend down after rebuild"
}

cmd_attack() {
  local layer="${1:-}"; shift || true
  case "$layer" in
    1|2|3) exec bash "$here/layer$layer/attack-layer$layer.sh" "$@" ;;
    *) die "usage: coc.sh attack 1|2|3 [args]" ;;
  esac
}

cmd_logs() {
  case "${1:-backend}" in
    backend|frontend|postgres) compose logs -f --tail 100 "$1" ;;
    monitor) journalctl -u coc-layer1-monitor.service -f -n 100 ;;
    deploy)  journalctl -u banking-deploy.service -f -n 100 ;;
    *) die "usage: coc.sh logs [backend|frontend|postgres|monitor|deploy]" ;;
  esac
}

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; }

command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"

case "${1:-}" in
  status)   cmd_status ;;
  hotpatch)
    case "${2:-}" in
      backend)  hotpatch_backend ;;
      frontend) hotpatch_frontend ;;
      *) die "usage: coc.sh hotpatch backend|frontend" ;;
    esac ;;
  rollback)
    case "${2:-}" in
      backend)  rollback_backend ;;
      frontend) rollback_frontend ;;
      *) die "usage: coc.sh rollback backend|frontend" ;;
    esac ;;
  rebuild)  shift; cmd_rebuild "$@" ;;
  attack)   shift; cmd_attack "$@" ;;
  restore)  exec bash "$here/restore-normal.sh" ;;
  logs)     shift; cmd_logs "$@" ;;
  ""|-h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
