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

test('serves the cybersec auditor dashboard on the banking witness API', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-witness-dashboard-'));
  const store = new WitnessStore(path.join(directory, 'ledger.jsonl'));
  await store.initialize();
  const server = createWitnessServer(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Chain of Custody · Witness/);
    assert.match(html, /class="nm">Custom commands</);
    assert.match(html, /class="nm">Heartbeat &amp; checksum</);
    assert.match(html, /class="nm">Quarantine</);
    assert.match(html, /PREVIEW · sample data, not live/);
    assert.match(html, /j\("\/status"\)/);
    assert.match(html, /j\("\/alerts"\)/);
    assert.match(html, /j\("\/timeline"\)/);
    assert.match(html, /j\("\/mismatches"\)/);
    assert.match(html, /j\("\/activity\?since_id="/);
    const status = await (await fetch(`http://127.0.0.1:${server.address().port}/status`)).json();
    assert.equal(status.connection, 'waiting');
    assert.equal(status.state, 'unknown');
    assert.equal(status.checks.B, 'unknown');
    assert.deepEqual(status.layers, { 1: 'off', 2: 'on', 3: 'off' });
    assert.equal(status.bank_reconciliation.checked_at, null);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

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

    store.setReconciliation({
      state: 'mismatch',
      checked_transactions: 1,
      mismatches: [{
        transaction_id: 12,
        issue: 'changed_amount',
        fields: ['amount'],
        witnessed_type: 'deposit',
        bank_type: 'deposit',
        witnessed_amount_minor: 50000,
        bank_amount_minor: 10000,
        witnessed_event_id: event.event_id,
        bank_event_id: 'fd808249-0454-412c-800f-541a2526831f'
      }]
    });
    const auditorStatus = await (await fetch(`${baseUrl}/status`)).json();
    assert.equal(auditorStatus.integration_mode, 'banking-witness');
    assert.equal(auditorStatus.platform_id, 'banking-system');
    assert.equal(auditorStatus.connection, 'connected');
    assert.equal(auditorStatus.checks.B, 'red');
    assert.equal(auditorStatus.checks.C, 'unknown');
    assert.deepEqual(auditorStatus.layers, { 1: 'off', 2: 'on', 3: 'off' });
    assert.equal(auditorStatus.bank_reconciliation.mismatch_count, 1);

    const alerts = await (await fetch(`${baseUrl}/alerts`)).json();
    assert.equal(alerts.alerts[0].kind, 'record_mismatch');
    const timeline = await (await fetch(`${baseUrl}/timeline`)).json();
    assert.equal(timeline.events[0].layer, 2);
    assert.equal(timeline.events[0].detail.transaction_id, event.transaction_id);
    const mismatches = await (await fetch(`${baseUrl}/mismatches`)).json();
    assert.deepEqual(mismatches.mismatches[0].fields, ['amount']);
    assert.equal(mismatches.mismatches[0].witness_copy.amount_minor, 50000);
    assert.equal(mismatches.mismatches[0].server_copy.amount_minor, 10000);
    const activity = await (await fetch(`${baseUrl}/activity?since_id=0`)).json();
    assert.deepEqual(activity.activity.map(({ id }) => id), [1, 2]);
    assert.deepEqual(
      (await (await fetch(`${baseUrl}/activity?since_id=1`)).json()).activity.map(({ id }) => id),
      [2]
    );
    assert.equal((await fetch(`${baseUrl}/activity?since_id=nope`)).status, 400);

    store.setReconciliationUnavailable('bank API unavailable');
    const unavailable = await (await fetch(`${baseUrl}/status`)).json();
    assert.equal(unavailable.connection, 'lost');
    assert.equal(unavailable.state, 'unknown');
    assert.equal(unavailable.bank_reconciliation.state, 'unavailable');
    assert.equal(unavailable.bank_reconciliation.last_successful_check !== null, true);

    const approval = await fetch(`${baseUrl}/quarantine/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ holder: 0 })
    });
    assert.equal(approval.status, 409);
    assert.deepEqual(await approval.json(), {
      status: 'disabled',
      dry_run: true,
      reason: 'Layer 3 quarantine is not integrated; no system actions are available.'
    });
    assert.equal(store.status().record_count, 2);

    const invalid = await post('/v1/prepare', { event: { ...event, iban: 'private-data' } });
    assert.equal(invalid.status, 400);
    const abortedEvent = {
      ...event,
      event_id: 'fd808249-0454-412c-800f-541a2526831f',
      transaction_id: 13
    };
    assert.equal((await post('/v1/prepare', { event: abortedEvent })).status, 200);
    const abort = await post('/v1/abort', { event_id: abortedEvent.event_id });
    assert.equal(abort.status, 200);
    assert.equal((await abort.json()).state, 'aborted');
    const statusAfterAbort = await (await fetch(`${baseUrl}/status`)).json();
    assert.equal(statusAfterAbort.last_verified.seq, event.transaction_id);
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
    assert.match(await dashboard.text(), /j\("\/alerts"\)/);
    const alerts = (await (await fetch(`${baseUrl}/alerts`)).json()).alerts;
    assert.ok(alerts.some((alert) => alert.kind === 'chain_break' && alert.resolved === 0));

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

test('ingests signed Layer 1 and Layer 2 events into the ledger and dashboard feeds', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-witness-layers-'));
  const ledgerPath = path.join(directory, 'ledger.jsonl');
  const store = new WitnessStore(ledgerPath);
  await store.initialize();
  const server = createWitnessServer(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = async (payload, { signed = true } = {}) => {
    const body = JSON.stringify(payload);
    const timestamp = String(Date.now());
    const headers = { 'content-type': 'application/json' };
    if (signed) {
      headers['x-witness-node'] = process.env.WITNESS_NODE_ID;
      headers['x-witness-timestamp'] = timestamp;
      headers['x-witness-signature'] = createHmac('sha256', process.env.WITNESS_HMAC_SECRET)
        .update(`POST\n/v1/layer-events\n${timestamp}\n${body}`)
        .digest('hex');
    }
    return fetch(`${baseUrl}/v1/layer-events`, { method: 'POST', headers, body });
  };
  const tripwire = {
    layer: 1,
    trigger: 'wrapper:nano',
    state: 'alert',
    summary: 'nano ran against /var/log/bank without the profile id',
    detail: { cmd: 'nano /var/log/bank/app.log', mode: 'deception' }
  };
  const tamper = {
    layer: 2,
    trigger: 'checksum:entry_edited',
    kind: 'entry_edited',
    state: 'alert',
    summary: 'log entry changed after sealing',
    detail: { seq: 7 }
  };

  try {
    assert.equal((await post(tripwire)).status, 200);
    assert.equal((await post(tamper)).status, 200);
    assert.equal((await post(tripwire, { signed: false })).status, 401);
    assert.equal((await post({ ...tripwire, kind: 'entry_edited' })).status, 400);
    assert.equal((await post({ ...tamper, kind: 'not_a_kind' })).status, 400);
    assert.equal((await post({ ...tamper, detail: { nested: { no: true } } })).status, 400);

    const alerts = (await (await fetch(`${baseUrl}/alerts`)).json()).alerts;
    assert.ok(alerts.some((alert) => alert.kind === 'layer1_tripwire' && alert.resolved === 0));
    assert.ok(alerts.some((alert) => alert.kind === 'entry_edited'));

    const timeline = (await (await fetch(`${baseUrl}/timeline`)).json()).events;
    assert.ok(timeline.some((event) => event.layer === 1 && event.state === 'alert' && event.detail.cmd));

    const status = await (await fetch(`${baseUrl}/status`)).json();
    assert.equal(status.layers[1], 'off');
    assert.equal(status.quarantine.active, false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  const reloaded = new WitnessStore(ledgerPath);
  await reloaded.initialize();
  assert.equal(reloaded.recentLayerEvents().length, 2);
  await rm(directory, { recursive: true, force: true });
});
