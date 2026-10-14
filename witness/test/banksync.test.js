import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WitnessStore } from '../store.js';
import { canonicalRow, rowHash, validateRow } from '../records.js';
import { evaluateHeartbeat, receiveRows, recordCounts } from '../banksync.js';

process.env.WITNESS_NODE_ID = 'test-node';
process.env.WITNESS_HMAC_SECRET = 'test-secret-value-with-at-least-32-characters';
const { createWitnessServer } = await import('../server.js');

test('a copied bank row is validated against a fixed allowlist and hashed identically on both sides', () => {
  const row = { id: 7, type: 'deposit', amount: '200.00', status: 'completed', from_account_id: null, to_account_id: 3, timestamp: '2026-10-14 15:30:22.123456' };
  assert.equal(canonicalRow(row), '7|deposit|200.00|completed||3|2026-10-14 15:30:22.123456');
  // The same vector is asserted in the ct105 Python tests, so both sides hash the same text.
  assert.equal(rowHash(row), '1ffd7af7d32603d1e90e9c67ff7bac22');
  assert.deepEqual(validateRow(row), row);
  for (const extra of ['reference', 'external_to_iban', 'account_number', 'external_from_name']) {
    assert.throws(() => validateRow({ ...row, [extra]: 'private' }), /not allowed/, extra);
  }
  assert.throws(() => validateRow({ ...row, amount: '200' }), /decimal/);
  assert.throws(() => validateRow({ ...row, type: 'gift' }), /type/);
  assert.throws(() => validateRow({ ...row, timestamp: 'yesterday' }), /timestamp/);
  assert.throws(() => validateRow({ ...row, to_account_id: -1 }), /to_account_id/);
});

test('the witness keeps copies of the bank rows and catches an edit, a deletion and an unwitnessed row', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-witness-copies-'));
  const ledger = path.join(directory, 'ledger.jsonl');
  const store = new WitnessStore(ledger);
  await store.initialize();
  const server = createWitnessServer(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const row = (id, extra = {}) => ({
    id,
    type: 'deposit',
    amount: `${id * 100}.00`,
    status: 'completed',
    from_account_id: null,
    to_account_id: id,
    timestamp: `2026-10-14 10:00:0${id}`,
    ...extra
  });
  const view = (ids, sweep = []) => ({ count: ids.length, max_id: Math.max(0, ...ids), ranges: ids.join(','), sweep });
  const mismatches = async () => (await (await fetch(`${baseUrl}/mismatches`)).json()).mismatches;
  const alerts = async () => (await (await fetch(`${baseUrl}/alerts`)).json()).alerts;
  const signedPost = (route, payload) => {
    const body = JSON.stringify(payload);
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', process.env.WITNESS_HMAC_SECRET)
      .update(['POST', route, timestamp, body].join(String.fromCharCode(10)))
      .digest('hex');
    return fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-witness-node': process.env.WITNESS_NODE_ID,
        'x-witness-timestamp': timestamp,
        'x-witness-signature': signature
      },
      body
    });
  };
  const now = Date.now();

  try {
    // 1. The first view sets the baseline and the witness asks for every row.
    let reply = await evaluateHeartbeat(store, view([1, 2, 3]), now);
    assert.deepEqual(reply.need_rows, [1, 2, 3]);
    assert.equal(store.baselineMaxId, 3);

    // 2. The rows arrive and are stored; the baseline is complete.
    reply = await receiveRows(store, [row(1), row(2), row(3)], now);
    assert.deepEqual(reply, { stored_count: 3, stored_max_id: 3, need_rows: [] });
    assert.equal(store.baselineComplete, true);
    assert.equal(recordCounts(store).in_sync, true);
    assert.equal(recordCounts(store).bank_rows, 3);
    assert.equal(recordCounts(store).witness_copies, 3);
    assert.equal((await (await fetch(`${baseUrl}/status`)).json()).records.in_sync, true);
    assert.equal((await mismatches()).length, 0);

    // 3. Row 2 is edited in the bank. The sweep shows a different hash, the witness asks for the row,
    //    and the evidence says exactly which fields changed. The copy is never overwritten.
    const edited = row(2, { status: 'failed', amount: '999.00' });
    reply = await evaluateHeartbeat(store, view([1, 2, 3], [[2, rowHash(edited)]]), now + 1000);
    assert.deepEqual(reply.need_rows, [2]);
    await receiveRows(store, [edited], now + 1500);
    const [found] = await mismatches();
    assert.equal(found.seq, 2);
    assert.deepEqual([...found.fields].sort(), ['amount', 'status']);
    assert.equal(found.witness_copy.status, 'completed');
    assert.equal(found.server_copy.status, 'failed');
    assert.equal(found.witness_copy.amount_minor, 20000);
    assert.equal(found.server_copy.amount_minor, 99900);
    assert.equal(found.previous_healthy.seq, 1, 'the nearest earlier copy with no finding against it');
    assert.equal(store.copies.get(2).status, 'completed', 'the copy is kept as it was first seen');
    assert.equal(recordCounts(store).in_sync, false);
    assert.equal((await alerts()).some((alert) => alert.kind === 'entry_edited'), true);

    // The same finding is not raised twice.
    await evaluateHeartbeat(store, view([1, 2, 3], [[2, rowHash(edited)]]), now + 2000);
    assert.equal((await mismatches()).length, 1);

    // 4. Put back: the sweep matches the copy again and the finding resolves.
    await evaluateHeartbeat(store, view([1, 2, 3], [[2, rowHash(row(2))]]), now + 3000);
    assert.equal((await mismatches()).length, 0);
    assert.equal(recordCounts(store).in_sync, true);

    // 5. Row 3 is deleted, then comes back.
    await evaluateHeartbeat(store, view([1, 2]), now + 4000);
    assert.deepEqual((await mismatches()).map((item) => [item.seq, item.issue]), [[3, 'missing']]);
    await evaluateHeartbeat(store, view([1, 2, 3]), now + 5000);
    assert.equal((await mismatches()).length, 0);

    // 6. A row appears that never went through the witness flow. Nothing is raised during the grace period.
    reply = await evaluateHeartbeat(store, view([1, 2, 3, 4]), now + 6000);
    assert.deepEqual(reply.need_rows, [4]);
    await receiveRows(store, [row(4)], now + 6000);
    assert.equal(store.copies.get(4).baseline, false, 'rows after the baseline must be witnessed');
    await evaluateHeartbeat(store, view([1, 2, 3, 4]), now + 66_000);
    assert.equal((await mismatches()).length, 0, 'still inside the grace period');
    await evaluateHeartbeat(store, view([1, 2, 3, 4]), Date.now() + 130_000);
    const unwitnessed = (await mismatches()).find((item) => item.seq === 4);
    assert.equal(unwitnessed.issue, 'unwitnessed');
    assert.equal(unwitnessed.server_copy.amount_minor, 40000);
    assert.equal((await alerts()).some((alert) => alert.kind === 'db_edited_without_log'), true);

    // Once the bank's witness flow catches up, the finding resolves.
    const event = { event_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', transaction_id: 4, type: 'deposit', amount_minor: 40000, occurred_at: '2026-10-14T10:00:04.000Z' };
    await store.prepare(event);
    await store.transition(event.event_id, 'commit');
    await evaluateHeartbeat(store, view([1, 2, 3, 4]), Date.now() + 131_000);
    assert.equal((await mismatches()).filter((item) => item.seq === 4).length, 0);

    // 7. Privacy and robustness: an extra column is refused over HTTP, and a bad view does not undo a heartbeat.
    const refused = await signedPost('/v1/records', { rows: [{ ...row(5), reference: 'private text' }] });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /not allowed/);
    const heartbeat = await signedPost('/v1/heartbeat', { seq: Date.now(), bank: { count: 9, max_id: 3, ranges: '1-3', sweep: [] } });
    assert.equal(heartbeat.status, 200);
    assert.match((await heartbeat.json()).sync_error, /does not add up/);
    const good = await signedPost('/v1/heartbeat', { seq: Date.now() + 1, bank: view([1, 2, 3, 4]) });
    assert.equal((await good.json()).sync.stored_count, 4);

    // 8. A restart keeps the copies, the baseline and its completion.
    const reloaded = new WitnessStore(ledger);
    await reloaded.initialize();
    assert.equal(reloaded.copies.size, 4);
    assert.equal(reloaded.baselineMaxId, 3);
    assert.equal(reloaded.baselineComplete, true);
    assert.equal(reloaded.copies.get(2).status, 'completed');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
