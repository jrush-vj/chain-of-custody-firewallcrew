#!/usr/bin/env bash
# Demo Layer 2: two reversible changes to committed transaction history in the banking database.
# The witness reconciles its sealed copy against the bank every 10 seconds and must catch each one.
#
#   1. amount: one committed transaction's amount changes by 1.00
#   2. type:   another deposit or withdrawal has its type flipped
#
# Each change is undone by a trap, verified, and the witness must report the row clear again.
# Only transactions.amount and transactions.type on demo rows change. Account balances are never touched.
#
# Run on ct105 as root:
#   bash /opt/chain-of-custody/deploy/ct105/layer2/attack-layer2.sh
set -uo pipefail

if [ "${COC_SKIP_HOST_CHECK:-0}" != 1 ] && [ "$(hostname)" != ct105-ai ]; then
  echo "WRONG HOST: $(hostname)"; exit 1
fi

app_dir="${APP_DIR:-/opt/chain-of-custody/banking-system}"
witness_url="${WITNESS_STATUS_URL:-https://witness.jrushvj.dev/v1/status}"
poll_limit="${POLL_LIMIT_S:-240}"
pause_s="${PAUSE_S:-15}"   # time for the dashboard to show each alert before the restore

cd "$app_dir" || { echo "missing $app_dir"; exit 1; }
set -a; . ./.env; set +a          # loads DB_USER/DB_NAME; values are never printed
db="${DB_NAME:-bankingsystem}"

psql_q() { docker compose exec -T postgres psql -U "$DB_USER" -d "$db" -tA -F'|' -c "$1"; }

# Prints the witnessed transaction ids the witness currently flags as mismatched, or "ERROR".
witness_mismatches() {
  curl --fail -s --max-time 10 "$witness_url" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("ERROR"); sys.exit(0)
recon = data.get("bank_reconciliation", {})
print(",".join(sorted(str(m["transaction_id"]) for m in recon.get("mismatches", []))))
' 2>/dev/null || echo ERROR
}

# Waits until the witness reports a transaction as tampered, or as clear again.
wait_for() {
  local want="$1" id="$2" deadline=$((SECONDS + poll_limit)) seen
  while [ "$SECONDS" -lt "$deadline" ]; do
    seen="$(witness_mismatches)"
    printf '%s  witness mismatches: %s\n' "$(date +%H:%M:%S)" "${seen:-none}"
    if [ "$want" = tampered ] && [[ ",$seen," == *",$id,"* ]]; then return 0; fi
    if [ "$want" = clear ] && [ "$seen" != ERROR ] && [[ ",$seen," != *",$id,"* ]]; then return 0; fi
    sleep 5
  done
  return 1
}

# Prints "id|amount|type" for the newest confirmed deposit/withdrawal the witness is not flagging
# and that is not in the excluded list (a comma-separated id list, may be empty).
pick_row() {
  local excluded="$1" before="$2" candidate cid
  while IFS= read -r candidate; do
    cid="${candidate%%|*}"
    if [ -n "$cid" ] && [[ ",$before," != *",$cid,"* ]] && [[ ",$excluded," != *",$cid,"* ]]; then
      echo "$candidate"; return 0
    fi
  done <<< "$(psql_q "SELECT t.id, t.amount, t.type FROM transactions t JOIN witness_outbox o ON o.transaction_id = t.id WHERE o.status = 'confirmed' AND t.type IN ('deposit','withdrawal') ORDER BY t.id DESC LIMIT 40;")"
  return 1
}

RESTORE_SQL=""
RESTORE_ID=""
restore_now() {
  local back
  back="$(psql_q "$RESTORE_SQL")"
  if [ -n "$back" ]; then
    echo "$(date +%H:%M:%S) restored transaction #$RESTORE_ID"
  else
    echo "RESTORE FAILED for #$RESTORE_ID; run this by hand: $RESTORE_SQL"
  fi
}

# run_case <label> <id> <apply SQL> <restore SQL>
run_case() {
  local label="$1" id="$2" apply_sql="$3" restore_sql="$4" applied
  echo; echo "$(date +%H:%M:%S) ATTACK: $label on transaction #$id"
  applied="$(psql_q "$apply_sql")"
  if [ -z "$applied" ]; then
    echo "guard failed for #$id: the row changed under us; nothing was changed"; return 1
  fi
  RESTORE_SQL="$restore_sql"; RESTORE_ID="$id"
  trap restore_now EXIT   # from here on, any exit restores the row
  echo "$(date +%H:%M:%S) changed #$id; waiting for the witness (up to ${poll_limit}s)"
  if ! wait_for tampered "$id"; then
    echo "RESULT: FAIL $label - the witness did not report #$id"
    trap - EXIT; restore_now; return 1
  fi
  echo "RESULT: witness caught $label on #$id"
  sleep "$pause_s"
  trap - EXIT; restore_now
  if wait_for clear "$id"; then
    echo "RESULT: PASS $label - restored, witness clear"; return 0
  fi
  echo "RESULT: FAIL $label - the witness still reports #$id after the restore"; return 1
}

before="$(witness_mismatches)"
[ "$before" != ERROR ] || { echo "witness unreadable: $witness_url"; exit 1; }

failures=0

# Case 1: amount change.
row1="$(pick_row "" "$before")" || { echo "no clean witnessed transaction found"; exit 1; }
IFS='|' read -r id1 old1 type1 <<< "$row1"
new1="$(python3 -c "from decimal import Decimal; print(Decimal('$old1') + Decimal('1.00'))")"
run_case "amount $old1 -> $new1" "$id1" \
  "UPDATE transactions SET amount = $new1 WHERE id = $id1 AND amount = $old1 AND type = '$type1' RETURNING id;" \
  "UPDATE transactions SET amount = $old1 WHERE id = $id1 AND amount = $new1 RETURNING id;" \
  || failures=$((failures + 1))

# Case 2: type flip, on a different row.
row2="$(pick_row "$id1" "$before")" || { echo "no second clean transaction found"; exit 1; }
IFS='|' read -r id2 old2 type2 <<< "$row2"
if [ "$type2" = withdrawal ]; then new_type=deposit; else new_type=withdrawal; fi
run_case "type $type2 -> $new_type" "$id2" \
  "UPDATE transactions SET type = '$new_type' WHERE id = $id2 AND amount = $old2 AND type = '$type2' RETURNING id;" \
  "UPDATE transactions SET type = '$type2' WHERE id = $id2 AND type = '$new_type' RETURNING id;" \
  || failures=$((failures + 1))

echo
if [ "$failures" -eq 0 ]; then
  echo "LAYER 2 DEMO: both changes were caught and restored"
else
  echo "LAYER 2 DEMO: $failures case(s) failed; see the RESULT lines above"
  exit 1
fi
