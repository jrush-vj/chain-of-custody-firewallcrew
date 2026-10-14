#!/usr/bin/env bash
# Demo Layer 1: three attacks on the protected bank log, each caught by the monitor and shown
# on the witness. The original file is restored on any exit path, and the monitor then reports
# the restore as "back to the approved content".
#
# Run on ct105 as root:
#   bash /opt/chain-of-custody/deploy/ct105/layer1/attack-layer1.sh
set -uo pipefail

if [ "${COC_SKIP_HOST_CHECK:-0}" != 1 ] && [ "$(hostname)" != ct105-ai ]; then
  echo "WRONG HOST: $(hostname)"; exit 1
fi

log_dir="${LOG_DIR:-/var/log/bank-demo}"
log_file="$log_dir/app.log"
pause_s="${PAUSE_S:-12}"   # longer than the monitor's poll, so each attack is visible on its own

mkdir -p "$log_dir"
if [ ! -f "$log_file" ]; then
  printf 'txn 1 ok\ntxn 2 ok\n' > "$log_file"
fi

backup="$(mktemp)"
cp -p "$log_file" "$backup"
restore() {
  cp -p "$backup" "$log_file"
  rm -f "$backup"
  echo "$(date +%H:%M:%S) restored $log_file from the backup taken before the attacks"
}
trap restore EXIT

step() { echo; echo "$(date +%H:%M:%S) ATTACK $1: $2"; }

step 1 "rewrite a line in place (sed -i)"
sed -i 's/txn 2 ok/txn 2 ok (edited by attacker)/' "$log_file"
sleep "$pause_s"

step 2 "append a fake transaction line"
echo "txn 3 ok (injected by attacker)" >> "$log_file"
sleep "$pause_s"

step 3 "delete the log file (rm)"
rm -f "$log_file"
sleep "$pause_s"

echo
echo "$(date +%H:%M:%S) attacks done; restoring the original content"
trap - EXIT
restore
sleep "$pause_s"
echo "RESULT: three changes were sent to the witness; check the Layer 1 card"
