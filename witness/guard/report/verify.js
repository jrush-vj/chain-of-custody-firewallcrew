// Report verifier. Recomputes every seq, hash and timestamp a report claims from the ledger records
// themselves, and refuses the report if any claim does not match. Pure: records in, result out.
//
// The ledger hash rule is the witness's own (store.js recordHash): sha256 over the JSON of
// {seq, previous_hash, action, payload, recorded_at}, in that key order. It is repeated here on purpose so
// an auditor can verify with this file alone; a test pins it to the store's real hashes.
import { createHash } from 'node:crypto';

export const ZERO_HASH = '0'.repeat(64);

export const ledgerHash = (record) => createHash('sha256').update(JSON.stringify({
  seq: record.seq, previous_hash: record.previous_hash, action: record.action,
  payload: record.payload, recorded_at: record.recorded_at
})).digest('hex');

// Stable JSON: keys sorted at every level, so a report hashes the same wherever it is re-serialised.
export const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

export const reportHash = (report) => {
  const { sha256: _ignored, ...rest } = report;
  return createHash('sha256').update(canonical(rest)).digest('hex');
};

// Walk the whole chain. Returns { ok, checked, head_seq, head_hash, first_bad_seq }.
export const checkChain = (records) => {
  let previous = ZERO_HASH;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.seq !== index + 1 || record.previous_hash !== previous || record.hash !== ledgerHash(record)) {
      return { ok: false, checked: index, head_seq: null, head_hash: null, first_bad_seq: index + 1 };
    }
    previous = record.hash;
  }
  return { ok: true, checked: records.length, head_seq: records.length || null, head_hash: records.length ? previous : null, first_bad_seq: null };
};

// A cited ledger entry must exist, with the same hash and the same time.
const matches = (records, cite) => {
  const record = Number.isInteger(cite.seq) ? records[cite.seq - 1] : null;
  return Boolean(record && record.seq === cite.seq && record.hash === cite.hash && record.recorded_at === cite.recorded_at);
};

export const verifyReport = (report, records) => {
  const problems = [];
  if (!report || typeof report !== 'object') return { ok: false, problems: ['not a report'] };
  if (report.sha256 !== reportHash(report)) problems.push('report body does not match its own sha256');

  const chain = checkChain(records);
  if (!chain.ok) problems.push(`ledger chain is broken at seq ${chain.first_bad_seq}`);
  const claimed = report.chain_verification || {};
  if (claimed.ok !== chain.ok) problems.push('chain verification result differs from the ledger');
  // The head the report saw must still be in the ledger (the ledger only grows).
  const head = claimed.head_seq ? records[claimed.head_seq - 1] : null;
  if (!head || head.hash !== claimed.head_hash) problems.push('ledger head cited by the report is not in the ledger');

  for (const entry of report.layers || []) if (!matches(records, entry)) problems.push(`layer entry seq ${entry.seq} does not match the ledger`);
  for (const entry of report.containment || []) if (!matches(records, entry)) problems.push(`containment entry seq ${entry.seq} does not match the ledger`);

  const range = report.seq_range;
  if (range) {
    const first = records[range.first - 1];
    const last = records[range.last - 1];
    if (!first || first.hash !== range.first_hash || !last || last.hash !== range.last_hash) problems.push('seq range hashes do not match the ledger');
    const cited = [...(report.layers || []), ...(report.containment || [])].map((entry) => entry.seq);
    if (cited.some((seq) => seq < range.first || seq > range.last)) problems.push('a cited entry lies outside the seq range');
  }
  return { ok: problems.length === 0, problems };
};
