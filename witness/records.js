import { createHash } from 'node:crypto';

// The only columns of a bank transaction the witness will accept a copy of. Names, IBANs, account
// numbers and the free-text reference are deliberately not here: the witness cannot be sent them.
export const ROW_FIELDS = ['id', 'type', 'amount', 'status', 'from_account_id', 'to_account_id', 'timestamp'];

const ROW_TYPES = new Set(['deposit', 'withdrawal', 'transfer', 'external_incoming', 'external_outgoing']);

const bad = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
};

const nullableId = (value, name) => {
  if (value === null || value === '') return null;
  if (!Number.isSafeInteger(value) || value <= 0) bad(`${name} must be a positive integer or null`);
  return value;
};

// Checks one copied row and returns it with exactly the allowed fields, or throws a 400.
export const validateRow = (row) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) bad('row must be an object');
  const extra = Object.keys(row).filter((key) => !ROW_FIELDS.includes(key));
  if (extra.length) bad(`row has fields that are not allowed: ${extra.join(', ')}`);
  if (!Number.isSafeInteger(row.id) || row.id <= 0) bad('id must be a positive integer');
  if (!ROW_TYPES.has(row.type)) bad('type is not a known transaction type');
  if (typeof row.amount !== 'string' || !/^\d{1,16}\.\d{2}$/.test(row.amount)) bad('amount must be a decimal with two places');
  if (typeof row.status !== 'string' || !/^[a-z_]{1,20}$/.test(row.status)) bad('status must be a short lowercase word');
  if (typeof row.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/.test(row.timestamp)) {
    bad('timestamp must look like 2026-10-14 15:30:22');
  }
  return {
    id: row.id,
    type: row.type,
    amount: row.amount,
    status: row.status,
    from_account_id: nullableId(row.from_account_id, 'from_account_id'),
    to_account_id: nullableId(row.to_account_id, 'to_account_id'),
    timestamp: row.timestamp
  };
};

// One fixed text form of a row. ct105 builds the same text, so both sides hash the same thing.
export const canonicalRow = (row) =>
  [row.id, row.type, row.amount, row.status, row.from_account_id ?? '', row.to_account_id ?? '', row.timestamp].join('|');

export const rowHash = (row) => createHash('sha256').update(canonicalRow(row)).digest('hex').slice(0, 32);

// "1-8,10,12-14" -> Set of ids. Rejects anything else and caps the size, so a bad request cannot
// make the witness build a huge set.
export const parseRanges = (text, limit = 200_000) => {
  if (typeof text !== 'string' || text.length > 4000 || !/^[0-9,-]*$/.test(text)) bad('ranges must look like 1-8,10');
  const ids = new Set();
  for (const part of text.split(',').filter(Boolean)) {
    const [from, to = from] = part.split('-').map(Number);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from <= 0 || to < from) bad('invalid range');
    if (ids.size + (to - from + 1) > limit) bad('too many ids');
    for (let id = from; id <= to; id += 1) ids.add(id);
  }
  return ids;
};

// Which fields differ between two rows: their names, in a fixed order.
export const changedFields = (before, after) => ROW_FIELDS.filter((field) => field !== 'id' && (before[field] ?? null) !== (after[field] ?? null));

// Amount in minor units, so a copy can be set beside the four-field witnessed record.
export const amountMinor = (row) => Math.round(Number(row.amount) * 100);
