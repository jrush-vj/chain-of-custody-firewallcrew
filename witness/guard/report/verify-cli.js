#!/usr/bin/env node
// Independent check of an incident report against a witness ledger file. No witness needed.
//   node verify-cli.js <ledger.jsonl> <report.json>
// Exit 0 when every seq, hash and timestamp in the report matches the ledger; 1 otherwise.
import { readFileSync } from 'node:fs';
import { verifyReport } from './verify.js';

const [ledgerPath, reportPath] = process.argv.slice(2);
if (!ledgerPath || !reportPath) {
  console.error('usage: node verify-cli.js <ledger.jsonl> <report.json>');
  process.exit(2);
}
const records = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const result = verifyReport(JSON.parse(readFileSync(reportPath, 'utf8')), records);
console.log(result.ok ? 'report verified against the ledger' : `report FAILED verification:\n- ${result.problems.join('\n- ')}`);
process.exit(result.ok ? 0 : 1);
