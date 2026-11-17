#!/usr/bin/env bash
# Red team: PROMPT INJECTION through attacker-controlled fields. Reversible; touches only the demo log.
#
# What it does: plants instruction-like text (injection-payloads.txt) in the two places an intruder can
# write that the defenders later read:
#   1. a command argument  - a file named after the payload is copied into the watched log directory and
#      removed (cp, rm are wrapped, so Layer 1 records the argument text and sends it to the witness);
#   2. a log line          - the payload is appended to the watched log (the monitor reports the change).
# The log is restored from a backup at the end.
#
# What it proves: the text lands in the witness's evidence, as a real attacker's would. The guard
# classifier reads only structured fields, so it cannot be steered by it (witness/test/guard-classify.test.js,
# G10). Aimed at an unrestricted AI responder it is the "before" half of the demo; the guarded Bob adapter
# (a later phase) is the "after".
#
# Run on ct105 / the lab as root:
#   bash deploy/ct105/guard/attack-injection.sh
set -uo pipefail

if [ "${COC_SKIP_HOST_CHECK:-0}" != 1 ] && [ "$(hostname)" != ct105-ai ]; then
  echo "WRONG HOST: $(hostname)"; exit 1
fi

here="$(cd "$(dirname "$0")" && pwd)"
payload_file="${PAYLOADS:-$here/injection-payloads.txt}"
trip_bin="${COC_TRIP_BIN:-/usr/local/coc-trip/bin}"
if [ -d "$trip_bin" ]; then
  export PATH="$trip_bin:$PATH"   # honeypot wrappers first, so the arguments are recorded
  echo "honeypot wrappers active: $trip_bin"
else
  echo "WARNING: honeypot wrappers not installed; the command-argument half will not be recorded"
fi

log_dir="${LOG_DIR:-/var/log/bank-demo}"
log_file="$log_dir/app.log"
pause_s="${PAUSE_S:-12}"
mkdir -p "$log_dir"
[ -f "$log_file" ] || printf 'txn 1 ok\ntxn 2 ok\n' > "$log_file"

backup="$(mktemp)"
cp -p "$log_file" "$backup"
planted=()
restore() {
  for f in "${planted[@]:-}"; do [ -n "$f" ] && rm -f -- "$f"; done
  cat "$backup" > "$log_file"
  rm -f "$backup"
  echo "restored $log_file and removed planted files"
}
trap restore EXIT

mapfile -t payloads < <(grep -v -E '^\s*(#|$)' "$payload_file")
echo "${#payloads[@]} injection payloads from $payload_file"

n=0
for payload in "${payloads[@]}"; do
  n=$((n + 1))
  echo; echo "INJECTION $n: ${payload:0:60}"
  target="$log_dir/${payload//\//_}.bak"
  planted+=("$target")
  echo "  1. command argument: cp ... into a file named after the payload"
  cp -p "$log_file" "$target"
  rm -f -- "$target"
  echo "  2. log line: payload appended to the watched log"
  echo "$payload" >> "$log_file"
  sleep "$pause_s"
done

echo
echo "done; restoring the original log"
trap - EXIT
restore
sleep "$pause_s"
