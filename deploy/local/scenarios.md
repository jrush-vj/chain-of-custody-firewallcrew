# Local Attack & Tamper Detection Scenarios

**Setup:** `bash deploy/local/test-stack.sh up`, make 2-3 transactions in the UI at http://127.0.0.1:3001, wait ~40 s.

**Watch:** witness dashboard http://127.0.0.1:8787 (auditor view) and `curl 127.0.0.1:8787/status | jq`.

**Variables:**
```bash
W=http://127.0.0.1:8787
PSQL="docker exec -i banking-postgres psql -U bank_local -d bankingsystem -tA -c"
```

## A. No Lab Needed (Witness + Bank Only)

### S1. Amount Tamper (→ caught by reconciliation in ~30-40 s)
Pick a confirmed transaction ID from:
```bash
$PSQL "SELECT id FROM transactions JOIN witness_outbox o ON o.transaction_id=id WHERE o.status='confirmed' LIMIT 1"
```
Then:
```bash
$PSQL "UPDATE transactions SET amount=amount+1 WHERE id=1"
watch -n5 "curl -s $W/mismatches | jq '.mismatches[] | {id:.seq, issue}'
```
Expect: `/mismatches` shows `changed_amount`, `/status` check B goes red. Restore: `UPDATE transactions SET amount=amount-1 WHERE id=1`. The mismatch clears on the next check (~30 s).

### S2. Ledger File Tamper (→ check A red, 503 health)
```bash
docker exec banking-witness cp /data/ledger.jsonl /data/ledger.bak
docker exec banking-witness sh -c "sed -i '0,/\"amount_minor\":[0-9]*/s//\"amount_minor\":99999/' /data/ledger.jsonl"
bash deploy/local/test-stack.sh witness-restart   # restarts the witness, then reattaches the backend
curl -s -o /dev/null -w '%{http_code}\n' $W/health   # 503
curl -s $W/alerts | jq '.[] | {kind, tamper_type}'   # chain_break
```
Restore: `docker exec banking-witness cp /data/ledger.bak /data/ledger.jsonl && bash deploy/local/test-stack.sh witness-restart`.

### S3. Forged/Replayed HMAC Requests
```bash
# Get the secret from .env
SEC=$(grep WITNESS_HMAC_SECRET banking-system/.env | cut -d= -f2)
sign(){ node -e "const c=require('crypto');const [m,p,t,b]=process.argv.slice(1);console.log(c.createHmac('sha256','$SEC').update(m+'\n'+p+'\n'+t+'\n'+b).digest('hex'))" "$@"; }

# Good heartbeat: 200
T=$(date +%s%3N); B='{"seq":'$T',"interval_s":30}'; SIG=$(sign POST /v1/heartbeat $T "$B")
curl -s -XPOST $W/v1/heartbeat -H "x-witness-node: ct105-ai" -H "x-witness-timestamp: $T" -H "x-witness-signature: $SIG" -d "$B" | jq .status

# Replayed (same seq): 409
curl -s -XPOST $W/v1/heartbeat -H "x-witness-node: ct105-ai" -H "x-witness-timestamp: $T" -H "x-witness-signature: $SIG" -d "$B" | jq .status

# Bad signature: 401
curl -s -XPOST $W/v1/heartbeat -H "x-witness-signature: 0000000000000000000000000000000000000000000000000000000000000000" -d "$B" | jq .error
```

### S4. Reconcile Auth (unsigned → 401)
```bash
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8081/api/transactions/witness-reconcile?transaction_ids=1"
# 401 (auth=required locally)
```

### S5. Heartbeat Silence (~90 s → Layer 2 alert)
Stop sending heartbeats for 90+ seconds (`docker stop coc-lab`; `docker start coc-lab` resumes). `/status` `connection` becomes `lost`. Next heartbeat clears it.

---

## B. With the Lab (monitor.py running)

Start the lab:
```bash
bash deploy/local/test-stack.sh lab-up
```

Tail logs:
```bash
bash deploy/local/test-stack.sh lab-logs
```

### S6. Layer 2 Copy-Check (status/type/timestamp change → entry_edited)
```bash
# Edit status: 
$PSQL "UPDATE transactions SET status='failed' WHERE id=1"
# Within ~2-3 heartbeats (30-90 s) see Layer 2 entry_edited in /mismatches
curl -s $W/mismatches | jq '.[] | {seq, fields, issue}'
```
Restore:
```bash
$PSQL "UPDATE transactions SET status='completed' WHERE id=1"
```

### S7. Layer 2 Row Delete (→ entry_deleted + missing)
```bash
# Delete the witness_outbox row first (FK constraint), then the transaction
ID=1; $PSQL "DELETE FROM witness_outbox WHERE transaction_id=$ID; DELETE FROM transactions WHERE id=$ID"
# Expect: reconcile `missing`, Layer 2 `entry_deleted`
curl -s $W/mismatches | jq '.[] | {seq, issue}'
```

### S8. Layer 2 Unwitnessed Insert (→ db_edited_without_log after GRACE period)
```bash
$PSQL "INSERT INTO transactions(from_account_id,to_account_id,amount,type,status) SELECT id,NULL,5.00,'withdrawal','completed' FROM accounts LIMIT 1"
# After ~20 s (WITNESS_UNWITNESSED_GRACE_S default), see /alerts kind record_mismatch with issue unwitnessed
curl -s $W/alerts | jq '.[] | select(.issue=="unwitnessed")'
```

### S9. Layer 2 Scripted Attack (amount + type + status)
```bash
bash deploy/local/test-stack.sh attack 2
# Watches witness/mismatches until detection, then restores automatically
```

### S10. Layer 1 Tripwire (file changes via sed/echo/truncate/rm)
```bash
bash deploy/local/test-stack.sh attack 1
# Makes 4 file changes to /var/log/bank-demo/app.log, then restores
# Expect: command_executed and file_* alerts
curl -s $W/alerts | jq '.[] | {kind, layer}'
```

### S11. Layer 3 Config Drift (WITNESS_URL broken → quarantine:locked)
```bash
bash deploy/local/test-stack.sh attack 3
# Changes WITNESS_URL to unreachable, backend recreated, transactions fail
# After ~45 s (QUARANTINE_AFTER_S default), quarantine goes active:true confirmed:false
curl -s $W/status | jq .quarantine
```
Approve the quarantine:
```bash
curl -s -XPOST $W/quarantine/approve -H 'content-type: application/json' -d '{"holder":0}' | jq
curl -s -XPOST $W/quarantine/approve -d '{"holder":1}' | jq
# After second holder: quarantine:released
```
Restore:
```bash
bash deploy/local/test-stack.sh restore
# Reverts WITNESS_URL, recreates backend, clears quarantine
```

### S12. Layer 3 Network Cut (witness-cut flag → presumed quarantine after ~45 s)
```bash
bash deploy/local/test-stack.sh attack 3 cut   # or by hand: docker exec coc-lab touch /var/lib/coc-demo/witness-cut
# Every witness request fails for the monitor. After ~45 s (no contact):
curl -s $W/status | jq '.quarantine | {active, confirmed}'
# Remove the flag:
docker exec coc-lab rm -f /var/lib/coc-demo/witness-cut
# Monitor re-establishes contact, quarantine clears.
```

---

## Cleanup

```bash
bash deploy/local/test-stack.sh down
# Removes: banking-postgres, banking-backend, banking-frontend, banking-witness, coc-lab,
# volumes, throwaway .env
```

---

## Known Limits

1. **Check C (unknown):** never implemented; balance edits are not detected.
2. **Lockout (full_lock):** requires root on Linux; falls back to dry-run quarantine on Windows/demo.
3. **Ledger edit detection:** only checked at witness startup (not live).
4. **Heartbeat replay nonce:** there is none, so replays within 60 s are accepted (by design).
5. **Copy poisoning (found in local testing):** the witness's row copy (`witness/banksync.js` `receiveRows`)
   is taken from whatever the bank row holds the first time the monitor sends it (up to ~30-60 s after the
   commit) and is never checked against the witnessed commit. A change made in that window becomes the
   reference: status / account / timestamp edits are then never flagged, and restoring an amount edit leaves
   a permanent false "changed" finding. Reproduce: commit a deposit, immediately
   `UPDATE transactions SET status='failed'`, wait 90 s, `/mismatches` shows nothing.
