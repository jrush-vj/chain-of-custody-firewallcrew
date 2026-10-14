#!/usr/bin/env bash
# Demo Layer 1: four attacks on the protected bank log. The tripwire reports each command it sees
# (auditd) and each change to the file (monitor), then the original file is restored.
#
# Attacks, in order:
#   1. sed -i        command + file change
#   2. echo >>       file change only (a shell redirect runs no watched command)
#   3. truncate -s 0 command + file change
#   4. rm            command + file removal
# The restore uses a shell redirect, so it is not reported as an attack.
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
  cat "$backup" > "$log_file"
  rm -f "$backup"
  echo "$(date +%H:%M:%S) restored $log_file from the backup taken before the attacks"
}
trap restore EXIT

step() { echo; echo "$(date +%H:%M:%S) ATTACK $1: $2"; }

step 1 "rewrite a line in place: sed -i"
sed -i 's/txn 2 ok/txn 2 ok (edited by attacker)/' "$log_file"
sleep "$pause_s"

step 2 "append a fake transaction with a shell redirect (no command runs)"
echo "txn 3 ok (injected by attacker)" >> "$log_file"
sleep "$pause_s"

step 3 "wipe the log: truncate -s 0"
truncate -s 0 "$log_file"
sleep "$pause_s"

step 4 "delete the log: rm"
rm -f "$log_file"
sleep "$pause_s"

echo
echo "$(date +%H:%M:%S) attacks done; restoring the original content"
trap - EXIT
restore
sleep "$pause_s"
echo "RESULT: four attacks sent to the witness; check the Layer 1 card"
