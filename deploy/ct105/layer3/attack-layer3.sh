#!/usr/bin/env bash
# Demo Layer 3: break the link between the bank and the witness and watch Layer 3 respond.
# Layer 3 is a DRY RUN: it records the configured quarantine response and
# executes none of it. The settings are restored for real by the website's "Restore to normal" button.
#
#   config (default)  Changes WITNESS_URL in banking-system/.env to an address that cannot be reached and
#                     recreates the backend, so the bank really cannot send to the witness. While it is
#                     broken, bank transactions fail (the backend rolls them back when the witness is
#                     unreachable). Only that one .env line is changed; a backup is kept in a root-only
#                     folder, and nothing is printed from .env besides the witness address.
#                       HOLD=button   leave it broken until someone clicks "Restore to normal"
#                                     (gives up and restores by itself after 15 minutes)
#                       HOLD_S=120    otherwise restore automatically after this many seconds
#   cut               Simulates a network cut for CUT_S seconds (default 100) with a flag file that makes
#                     ct105's monitor treat the witness as unreachable. Nothing else changes. The witness
#                     raises a Layer 2 silence alert after 90 s and presumes a Layer 3 quarantine after 45 s.
#
# Run on ct105 as root:
#   bash /opt/chain-of-custody/deploy/ct105/layer3/attack-layer3.sh [config|cut]
set -uo pipefail

ist() { date -u -d '5 hours 30 minutes' +%H:%M:%S; }   # Indian Standard Time, whatever the server's time zone is

if [ "${COC_SKIP_HOST_CHECK:-0}" != 1 ] && [ "$(hostname)" != ct105-ai ]; then
  echo "WRONG HOST: $(hostname)"; exit 1
fi

mode="${1:-config}"
here="$(cd "$(dirname "$0")" && pwd)"
app_dir="${APP_DIR:-/opt/chain-of-custody/banking-system}"
status_url="${WITNESS_STATUS_URL:-https://witness.jrushvj.dev/status}"
state_dir="${COC_L3_STATE:-/var/lib/coc-layer3}"
cut_flag="${COC_WITNESS_CUT_FLAG:-/var/lib/coc-demo/witness-cut}"
hold_s="${HOLD_S:-120}"
cut_s="${CUT_S:-100}"

# Prints "<active|inactive> <confirmed|unconfirmed>" from the witness, or "unreadable".
quarantine_state() {
  curl --fail -s --max-time 10 "$status_url" | python3 -c '
import json, sys
q = json.load(sys.stdin)["quarantine"]
print("active" if q["active"] else "inactive", "confirmed" if q["confirmed"] else "unconfirmed")
' 2>/dev/null || echo unreadable
}

# Waits until the witness shows the wanted quarantine state ("confirmed" or "presumed"), printing as it goes.
wait_for_quarantine() {
  local want="$1" limit="$2" deadline=$((SECONDS + limit)) seen
  while [ "$SECONDS" -lt "$deadline" ]; do
    seen="$(quarantine_state)"
    printf '%s  witness quarantine: %s\n' "$(ist)" "$seen"
    if [ "$want" = confirmed ] && [ "$seen" = "active confirmed" ]; then return 0; fi
    if [ "$want" = any ] && [[ "$seen" == active* ]]; then return 0; fi
    sleep 5
  done
  return 1
}

case "$mode" in
  config)
    env_file="$app_dir/.env"
    python3 "$here/l3_config_guard.py" status >/dev/null 2>&1
    case $? in
      2) echo "no approved settings yet. Run once: python3 $here/l3_config_guard.py approve"; exit 1 ;;
      1) echo "the witness link settings already differ from the approved ones; run restore-normal.sh first"; exit 1 ;;
    esac
    [ -f "$env_file" ] || { echo "missing $env_file"; exit 1; }

    mkdir -p "$state_dir"; chmod 700 "$state_dir"
    cp -p "$env_file" "$state_dir/env.before-attack"; chmod 600 "$state_dir/env.before-attack"

    restore_all() {
      echo; echo "$(ist) restoring the approved witness link settings"
      bash "$here/restore-config.sh"
    }
    trap restore_all EXIT

    echo "$(ist) ATTACK: change WITNESS_URL in $env_file and recreate the backend"
    sed -i 's|^WITNESS_URL=.*|WITNESS_URL=https://witness-unreachable.invalid|' "$env_file"
    ( cd "$app_dir" && docker compose up -d --no-deps backend ) || { echo "could not recreate the backend"; exit 1; }
    echo "$(ist) the bank can no longer reach the witness; waiting for Layer 3 (up to 90 s)"

    if wait_for_quarantine confirmed 90; then
      echo "RESULT: Layer 3 reported the compromise and recorded its dry-run response"
    else
      echo "RESULT: FAIL - the witness did not show a confirmed quarantine within 90 s"
      exit 1
    fi

    if [ "${HOLD:-}" = button ]; then
      echo "$(ist) holding: click 'Restore to normal' on the website (giving up in 15 minutes)"
      deadline=$((SECONDS + 900))
      while [ "$SECONDS" -lt "$deadline" ]; do
        python3 "$here/l3_config_guard.py" status >/dev/null 2>&1 && break
        sleep 5
      done
    else
      echo "$(ist) holding for ${hold_s}s so the page can be shown"
      sleep "$hold_s"
    fi

    trap - EXIT
    restore_all
    echo
    if python3 "$here/l3_config_guard.py" status >/dev/null 2>&1; then
      echo "RESULT: PASS - settings restored and the backend reconnected."
      echo "The witness still shows the quarantine until two key holders approve, or 'Restore to normal' is clicked."
    else
      echo "RESULT: FAIL - the settings still differ from the approved ones"; exit 1
    fi
    ;;

  cut)
    mkdir -p "$(dirname "$cut_flag")"
    trap 'rm -f "$cut_flag"' EXIT
    echo "$(ist) ATTACK: simulate a network cut for ${cut_s}s (flag file $cut_flag)"
    : > "$cut_flag"
    deadline=$((SECONDS + cut_s))
    while [ "$SECONDS" -lt "$deadline" ]; do
      printf '%s  witness quarantine: %s\n' "$(ist)" "$(quarantine_state)"
      sleep 10
    done
    rm -f "$cut_flag"; trap - EXIT
    echo "$(ist) link back; the monitor reports what it recorded while cut off"
    if wait_for_quarantine confirmed 60; then
      echo "RESULT: PASS - the server confirmed its dry-run quarantine after reconnecting."
      echo "The witness still shows it until two key holders approve, or 'Restore to normal' is clicked."
    else
      echo "RESULT: FAIL - no confirmed quarantine after reconnecting"; exit 1
    fi
    ;;

  *)
    echo "usage: attack-layer3.sh [config|cut]"; exit 2
    ;;
esac
