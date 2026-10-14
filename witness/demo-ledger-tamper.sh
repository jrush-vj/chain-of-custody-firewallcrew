#!/usr/bin/env bash
set -euo pipefail

ledger=/var/lib/banking-witness/ledger.jsonl
backup=/var/lib/banking-witness/ledger.jsonl.demo-backup

if [ "$EUID" -ne 0 ]; then
  echo "Run with sudo: $0 tamper TRANSACTION_ID | restore" >&2
  exit 1
fi

action=${1:-}

case "$action" in
  tamper)
    transaction_id=${2:-}
    if [[ ! "$transaction_id" =~ ^[0-9]+$ ]]; then
      echo "Usage: $0 tamper TRANSACTION_ID" >&2
      exit 2
    fi
    if [ ! -f "$ledger" ]; then
      echo "Witness ledger not found: $ledger" >&2
      exit 1
    fi
    if [ -e "$backup" ]; then
      echo "Demo backup already exists; restore it before running another test." >&2
      exit 1
    fi

    node --input-type=module -e '
      import { readFile } from "node:fs/promises";
      const [file, id] = process.argv.slice(1);
      const records = (await readFile(file, "utf8")).split("\n").filter(Boolean);
      const matches = records
        .map((line, index) => ({ record: JSON.parse(line), index }))
        .filter(({ record }) =>
          record.action === "prepare" &&
          record.payload.event.transaction_id === Number(id) &&
          record.payload.event.type === "withdrawal" &&
          record.payload.event.amount_minor === 100
        );
      if (matches.length !== 1) {
        console.error(`Expected exactly one witnessed $1 withdrawal; found ${matches.length}.`);
        process.exit(1);
      }
    ' "$ledger" "$transaction_id"

    systemctl stop banking-witness.service
    cp -a "$ledger" "$backup"
    node --input-type=module -e '
      import { readFile, writeFile } from "node:fs/promises";
      const [file, id] = process.argv.slice(1);
      const text = await readFile(file, "utf8");
      const records = text.split("\n");
      let changed = 0;
      for (let index = 0; index < records.length; index += 1) {
        if (!records[index]) continue;
        const record = JSON.parse(records[index]);
        if (
          record.action === "prepare" &&
          record.payload.event.transaction_id === Number(id) &&
          record.payload.event.type === "withdrawal" &&
          record.payload.event.amount_minor === 100
        ) {
          record.payload.event.amount_minor = 10000;
          records[index] = JSON.stringify(record);
          changed += 1;
        }
      }
      if (changed !== 1) {
        console.error(`Expected to alter one event; altered ${changed}.`);
        process.exit(1);
      }
      await writeFile(file, records.join("\n"));
    ' "$ledger" "$transaction_id"
    chown banking-witness:banking-witness "$ledger"
    chmod 0600 "$ledger"
    systemctl start banking-witness.service
    sleep 2
    echo "Expected: dashboard shows LEDGER INTEGRITY FAILURE; new witness writes are disabled."
    curl --silent --show-error --include http://127.0.0.1:8787/v1/status
    ;;
  restore)
    if [ ! -f "$backup" ]; then
      echo "Demo backup not found: $backup" >&2
      exit 1
    fi
    systemctl stop banking-witness.service
    cp -a "$backup" "$ledger"
    rm "$backup"
    systemctl reset-failed banking-witness.service
    systemctl start banking-witness.service
    for _ in $(seq 1 10); do
      if curl --fail --silent http://127.0.0.1:8787/health; then
        echo
        echo "Witness restored; refresh the dashboard."
        exit 0
      fi
      sleep 1
    done
    echo "Witness did not become healthy; inspect journalctl -u banking-witness.service." >&2
    exit 1
    ;;
  *)
    echo "Usage: $0 tamper TRANSACTION_ID | restore" >&2
    exit 2
    ;;
esac
