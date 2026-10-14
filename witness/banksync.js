import { amountMinor, changedFields, parseRanges, rowHash, validateRow } from './records.js';

// How the witness keeps its own copy of the bank's transaction rows and checks the bank against it.
//
// ct105 sends, with every heartbeat, a compact view of the bank: how many rows there are, which ids,
// and a hash for a rotating sample of rows. The witness compares that with the copies it holds and
// answers with the ids it still needs. ct105 then sends just those rows. A copy is never overwritten:
// a row that later differs from its copy is recorded as evidence beside the copy.

export const SWEEP_LIMIT = 60;
export const NEED_LIMIT = 40;
export const ROWS_LIMIT = 40;
export const UNWITNESSED_GRACE_MS = 120_000;

const bad = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
};

const pick = (row) => ({
  id: row.id,
  type: row.type,
  amount: row.amount,
  status: row.status,
  from_account_id: row.from_account_id ?? null,
  to_account_id: row.to_account_id ?? null,
  timestamp: row.timestamp
});

const shortJson = (row) => JSON.stringify(pick(row)).slice(0, 1000);

// Checks the bank summary a heartbeat carries and returns it in a safe, normalised shape.
export const validateBankView = (bank) => {
  if (!bank || typeof bank !== 'object' || Array.isArray(bank)) bad('bank must be an object');
  if (!Number.isSafeInteger(bank.count) || bank.count < 0) bad('bank.count must be a non-negative integer');
  if (!Number.isSafeInteger(bank.max_id) || bank.max_id < 0) bad('bank.max_id must be a non-negative integer');
  const present = parseRanges(bank.ranges);
  if (present.size !== bank.count) bad('bank.ranges does not add up to bank.count');
  const sweep = bank.sweep ?? [];
  if (!Array.isArray(sweep) || sweep.length > SWEEP_LIMIT) bad(`bank.sweep must be a list of at most ${SWEEP_LIMIT} pairs`);
  const pairs = sweep.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0]) || !/^[0-9a-f]{32}$/.test(pair[1])) {
      bad('each sweep entry must be [id, 32-character hash]');
    }
    return pair;
  });
  return { count: bank.count, max_id: bank.max_id, present, sweep: pairs };
};

const witnessedTransactions = (store) => new Map(store.committedEvents().map((event) => [event.transaction_id, event]));

const raise = (store, kind, trigger, recordId, summary, detail) =>
  store.recordLayerEvent({
    layer: 2,
    trigger,
    kind,
    state: 'alert',
    summary: summary.slice(0, 200),
    detail: { record: recordId, ...detail },
    who: {}
  });

const resolve = (store, kind, recordId, reason) =>
  store.resolveLayerEvents(reason, { layer: 2, kind, record: recordId });

// Ids the witness still needs a copy of (ascending), capped.
const missingCopies = (store, present) =>
  [...present].filter((id) => !store.copies.has(id)).sort((a, b) => a - b);

// Called for every heartbeat that carries a bank view. Returns what ct105 should do next.
export const evaluateHeartbeat = async (store, bank, nowMs = Date.now()) => {
  const view = validateBankView(bank);
  store.bankView = { count: view.count, max_id: view.max_id, present: view.present, at: nowMs };

  // The first view fixes the baseline: rows up to here existed before copying began.
  if (store.baselineMaxId === null) {
    await store.recordBaseline(view.max_id);
  }

  const suspects = [];
  for (const [id, hash] of view.sweep) {
    store.currentHashes.set(id, { hash, at: nowMs });
    const copy = store.copies.get(id);
    if (!copy) continue;
    if (hash !== rowHash(copy)) {
      if (!store.openEvidence('entry_edited', id)) suspects.push(id);
    } else if (store.openEvidence('entry_edited', id)) {
      await resolve(store, 'entry_edited', id, 'the bank row matches its copy again');
    }
  }

  for (const id of [...store.copies.keys()]) {
    if (!view.present.has(id)) {
      if (!store.openEvidence('entry_deleted', id)) {
        await raise(store, 'entry_deleted', 'record_deleted', id, `record #${id} is gone from the bank database`, {
          before: shortJson(store.copies.get(id)),
          after: ''
        });
      }
    } else if (store.openEvidence('entry_deleted', id)) {
      await resolve(store, 'entry_deleted', id, 'the bank row is back');
    }
  }

  await checkUnwitnessed(store, nowMs);
  await markBaselineComplete(store, view.present);

  const need = [...missingCopies(store, view.present), ...suspects].slice(0, NEED_LIMIT);
  return syncReply(store, need);
};

// Rows with no witnessed commit are a row that reached the database without going through the bank's
// witness flow. Rows that existed before copying began are exempt.
const checkUnwitnessed = async (store, nowMs) => {
  const witnessed = witnessedTransactions(store);
  for (const [id, copy] of store.copies) {
    if (copy.baseline) continue;
    if (witnessed.has(id)) {
      if (store.openEvidence('db_edited_without_log', id)) {
        await resolve(store, 'db_edited_without_log', id, 'the row has now been witnessed');
      }
      continue;
    }
    if (nowMs - Date.parse(copy.copied_at) > UNWITNESSED_GRACE_MS && !store.openEvidence('db_edited_without_log', id)) {
      await raise(store, 'db_edited_without_log', 'record_unwitnessed', id,
        `record #${id} is in the bank database but was never witnessed`, { after: shortJson(copy) });
    }
  }
};

const markBaselineComplete = async (store, present) => {
  if (store.baselineMaxId === null || store.baselineComplete) return;
  const outstanding = [...present].some((id) => id <= store.baselineMaxId && !store.copies.has(id));
  if (!outstanding) {
    await store.recordBaseline(store.baselineMaxId, true);
  }
};

const syncReply = (store, need) => ({
  stored_count: store.copies.size,
  stored_max_id: store.copies.size ? Math.max(...store.copies.keys()) : 0,
  need_rows: need
});

// Called when ct105 sends rows. New rows become copies; a row that differs from its copy becomes evidence.
export const receiveRows = async (store, rows, nowMs = Date.now()) => {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > ROWS_LIMIT) bad(`rows must be a list of 1 to ${ROWS_LIMIT} rows`);
  const checked = rows.map(validateRow);
  const fresh = { baseline: [], late: [] };

  for (const row of checked) {
    store.currentHashes.set(row.id, { hash: rowHash(row), at: nowMs });
    const copy = store.copies.get(row.id);
    if (!copy) {
      // Rows that arrive after the baseline backfill finished are not baseline, even with a low id.
      const isBaseline = !store.baselineComplete && store.baselineMaxId !== null && row.id <= store.baselineMaxId;
      (isBaseline ? fresh.baseline : fresh.late).push(row);
      continue;
    }
    if (rowHash(row) === rowHash(copy)) {
      if (store.openEvidence('entry_edited', row.id)) {
        await resolve(store, 'entry_edited', row.id, 'the bank row matches its copy again');
      }
      continue;
    }
    if (store.openEvidence('entry_edited', row.id)) continue;
    const fields = changedFields(copy, row);
    await raise(store, 'entry_edited', 'record_edited', row.id,
      `record #${row.id} changed in the bank database: ${fields.join(', ')}`,
      { fields: fields.join(','), before: shortJson(copy), after: shortJson(row) });
  }

  if (fresh.baseline.length) await store.recordCopies(fresh.baseline, true);
  if (fresh.late.length) await store.recordCopies(fresh.late, false);
  if (store.bankView) await markBaselineComplete(store, store.bankView.present);

  const need = store.bankView ? missingCopies(store, store.bankView.present).slice(0, NEED_LIMIT) : [];
  return syncReply(store, need);
};

// ---- what the auditor page shows: counts, and only the fields that changed ----

export const recordCounts = (store) => {
  const view = store.bankView;
  const witnessed = witnessedTransactions(store).size;
  const open = store.layerEvents.filter(
    (item) => item.layer === 2 && ['entry_edited', 'entry_deleted', 'db_edited_without_log'].includes(item.kind) && item.state === 'alert' && !item.resolved
  ).length;
  const inSync = Boolean(view) && open === 0 && view.count === store.copies.size
    && [...view.present].every((id) => store.copies.has(id));
  return {
    reported: Boolean(view),
    bank_rows: view ? view.count : null,
    witness_copies: store.copies.size,
    witnessed_events: witnessed,
    last_sync_time: view ? view.at / 1000 : null,
    findings: open,
    in_sync: inSync
  };
};

const parse = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

// Evidence from the copies, as mismatch records for the Layer 2 panel (item 1's view).
export const evidenceMismatches = (store) => {
  const kinds = new Set(['entry_edited', 'entry_deleted', 'db_edited_without_log']);
  const found = store.layerEvents.filter((item) => item.layer === 2 && kinds.has(item.kind) && item.state === 'alert' && !item.resolved);
  const flagged = new Set(found.map((item) => item.detail.record));
  const present = store.bankView?.present;
  return found.map((item) => {
    const before = parse(item.detail.before);
    const after = parse(item.detail.after);
    // The nearest earlier copy with no finding against it and still in the bank: proven by the latest sync.
    const earlier = [...store.copies.values()]
      .filter((copy) => copy.id < item.detail.record && !flagged.has(copy.id) && (!present || present.has(copy.id)))
      .sort((a, b) => b.id - a.id)[0];
    return {
      seq: item.detail.record,
      kind: item.kind,
      fields: item.detail.fields ? String(item.detail.fields).split(',') : [],
      before,
      after,
      detected_at: item.recorded_at,
      previous_healthy: earlier ? pick(earlier) : null,
      verified_at: store.bankView ? new Date(store.bankView.at).toISOString() : null
    };
  });
};

export { amountMinor };
