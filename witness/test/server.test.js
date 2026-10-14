import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WitnessStore } from '../store.js';
import { challengeRecord, reconcileBankTransactions, runChallengeStep } from '../reconcile.js';

process.env.WITNESS_NODE_ID = 'test-node';
process.env.WITNESS_HMAC_SECRET = 'test-secret-value-with-at-least-32-characters';
const { createWitnessServer, checkHeartbeatSilence } = await import('../server.js');

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
    assert.doesNotMatch(html, /sample data|data-pv|Preview/);
    assert.match(html, /j\("\/status"\)/);
    assert.match(html, /j\("\/alerts"\)/);
    assert.match(html, /j\("\/timeline"\)/);
    assert.match(html, /j\("\/mismatches"\)/);
    assert.match(html, /j\("\/activity\?since_id="/);
    const status = await (await fetch(`http://127.0.0.1:${server.address().port}/status`)).json();
    assert.equal(status.connection, 'waiting');
    assert.equal(status.state, 'unknown');
    assert.equal(status.checks.B, 'unknown');
    assert.deepEqual(status.layers, { 1: 'off', 2: 'on', 3: 'on' });
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
    assert.deepEqual(auditorStatus.layers, { 1: 'off', 2: 'on', 3: 'on' });
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
    const activityIds = activity.activity.map(({ id }) => id);
    assert.deepEqual(activity.activity.map(({ kind }) => kind), ['witness_prepare', 'witness_commit']);
    assert.deepEqual(
      (await (await fetch(`${baseUrl}/activity?since_id=${activityIds[0]}`)).json()).activity.map(({ id }) => id),
      [activityIds[1]]
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
      status: 'nothing_to_release',
      reason: 'No confirmed quarantine is waiting for approval'
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
    detail: { cmd: 'nano /var/log/bank/app.log', mode: 'deception' },
    who: { user: 'root', auid: '1000', src_ip: 'local' }
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
    assert.ok(timeline.some((event) => event.layer === 1 && event.who?.user === 'root'));

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

test('records heartbeats and challenge entries from bank reconciliation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-witness-heartbeat-'));
  const store = new WitnessStore(path.join(directory, 'ledger.jsonl'));
  await store.initialize();
  const event = {
    event_id: 'c80ba038-26ef-4d2f-84a8-e504a67ec7e6',
    transaction_id: 21,
    type: 'deposit',
    amount_minor: 50000,
    occurred_at: '2026-10-14T10:00:00.000Z'
  };
  await store.prepare(event);
  await store.transition(event.event_id, 'commit');
  const bankReturns = (transactions) => async () => ({ ok: true, json: async () => ({ transactions }) });
  const matching = [{ transaction_id: 21, type: 'deposit', amount_minor: '50000', event_id: event.event_id }];

  await reconcileBankTransactions(store, bankReturns(matching));
  assert.ok(!store.recentActivity().some((item) => item.kind === 'heartbeat'), 'heartbeats come from ct105, not the reconcile pass');

  await reconcileBankTransactions(store, bankReturns([{ ...matching[0], amount_minor: '10000' }]));
  assert.ok(store.recentActivity().some((item) => item.kind === 'challenge_mismatch' && item.detail.includes('record #21')));

  await reconcileBankTransactions(store, bankReturns(matching));
  assert.ok(store.recentActivity().some((item) => item.kind === 'challenge_ok'));
  assert.equal(store.reportedMismatches.size, 0);
});

test('queues a website restore request, rate-limits it, and records the ct105 acknowledgement', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-witness-restore-'));
  const store = new WitnessStore(path.join(directory, 'ledger.jsonl'));
  await store.initialize();
  await store.recordLayerEvent({ layer: 1, trigger: 'command_executed', state: 'alert', summary: 'rm on the bank log', detail: { cmd: 'rm' }, who: {} });
  const server = createWitnessServer(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const layer1Alerts = async () => (await (await fetch(`${baseUrl}/alerts`)).json()).alerts.filter((alert) => alert.kind === 'layer1_tripwire');
  assert.equal((await layer1Alerts()).length, 1);
  const signed = (method, pathname, body = '') => {
    const timestamp = String(Date.now());
    return {
      'x-witness-node': process.env.WITNESS_NODE_ID,
      'x-witness-timestamp': timestamp,
      'x-witness-signature': createHmac('sha256', process.env.WITNESS_HMAC_SECRET)
        .update(`${method}\n${pathname}\n${timestamp}\n${body}`)
        .digest('hex')
    };
  };

  try {
    const first = await fetch(`${baseUrl}/v1/restore-request`, { method: 'POST' });
    assert.equal(first.status, 202);
    const id = (await first.json()).id;
    assert.equal((await fetch(`${baseUrl}/v1/restore-request`, { method: 'POST' })).status, 409);
    assert.equal((await fetch(`${baseUrl}/v1/restore-pending`)).status, 401);
    const pending = await fetch(`${baseUrl}/v1/restore-pending`, { headers: signed('GET', '/v1/restore-pending') });
    assert.equal((await pending.json()).pending.id, id);

    const wrongBody = JSON.stringify({ id: 'not-the-id', ok: true, summary: 'x' });
    const wrong = await fetch(`${baseUrl}/v1/restore-ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signed('POST', '/v1/restore-ack', wrongBody) },
      body: wrongBody
    });
    assert.equal(wrong.status, 404);

    const okBody = JSON.stringify({ id, ok: true, summary: 'Layer 1: 1 file restored; Layer 2: 2 rows restored' });
    const ack = await fetch(`${baseUrl}/v1/restore-ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signed('POST', '/v1/restore-ack', okBody) },
      body: okBody
    });
    assert.equal(ack.status, 200);
    const kinds = store.recentActivity().map((item) => item.kind);
    assert.ok(kinds.includes('restore_requested'));
    assert.ok(kinds.includes('restore_completed'));
    assert.equal((await layer1Alerts()).length, 0, 'restored alerts leave the card');
    assert.equal((await (await fetch(`${baseUrl}/timeline`)).json()).events.filter((event) => event.layer === 1).length, 1, 'history stays');
    const reloaded = new WitnessStore(path.join(directory, 'ledger.jsonl'));
    await reloaded.initialize();
    assert.equal(reloaded.recentLayerEvents()[0].resolved, true, 'resolution survives a restart');
    assert.equal((await fetch(`${baseUrl}/v1/restore-request`, { method: 'POST' })).status, 429);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('accepts signed heartbeats, rejects replays, and raises then clears a silence alert', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-witness-beat-'));
  const store = new WitnessStore(path.join(directory, 'ledger.jsonl'));
  await store.initialize();
  const server = createWitnessServer(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const beat = (payload, { signed = true } = {}) => {
    const body = JSON.stringify(payload);
    const timestamp = String(Date.now());
    const headers = { 'content-type': 'application/json' };
    if (signed) {
      headers['x-witness-node'] = process.env.WITNESS_NODE_ID;
      headers['x-witness-timestamp'] = timestamp;
      headers['x-witness-signature'] = createHmac('sha256', process.env.WITNESS_HMAC_SECRET)
        .update(`POST
/v1/heartbeat
${timestamp}
${body}`)
        .digest('hex');
    }
    return fetch(`${baseUrl}/v1/heartbeat`, { method: 'POST', headers, body });
  };
  const silenceAlerts = async () => (await (await fetch(`${baseUrl}/alerts`)).json()).alerts.filter((alert) => alert.kind === 'silence');

  try {
    assert.equal((await beat({ seq: 1000 }, { signed: false })).status, 401);
    assert.equal((await beat({ seq: 'x' })).status, 400);
    assert.equal((await beat({ seq: 1000 })).status, 200);
    assert.equal((await beat({ seq: 1000 })).status, 409, 'replay');
    assert.equal((await beat({ seq: 999 })).status, 409, 'older than the last');

    const status = await (await fetch(`${baseUrl}/status`)).json();
    assert.ok(status.heartbeat_age >= 0 && status.heartbeat_age < 5);
    assert.equal(status.heartbeat_interval, 30);
    assert.ok(store.recentActivity().some((item) => item.kind === 'heartbeat'));

    assert.equal(await checkHeartbeatSilence(store, Date.now() + 10_000), false, 'within three intervals');
    assert.equal(await checkHeartbeatSilence(store, Date.now() + 200_000), true, 'three beats missed');
    assert.equal((await silenceAlerts()).length, 1);
    assert.equal((await (await fetch(`${baseUrl}/status`)).json()).connection, 'lost');
    assert.equal(await checkHeartbeatSilence(store, Date.now() + 300_000), false, 'no duplicate while open');

    assert.equal((await beat({ seq: 1001 })).status, 200);
    assert.equal((await silenceAlerts()).length, 0, 'a new heartbeat clears the alert');
    const timeline = (await (await fetch(`${baseUrl}/timeline`)).json()).events;
    assert.ok(timeline.some((event) => event.trigger === 'heartbeat_silence' && event.resolved === true), 'history stays');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('shows a dry-run quarantine from ct105, releases it on two approvals, and presumes one on silence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-witness-l3-'));
  const store = new WitnessStore(path.join(directory, 'ledger.jsonl'));
  await store.initialize();
  const server = createWitnessServer(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const getJson = async (route) => (await fetch(`${baseUrl}${route}`)).json();
  const approve = (holder) => fetch(`${baseUrl}/quarantine/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ holder })
  });

  try {
    assert.equal((await getJson('/status')).quarantine.active, false);

    await store.recordLayerEvent({
      layer: 3,
      trigger: 'quarantine:locked',
      state: 'alert',
      summary: 'Layer 3 dry run: approved witness link settings changed',
      detail: {
        quarantine_id: 'q-test-1',
        reason: 'WITNESS_URL changed',
        dry_run: true,
        site_down: 'docker compose stop frontend',
        lockout: 'end login sessions\nrevoke banking sessions\nreboot ct105'
      },
      who: {}
    });
    const status = await getJson('/status');
    assert.equal(status.quarantine.active, true);
    assert.equal(status.quarantine.confirmed, true);
    assert.equal(status.quarantine.id, 'q-test-1');
    const locked = (await getJson('/timeline')).events.find((event) => event.trigger === 'quarantine:locked');
    assert.deepEqual(locked.detail.site_down, [{ cmd: 'docker compose stop frontend' }]);
    assert.equal(locked.detail.lockout.length, 3);
    assert.equal(locked.detail.dry_run, true);
    assert.ok((await getJson('/alerts')).alerts.some((alert) => alert.kind === 'quarantine'));

    assert.equal((await approve(7)).status, 400);
    assert.equal((await approve(0)).status, 200);
    assert.equal((await getJson('/status')).quarantine.holders[0].approved, true);
    assert.equal((await approve(0)).status, 200, 'the same holder twice is still one approval');
    assert.equal((await getJson('/status')).quarantine.active, true);
    assert.equal((await approve(1)).status, 200);
    const released = await getJson('/status');
    assert.equal(released.quarantine.active, false, 'two holders release it');
    assert.equal(released.quarantine.holders.every((holder) => !holder.approved), true);

    store.lastContactAt = Date.now() - 60_000;
    const presumed = (await getJson('/status')).quarantine;
    assert.equal(presumed.active, true);
    assert.equal(presumed.confirmed, false, 'presumed by the witness, not confirmed by the server');
    store.lastContactAt = Date.now();
    assert.equal((await getJson('/status')).quarantine.active, false, 'contact clears the presumption');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

const challengeFixture = async (name) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), `coc-witness-${name}-`));
  const store = new WitnessStore(path.join(directory, 'ledger.jsonl'));
  await store.initialize();
  const witnessEvent = async (id, transactionId, amountMinor = 50000) => {
    const event = { event_id: id, transaction_id: transactionId, type: 'deposit', amount_minor: amountMinor, occurred_at: '2026-10-14T10:00:00.000Z' };
    await store.prepare(event);
    await store.transition(id, 'commit');
    return event;
  };
  const bank = (rows) => async () => ({ ok: true, json: async () => ({ transactions: rows }) });
  const matching = (event) => ({ transaction_id: event.transaction_id, type: event.type, amount_minor: String(event.amount_minor), event_id: event.event_id });
  const cleanup = () => rm(directory, { recursive: true, force: true });
  return { store, witnessEvent, bank, matching, cleanup };
};

test('a challenge draws a crest and a trough that the auditor graph can pair', async () => {
  const { store, witnessEvent, bank, matching, cleanup } = await challengeFixture('pair');
  try {
    const event = await witnessEvent('11111111-1111-4111-8111-111111111111', 31);

    assert.equal(await challengeRecord(store, event, bank([matching(event)])), 'ok');
    assert.equal(await challengeRecord(store, event, bank([{ ...matching(event), amount_minor: '1' }])), 'mismatch');
    assert.equal(await challengeRecord(store, event, async () => { throw new Error('bank unreachable'); }), 'none');

    const activity = store.recentActivity();
    const asks = activity.filter((item) => item.kind === 'challenge_issued');
    assert.equal(asks.length, 3);
    for (const ask of asks) {
      assert.match(ask.detail, /^c-[0-9a-f]{8} record #31$/, 'the graph labels crests from "record #N"');
    }
    const answers = activity.filter((item) => item.kind === 'challenge_ok' || item.kind === 'challenge_mismatch');
    assert.equal(answers.length, 2, 'no answer for the unreachable bank, so that crest stays unanswered');
    for (const answer of answers) {
      assert.ok(asks.some((ask) => ask.detail.split(' ')[0] === answer.detail.split(' ')[0]), 'an answer shares its challenge id');
    }
    assert.ok(answers.some((item) => item.kind === 'challenge_mismatch' && item.detail.includes('changed amount')));
  } finally {
    await cleanup();
  }
});

test('challenge steps keep a crest and trough every interval and react to new transactions', async () => {
  const { store, witnessEvent, bank, matching, cleanup } = await challengeFixture('step');
  try {
    const first = await witnessEvent('22222222-2222-4222-8222-222222222222', 41);
    const options = (rows, extra = {}) => ({ fetchImpl: bank(rows), randomEveryMs: 30_000, random: () => 0, ...extra });
    const asks = () => store.recentActivity().filter((item) => item.kind === 'challenge_issued').length;

    await runChallengeStep(store, options([matching(first)], { nowMs: 1_000_000 }));
    assert.equal(asks(), 1, 'the first step challenges one random record straight away');
    assert.equal(store.challengedEventIds.has(first.event_id), true, 'records witnessed before start are not replayed as fresh');

    await runChallengeStep(store, options([matching(first)], { nowMs: 1_010_000 }));
    assert.equal(asks(), 1, 'nothing new and under 30 s since the last one');

    await runChallengeStep(store, options([matching(first)], { nowMs: 1_031_000 }));
    assert.equal(asks(), 2, 'a random challenge every 30 s even when idle');

    // New traffic: a record witnessed now is challenged within one step, not 30 s later.
    const second = await witnessEvent('33333333-3333-4333-8333-333333333333', 42);
    await runChallengeStep(store, options([matching(first), matching(second)], { nowMs: 1_033_000 }));
    const answered = store.recentActivity().filter((item) => item.kind === 'challenge_ok' && item.detail.includes('record #42'));
    assert.equal(answered.length, 1, 'the new transaction is verified against the bank straight away');

    // A bank that has not confirmed a fresh record yet is retried, then reported once it has had time.
    const third = await witnessEvent('44444444-4444-4444-8444-444444444444', 43);
    const before = asks();
    await runChallengeStep(store, options([matching(first), matching(second)], { nowMs: Date.now() + 1_000, randomEveryMs: 1e15 }));
    assert.equal(store.challengedEventIds.has(third.event_id), false, 'a missing row is retried while it settles');
    assert.equal(asks(), before, 'and nothing is drawn for it yet');
    await runChallengeStep(store, options([matching(first), matching(second)], { nowMs: Date.now() + 120_000, randomEveryMs: 1e15 }));
    assert.equal(store.challengedEventIds.has(third.event_id), true);
    assert.ok(store.recentActivity().some((item) => item.kind === 'challenge_mismatch' && item.detail.includes('record #43') && item.detail.includes('missing')));
  } finally {
    await cleanup();
  }
});

test('the verified-record line has a time to show', async () => {
  const { store, witnessEvent, cleanup } = await challengeFixture('verified');
  try {
    await witnessEvent('55555555-5555-4555-8555-555555555555', 51);
    const latest = store.latestCommittedEvent();
    assert.equal(typeof latest.updated_at, 'string');
    assert.equal(Number.isNaN(Date.parse(latest.updated_at)), false);
  } finally {
    await cleanup();
  }
});

test('a tamper is reported with the last healthy record and the window in which it happened', async () => {
  const { store, witnessEvent, bank, matching, cleanup } = await challengeFixture('window');
  const server = createWitnessServer(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const one = await witnessEvent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 10000);
    const two = await witnessEvent('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2, 20000);
    const three = await witnessEvent('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 3, 30000);
    const pass = (rows) => reconcileBankTransactions(store, bank(rows));
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    await pass([matching(one), matching(two), matching(three)]);
    assert.equal(store.status().bank_reconciliation.mismatches.length, 0);
    const beforeTamper = store.recordHealth.get(2).lastMatchedAt;
    assert.ok(beforeTamper > 0, 'a clean pass records when each record matched');

    await sleep(15);
    // Record 2 has its amount changed; record 3 disappears from the bank.
    await pass([matching(one), { ...matching(two), amount_minor: '999' }]);
    const found = (await (await fetch(`${baseUrl}/mismatches`)).json()).mismatches;
    const second = found.find((item) => item.seq === 2);
    const third = found.find((item) => item.seq === 3);

    assert.deepEqual(second.fields, ['amount']);
    assert.equal(second.previous_healthy.seq, 1, 'the nearest earlier record that matched');
    assert.deepEqual(second.previous_healthy.copy, { txn_id: 1, type: 'deposit', amount_minor: 10000, event_id: one.event_id });
    assert.equal(second.witness_copy.amount_minor, 20000);
    assert.equal(second.server_copy.amount_minor, 999);
    assert.ok(Math.abs(second.last_matched_time - beforeTamper / 1000) < 0.001, 'it matched at the earlier pass');
    assert.ok(second.first_seen_time > second.last_matched_time, 'and first differed at a later pass');

    assert.equal(third.issue, 'missing');
    assert.equal(third.previous_healthy.seq, 1, 'record 2 is not healthy, so the reference skips it');

    // Still tampered a pass later: the window start does not move.
    const firstSeen = store.recordHealth.get(2).firstSeenAt;
    await sleep(15);
    await pass([matching(one), { ...matching(two), amount_minor: '999' }]);
    assert.equal(store.recordHealth.get(2).firstSeenAt, firstSeen);

    // The very first record has no earlier record to refer to.
    await pass([{ ...matching(one), type: 'withdrawal' }, matching(two), matching(three)]);
    const firstRecord = store.status().bank_reconciliation.mismatches.find((item) => item.transaction_id === 1);
    assert.equal(firstRecord.previous_healthy, null);

    // Put back: the record is healthy again and its window closes.
    await pass([matching(one), matching(two), matching(three)]);
    assert.equal(store.status().bank_reconciliation.mismatches.length, 0);
    assert.equal(store.recordHealth.get(2).firstSeenAt, null);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await cleanup();
  }
});
