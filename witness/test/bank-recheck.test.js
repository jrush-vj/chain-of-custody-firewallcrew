import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WitnessStore } from '../store.js';
import { rowHash } from '../records.js';
import { evaluateHeartbeat } from '../banksync.js';
import { BANK_CALL_BUDGET, checkBankRows, recheckPendingBankRows } from '../reconcile.js';

const seedCommitted = (store, count) => {
  const events = [];
  for (let id = 1; id <= count; id += 1) {
    const event = {
      event_id: `event-${id}`,
      transaction_id: id,
      type: 'deposit',
      amount_minor: id * 100,
      occurred_at: '2026-10-14T10:00:00.000Z'
    };
    store.events.set(event.event_id, { event, state: 'committed', updated_at: new Date(Date.now() - 60_000).toISOString() });
    events.push(event);
  }
  return events;
};

const copyOf = (id, amount = '1.00') => ({
  id,
  type: 'deposit',
  amount,
  status: 'completed',
  from_account_id: null,
  to_account_id: id,
  timestamp: '2026-10-14 10:00:00',
  baseline: true
});

// A bank that answers from the committed events (the four fields it can see), counting calls.
const bankFetch = (events, calls = { count: 0 }) => async (url) => {
  calls.count += 1;
  const ids = new URL(url).searchParams.get('transaction_ids').split(',').map(Number);
  const transactions = ids
    .map((id) => events.find((event) => event.transaction_id === id))
    .filter(Boolean)
    .map((event) => ({
      transaction_id: event.transaction_id,
      type: event.type,
      amount_minor: String(event.amount_minor),
      event_id: event.event_id
    }));
  return new Response(JSON.stringify({ transactions }), { status: 200 });
};

const bankView = (count, sweep) => ({
  count,
  max_id: count,
  ranges: count === 1 ? '1' : `1-${count}`,
  sweep
});

const withStore = async (run) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-witness-recheck-'));
  const store = new WitnessStore(path.join(directory, 'ledger.jsonl'));
  await store.initialize();
  try {
    await run(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test('a stale four-field finding clears once the heartbeat shows the row restored and the bank confirms', () => withStore(async (store) => {
  const events = seedCommitted(store, 1);
  const copy = copyOf(1, '1.00');
  store.copies.set(1, copy);
  store.baselineMaxId = 1;
  store.baselineComplete = true;
  store.bankFindings.set(1, { transaction_id: 1, issue: 'changed_amount', fields: ['amount'] });
  store.setReconciliation();
  assert.equal(store.status().bank_reconciliation.state, 'mismatch');

  const sync = await evaluateHeartbeat(store, bankView(1, [[1, rowHash(copy)]]));
  assert.deepEqual(sync.recheck_ids, [1]);
  await recheckPendingBankRows(store, bankFetch(events));

  assert.equal(store.bankFindings.size, 0);
  assert.equal(store.bankPendingIds.size, 0);
  assert.equal(store.status().bank_reconciliation.state, 'ok');
}));

test('a recovery re-check skipped by the budget stays pending and clears on a later heartbeat', () => withStore(async (store) => {
  const events = seedCommitted(store, 1);
  const copy = copyOf(1, '1.00');
  store.copies.set(1, copy);
  store.baselineMaxId = 1;
  store.baselineComplete = true;
  store.bankFindings.set(1, { transaction_id: 1, issue: 'changed_amount', fields: ['amount'] });
  store.setReconciliation();

  store.bankCallLog = Array.from({ length: BANK_CALL_BUDGET }, () => Date.now());
  await evaluateHeartbeat(store, bankView(1, [[1, rowHash(copy)]]));
  await recheckPendingBankRows(store, bankFetch(events));
  assert.equal(store.bankFindings.size, 1, 'the finding is kept while the bank cannot be asked');
  assert.equal(store.bankPendingIds.has(1), true, 'the id is still pending');

  store.bankCallLog = [];
  store.bankBudgetLimitedAt = null;
  await evaluateHeartbeat(store, bankView(1, [[1, rowHash(copy)]]));
  await recheckPendingBankRows(store, bankFetch(events));
  assert.equal(store.bankFindings.size, 0);
  assert.equal(store.bankPendingIds.size, 0);
}));

test('a pending id that is no longer committed is dropped with its finding and never sent to the bank', () => withStore(async (store) => {
  store.bankFindings.set(9, { transaction_id: 9, issue: 'missing' });
  store.bankPendingIds.add(9);
  const calls = { count: 0 };
  await recheckPendingBankRows(store, bankFetch([], calls));
  assert.equal(calls.count, 0);
  assert.equal(store.bankFindings.has(9), false);
  assert.equal(store.bankPendingIds.has(9), false);
}));

test('a status-only tamper never draws a green "matches the bank" while the record copy is flagged', () => withStore(async (store) => {
  const events = seedCommitted(store, 1);
  store.copies.set(1, { ...copyOf(1, '1.00'), status: 'failed' });
  store.baselineMaxId = 1;
  store.baselineComplete = true;
  await store.recordLayerEvent({
    layer: 2,
    trigger: 'record_edited',
    kind: 'entry_edited',
    state: 'alert',
    summary: 'record #1 changed in the bank database: status',
    detail: { record: 1, fields: 'status' },
    who: {}
  });

  await checkBankRows(store, [1], bankFetch(events));
  const activity = store.recentActivity();
  assert.ok(
    activity.some((item) => item.kind === 'challenge_mismatch' && item.detail.includes('record copy differs: status')),
    'the graph shows a red trough with the copy-check label'
  );
  assert.equal(activity.some((item) => item.kind === 'challenge_ok'), false, 'no green trough');
  assert.equal(store.bankPassedIds.has(1), false, 'a flagged record is not counted as verified');
  assert.equal(store.bankFindings.has(1), false, 'the four-field check still has no finding of its own');
}));
