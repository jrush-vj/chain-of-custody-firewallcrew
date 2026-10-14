#!/usr/bin/env bash
# Demo case 3: tamper with one committed transaction's amount history on ct105 and watch the
# public witness catch it. Reversible: the original amount is restored by a trap even if the
# run is interrupted. Changes only transactions.amount for one demo row; account balances are
# never touched. Prints every witness poll so the result can be followed live.
#
# Run on ct105 as root from anywhere:
#   bash /opt/chain-of-custody/deploy/ct105/demo-tamper.sh
set -uo pipefail

[ "$(hostname)" = ct105-ai ] || { echo "WRONG HOST: $(hostname)"; exit 1; }

app_dir=/opt/chain-of-custody/banking-system
witness_url="${WITNESS_STATUS_URL:-https://witness.jrushvj.dev/v1/status}"
poll_limit="${POLL_LIMIT_S:-240}"
tamper_delta="1.00"

cd "$app_dir" || { echo "missing $app_dir"; exit 1; }
set -a; . ./.env; set +a          # loads DB_USER/DB_NAME; values are never printed
db="${DB_NAME:-bankingsystem}"

psql_q() { docker compose exec -T postgres psql -U "$DB_USER" -d "$db" -tA -F'|' -c "$1"; }

# Prints "<mismatch-ids>" from the witness, or "ERROR" if the witness can't be read.
witness_mismatches() {
  curl --fail -s --max-time 10 "$witness_url" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("ERROR"); sys.exit(0)
recon = data.get("bank_reconciliation", {})
ids = sorted(str(m["transaction_id"]) for m in recon.get("mismatches", []))
print(",".join(ids))
' 2>/dev/null || echo ERROR
}

# Waits until the witness reports the wanted state for one transaction ("tampered" or "clear").
wait_for() {
  local want="$1" id="$2" deadline=$((SECONDS + poll_limit)) seen
  while [ "$SECONDS" -lt "$deadline" ]; do
    seen="$(witness_mismatches)"
    printf '%s  witness mismatches: %s\n' "$(date +%H:%M:%S)" "${seen:-none}"
    if [ "$want" = tampered ] && [[ ",$seen," == *",$id,"* ]]; then return 0; fi
    if [ "$want" = clear ] && [ "$seen" != ERROR ] && [[ ",$seen," != *",$id,"* ]]; then return 0; fi
    sleep 10
  done
  return 1
}

# 1. Pick one committed row that the witness already has, and make sure the witness is clean first.
row="$(psql_q "SELECT t.id, t.amount, t.type FROM transactions t JOIN witness_outbox o ON o.transaction_id = t.id WHERE o.status = 'confirmed' ORDER BY t.id DESC LIMIT 1;")"
[ -n "$row" ] || { echo "no confirmed witnessed transaction found"; exit 1; }
IFS='|' read -r id old_amount txn_type <<< "$row"
new_amount="$(python3 -c "from decimal import Decimal; print(Decimal('$old_amount') + Decimal('$tamper_delta'))")"
echo "demo row: transaction #$id ($txn_type), amount $old_amount -> tampered to $new_amount"

before="$(witness_mismatches)"
[ "$before" != ERROR ] || { echo "witness unreadable: $witness_url"; exit 1; }
if [[ ",$before," == *",$id,"* ]]; then echo "transaction #$id already mismatched; refusing"; exit 1; fi

# 2. Restore function: only ever runs after a successful tamper, and verifies the restore.
restore() {
  local back
  back="$(psql_q "UPDATE transactions SET amount = $old_amount WHERE id = $id AND amount = $new_amount RETURNING id;")"
  if [ -n "$back" ]; then echo "restored #$id to $old_amount"; else echo "RESTORE FAILED for #$id; set amount back to $old_amount by hand"; fi
}

# 3. Tamper, guarded: only if the row still has the expected old amount and type.
changed="$(psql_q "UPDATE transactions SET amount = $new_amount WHERE id = $id AND amount = $old_amount AND type = '$txn_type' RETURNING id;")"
[ -n "$changed" ] || { echo "guard failed: row changed under us; not tampering"; exit 1; }
trap restore EXIT   # from here on, any exit restores the row
echo "tampered #$id at $(date +%H:%M:%S); waiting for the witness (up to ${poll_limit}s)"

# 4. The witness must catch it.
if ! wait_for tampered "$id"; then echo "RESULT: FAIL - witness did not report #$id within ${poll_limit}s"; exit 1; fi
echo "RESULT: witness caught #$id"
sleep 15   # let the dashboard show the alert before restoring

# 5. Restore, then the witness must clear.
trap - EXIT
restore
if wait_for clear "$id"; then echo "RESULT: PASS - tamper caught, restored, witness clear"; exit 0; fi
echo "RESULT: FAIL - witness still reports #$id after restore"; exit 1
