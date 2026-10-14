import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WitnessStore } from '../store.js';

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
