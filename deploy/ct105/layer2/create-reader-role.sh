#!/usr/bin/env bash
# Create the read-only database role the witness sync reads through, then prove what it can and cannot do.
# Safe to run again.
#
# coc_reader can log in only through the container's local connection (it has no password, so it cannot
# be used from the network) and is granted SELECT on exactly seven columns of `transactions`:
#   id, type, amount, status, from_account_id, to_account_id, timestamp
# It cannot read names, IBANs, account numbers or the reference text, cannot read any other table, and
# cannot write anything.
#
# Run on ct105 as root:
#   bash /opt/chain-of-custody/deploy/ct105/layer2/create-reader-role.sh
set -uo pipefail

if [ "${COC_SKIP_HOST_CHECK:-0}" != 1 ] && [ "$(hostname)" != ct105-ai ]; then
  echo "WRONG HOST: $(hostname)"; exit 1
fi

app_dir="${APP_DIR:-/opt/chain-of-custody/banking-system}"
cd "$app_dir" || { echo "missing $app_dir"; exit 1; }
set -a; . ./.env; set +a          # loads DB_USER and DB_NAME; their values are never printed
db="${DB_NAME:-bankingsystem}"

as_admin()  { docker compose exec -T postgres psql -U "$DB_USER" -d "$db" -v ON_ERROR_STOP=1 -X -q "$@"; }
as_reader() { docker compose exec -T postgres psql -U coc_reader -d "$db" -X -q -t -A "$@"; }

as_admin <<'SQL' || { echo "could not create the role"; exit 1; }
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'coc_reader') THEN
    CREATE ROLE coc_reader LOGIN;
  END IF;
END
$$;
ALTER ROLE coc_reader SET default_transaction_read_only = on;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM coc_reader;
GRANT USAGE ON SCHEMA public TO coc_reader;
GRANT SELECT (id, from_account_id, to_account_id, amount, type, status, "timestamp") ON transactions TO coc_reader;
SQL
echo "role coc_reader is in place"

echo
echo "checking what it can and cannot do:"
problems=0

if rows="$(as_reader -c "SELECT count(*) FROM transactions" 2>&1)"; then
  echo "  can read the allowed columns: $rows transaction row(s)"
else
  echo "  PROBLEM: coc_reader could not log in or read: $rows"
  echo "  (if this is an authentication error, the database does not trust local connections for this role)"
  exit 1
fi

as_reader -c 'SELECT id, type, amount::text, status, from_account_id, to_account_id, "timestamp"::text FROM transactions LIMIT 1' >/dev/null 2>&1 \
  && echo "  can run the sync's exact query" \
  || { echo "  PROBLEM: the sync's query failed"; problems=$((problems + 1)); }

for blocked in reference external_to_iban external_from_iban external_to_name external_from_name; do
  if as_reader -c "SELECT $blocked FROM transactions LIMIT 1" >/dev/null 2>&1; then
    echo "  PROBLEM: it can read $blocked"; problems=$((problems + 1))
  else
    echo "  cannot read $blocked (good)"
  fi
done

if as_reader -c "SELECT count(*) FROM accounts" >/dev/null 2>&1; then
  echo "  PROBLEM: it can read the accounts table"; problems=$((problems + 1))
else
  echo "  cannot read the accounts table (good)"
fi
if as_reader -c "SELECT count(*) FROM users" >/dev/null 2>&1; then
  echo "  PROBLEM: it can read the users table"; problems=$((problems + 1))
else
  echo "  cannot read the users table (good)"
fi
if as_reader -c "UPDATE transactions SET status = status WHERE false" >/dev/null 2>&1; then
  echo "  PROBLEM: it can write to transactions"; problems=$((problems + 1))
else
  echo "  cannot write to transactions (good)"
fi

echo
if [ "$problems" -eq 0 ]; then
  echo "RESULT: PASS - coc_reader is read-only and limited to the seven allowed columns"
else
  echo "RESULT: FAIL - $problems check(s) went wrong; do not enable the sync until this is fixed"
  exit 1
fi
