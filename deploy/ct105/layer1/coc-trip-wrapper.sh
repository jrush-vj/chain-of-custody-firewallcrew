#!/usr/bin/env bash
# Layer 1 honeypot wrapper. Installed as /usr/local/coc-trip/bin/<command>, a symlink to this file.
# When the command's arguments touch the watched bank log path, it appends one JSON line to the
# spool for the monitor, then runs the real command unchanged. Detection only: it never blocks.
name="$(basename "$0")"
watch="${WATCH_DIR:-/var/log/bank-demo}"
spool="${COC_SPOOL:-/var/spool/coc-layer1/commands.jsonl}"
real="$(PATH="${COC_REAL_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}" command -v "$name")"
if [ -z "$real" ]; then
  echo "$name: real command not found" >&2
  exit 127
fi

touches=0
for arg in "$@"; do
  case "$arg" in "$watch"*) touches=1 ;; esac
done

if [ "$touches" = 1 ]; then
  who="${SUDO_USER:-$(logname 2>/dev/null || id -un)}"
  COC_W_NAME="$name" COC_W_ARGS="$*" COC_W_WHO="$who" COC_W_CWD="$PWD" \
  COC_W_TTY="$(tty 2>/dev/null || true)" COC_W_SPOOL="$spool" "${COC_PYTHON:-python3}" -c '
import json, os, time
line = {
    "ts": time.time(),
    "command": os.environ["COC_W_NAME"],
    "args": os.environ["COC_W_ARGS"],
    "user": os.environ["COC_W_WHO"],
    "cwd": os.environ["COC_W_CWD"],
    "tty": os.environ["COC_W_TTY"],
}
with open(os.environ["COC_W_SPOOL"], "a", encoding="utf-8") as handle:
    handle.write(json.dumps(line) + "\n")
' 2>/dev/null || echo "coc-trip: could not record $name" >&2
fi

exec "$real" "$@"
