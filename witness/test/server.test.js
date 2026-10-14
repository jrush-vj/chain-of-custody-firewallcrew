import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WitnessStore } from '../store.js';
import { reconcileBankTransactions } from '../reconcile.js';

process.env.WITNESS_NODE_ID = 'test-node';
process.env.WITNESS_HMAC_SECRET = 'test-secret-value-with-at-least-32-characters';
const { createWitnessServer } = await import('../server.js');

test('accepts authenticated prepare/commit and publishes a safe event view', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-witness-http-'));
  const store = new WitnessStore(path.join(directory, 'ledger.jsonl'));
  await store.initialize();
  const server = createWitnessServer(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const event = {
    event_id: 'c80ba038-26ef-4d2f-84a8-e504a67ec7e6',
    transaction_id: 12,
    type: 'deposit',
    amount_minor: 50000,
    occurred_at: '2026-10-14T10:00:00.000Z'
  };
  const post = async (pathname, payload) => {
    const body = JSON.stringify(payload);
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', process.env.WITNESS_HMAC_SECRET)
      .update(`POST\n${pathname}\n${timestamp}\n${body}`)
      .digest('hex');
    return fetch(`${baseUrl}${pathname}`, {
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

  try {
    const prepare = await post('/v1/prepare', { event });
    assert.equal(prepare.status, 200);
    assert.equal((await prepare.json()).state, 'prepared');
    const commit = await post('/v1/commit', { event_id: event.event_id });
    assert.equal(commit.status, 200);
    assert.equal((await commit.json()).state, 'committed');

    const eventsResponse = await fetch(`${baseUrl}/v1/events`);
    const events = await eventsResponse.json();
    assert.equal(events[0].amount_minor, 50000);
    assert.equal(events[0].state, 'committed');

    const invalid = await post('/v1/prepare', { event: { ...event, iban: 'private-data' } });
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('serves an integrity alert and disables writes when the ledger is altered', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-witness-alert-'));
  const ledger = path.join(directory, 'ledger.jsonl');
  let server;
  try {
    const healthyStore = new WitnessStore(ledger);
    await healthyStore.initialize();
    await healthyStore.prepare({
      event_id: 'c80ba038-26ef-4d2f-84a8-e504a67ec7e6',
      transaction_id: 12,
      type: 'withdrawal',
      amount_minor: 100,
      occurred_at: '2026-10-14T10:00:00.000Z'
    });

    test('detects changed or missing bank rows during independent reconciliation', async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-witness-reconcile-'));
      const store = new WitnessStore(path.join(directory, 'ledger.jsonl'));
      process.env.BANK_RECONCILE_URL = 'https://bank.example.test/api/transactions/witness-reconcile';
      try {
        await store.initialize();
        for (const [eventId, transactionId] of [
          ['c80ba038-26ef-4d2f-84a8-e504a67ec7e6', 12],
          ['fd808249-0454-412c-800f-541a2526831f', 13]
        ]) {
          await store.prepare({
            event_id: eventId,
            transaction_id: transactionId,
            type: 'withdrawal',
            amount_minor: 100,
            occurred_at: '2026-10-14T10:00:00.000Z'
          });
          await store.transition(eventId, 'commit');
        }

        const result = await reconcileBankTransactions(store, async (url) => {
          assert.equal(url.hostname, 'bank.example.test');
          assert.equal(url.pathname, '/api/transactions/witness-reconcile');
          return new Response(JSON.stringify({
            transactions: [{
              transaction_id: 12,
              type: 'withdrawal',
              amount_minor: '10000',
              event_id: 'c80ba038-26ef-4d2f-84a8-e504a67ec7e6'
            }]
          }), { status: 200 });
        });

        assert.equal(result.state, 'mismatch');
        assert.deepEqual(
          result.mismatches.map(({ transaction_id, issue }) => ({ transaction_id, issue })),
          [
            { transaction_id: 12, issue: 'changed_amount' },
            { transaction_id: 13, issue: 'missing' }
          ]
        );
      } finally {
        delete process.env.BANK_RECONCILE_URL;
        await rm(directory, { recursive: true, force: true });
      }
    });
    const contents = await readFile(ledger, 'utf8');
    await writeFile(ledger, contents.replace('"amount_minor":100', '"amount_minor":10000'));

    const damagedStore = new WitnessStore(ledger);
    await assert.rejects(() => damagedStore.initialize(), /integrity check failed/);
    server = createWitnessServer(damagedStore);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 503);
    assert.equal((await health.json()).healthy, false);

    const status = await fetch(`${baseUrl}/v1/status`);
    const statusBody = await status.json();
    assert.equal(statusBody.healthy, false);
    assert.match(statusBody.integrity_error, /integrity validation failed/i);

    const dashboard = await fetch(baseUrl);
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /LEDGER INTEGRITY FAILURE/);

    await assert.rejects(
      () => damagedStore.prepare({
        event_id: 'fd808249-0454-412c-800f-541a2526831f',
        transaction_id: 13,
        type: 'deposit',
        amount_minor: 100,
        occurred_at: '2026-10-14T10:01:00.000Z'
      }),
      (error) => error.statusCode === 503
    );
  } finally {
    if (server?.listening) {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    await rm(directory, { recursive: true, force: true });
  }
});
