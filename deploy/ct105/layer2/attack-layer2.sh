#!/usr/bin/env bash
# Demo Layer 2: three reversible changes to committed transaction history in the banking database.
# The witness must catch each one.
#
#   1. amount: one committed transaction's amount changes by 1.00          (the four-field check, ~10 s)
#   2. type:   a deposit or withdrawal has its type flipped                  (the four-field check, ~10 s)
#   3. status: a completed transaction is marked failed                     (only the record copies can see
#              this; needs the record sync, so it is caught at the next 30 s heartbeat)
#      Rows are reused when only one witnessed row exists.
#
# Each change is written to the journal first, then undone by a trap, verified, and the witness must
# report the row clear again. Only transactions.amount and transactions.type on demo rows change.
# Account balances are never touched.
#
# Run on ct105 as root:
#   bash /opt/chain-of-custody/deploy/ct105/layer2/attack-layer2.sh
set -uo pipefail

ist() { date -u -d '5 hours 30 minutes' +%H:%M:%S; }   # Indian Standard Time, whatever the server's time zone is

if [ "${COC_SKIP_HOST_CHECK:-0}" != 1 ] && [ "$(hostname)" != ct105-ai ]; then
  echo "WRONG HOST: $(hostname)"; exit 1
fi

app_dir="${APP_DIR:-/opt/chain-of-custody/banking-system}"
witness_url="${WITNESS_MISMATCHES_URL:-https://witness.jrushvj.dev/mismatches}"   # the combined findings list
journal="${COC_LAYER2_JOURNAL:-/var/lib/coc-demo/layer2-changes.tsv}"
poll_limit="${POLL_LIMIT_S:-240}"
pause_s="${PAUSE_S:-15}"   # time for the dashboard to show each alert before the restore

cd "$app_dir" || { echo "missing $app_dir"; exit 1; }
set -a; . ./.env; set +a          # loads DB_USER/DB_NAME; values are never printed
db="${DB_NAME:-bankingsystem}"
mkdir -p "$(dirname "$journal")"

psql_q() { docker compose exec -T postgres psql -U "$DB_USER" -d "$db" -tA -F'|' -c "$1"; }

# Prints the transaction ids the witness currently flags (from either check), or "ERROR".
witness_mismatches() {
  curl --fail -s --max-time 10 "$witness_url" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("ERROR"); sys.exit(0)
print(",".join(sorted(str(m["seq"]) for m in data.get("mismatches", []))))
' 2>/dev/null || echo ERROR
}

# Waits until the witness reports a transaction as tampered, or as clear again.
wait_for() {
  local want="$1" id="$2" deadline=$((SECONDS + poll_limit)) seen
  while [ "$SECONDS" -lt "$deadline" ]; do
    seen="$(witness_mismatches)"
    printf '%s  witness mismatches: %s\n' "$(ist)" "${seen:-none}"
    if [ "$want" = tampered ] && [[ ",$seen," == *",$id,"* ]]; then return 0; fi
    if [ "$want" = clear ] && [ "$seen" != ERROR ] && [[ ",$seen," != *",$id,"* ]]; then return 0; fi
    sleep 5
  done
  return 1
}

# Prints "id|amount|type" for the newest confirmed deposit/withdrawal that the witness is not flagging
# and that is not in the excluded list (comma-separated ids, may be empty).
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
    echo "$(ist) restored transaction #$RESTORE_ID"
  else
    echo "RESTORE FAILED for #$RESTORE_ID; run scripts/restore-layer2.sh or this by hand: $RESTORE_SQL"
  fi
}

# run_case <label> <id> <field> <old> <new> <apply SQL> <restore SQL>
run_case() {
  local label="$1" id="$2" field="$3" old="$4" new="$5" apply_sql="$6" restore_sql="$7" applied
  echo; echo "$(ist) ATTACK: $label on transaction #$id"
  printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$id" "$field" "$old" "$new" >> "$journal"
  applied="$(psql_q "$apply_sql")"
  if [ -z "$applied" ]; then
    echo "guard failed for #$id: the row changed under us; nothing was changed"; return 1
  fi
  RESTORE_SQL="$restore_sql"; RESTORE_ID="$id"
  trap restore_now EXIT   # from here on, any exit restores the row
  echo "$(ist) changed #$id; waiting for the witness (up to ${poll_limit}s)"
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
run_case "amount $old1 -> $new1" "$id1" amount "$old1" "$new1" \
  "UPDATE transactions SET amount = $new1 WHERE id = $id1 AND amount = $old1 AND type = '$type1' RETURNING id;" \
  "UPDATE transactions SET amount = $old1 WHERE id = $id1 AND amount = $new1 RETURNING id;" \
  || failures=$((failures + 1))

# Case 2: type flip. Another clean row if one exists, otherwise the same row (restored by case 1).
if row2="$(pick_row "$id1" "$before")"; then
  IFS='|' read -r id2 old2 type2 <<< "$row2"
else
  row2="$(psql_q "SELECT id, amount, type FROM transactions WHERE id = $id1;")"
  IFS='|' read -r id2 old2 type2 <<< "$row2"
  echo "only one witnessed row exists; reusing #$id2 for the type change"
fi
if [ "$type2" = withdrawal ]; then new_type=deposit; else new_type=withdrawal; fi
run_case "type $type2 -> $new_type" "$id2" type "$type2" "$new_type" \
  "UPDATE transactions SET type = '$new_type' WHERE id = $id2 AND amount = $old2 AND type = '$type2' RETURNING id;" \
  "UPDATE transactions SET type = '$type2' WHERE id = $id2 AND type = '$new_type' RETURNING id;" \
  || failures=$((failures + 1))

# Case 3: status change. The four-field check never sees this column; the witness's own copy of the row does.
row3="$(psql_q "SELECT id, amount, type FROM transactions WHERE id = $id2;")"
IFS='|' read -r id3 old3 type3 <<< "$row3"
status3="$(psql_q "SELECT status FROM transactions WHERE id = $id3;")"
if [ "$status3" = completed ]; then
  run_case "status completed -> failed (only the record copies can see this)" "$id3" status completed failed     "UPDATE transactions SET status = 'failed' WHERE id = $id3 AND status = 'completed' RETURNING id;"     "UPDATE transactions SET status = 'completed' WHERE id = $id3 AND status = 'failed' RETURNING id;"     || failures=$((failures + 1))
else
  echo "skipping the status case: transaction #$id3 has status '$status3', not 'completed'"
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "LAYER 2 DEMO: all changes were caught and restored"
else
  echo "LAYER 2 DEMO: $failures case(s) failed; see the RESULT lines above"
  exit 1
fi
