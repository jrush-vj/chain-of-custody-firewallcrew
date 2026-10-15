#!/usr/bin/env bash
# Put back every Layer 2 demo change recorded in the journal, newest first. A row that is already at
# its original value is skipped, so this is safe to run any number of times. Account balances are
# never touched. Run on ct105 as root:
#   bash /opt/chain-of-custody/deploy/ct105/layer2/restore-layer2.sh
set -uo pipefail

if [ "${COC_SKIP_HOST_CHECK:-0}" != 1 ] && [ "$(hostname)" != ct105-ai ]; then
  echo "WRONG HOST: $(hostname)"; exit 1
fi

app_dir="${APP_DIR:-/opt/chain-of-custody/banking-system}"
journal="${COC_LAYER2_JOURNAL:-/var/lib/coc-demo/layer2-changes.tsv}"

if [ ! -s "$journal" ]; then
  echo "no Layer 2 changes recorded in $journal; nothing to restore"; exit 0
fi

cd "$app_dir" || { echo "missing $app_dir"; exit 1; }
set -a; . ./.env; set +a
db="${DB_NAME:-bankingsystem}"

psql_q() { docker compose exec -T postgres psql -U "$DB_USER" -d "$db" -tA -F'|' -c "$1"; }

failed=0
while IFS=$'\t' read -r when id field old new; do
  case "$field" in
    amount) sql="UPDATE transactions SET amount = $old WHERE id = $id AND amount = $new RETURNING id;" ;;
    type)   sql="UPDATE transactions SET type = '$old' WHERE id = $id AND type = '$new' RETURNING id;" ;;
    status) sql="UPDATE transactions SET status = '$old' WHERE id = $id AND status = '$new' RETURNING id;" ;;
    *)      echo "skipping unknown journal entry: $when $id $field"; continue ;;
  esac
  back="$(psql_q "$sql")"
  if [ -n "$back" ]; then
    echo "restored transaction #$id: $field back to $old"
  else
    echo "transaction #$id: $field already at $old (skipped)"
  fi
done < <(tac "$journal")

echo "Layer 2 restore finished; the witness clears each row on its next reconciliation (about 10 seconds)"
exit "$failed"
