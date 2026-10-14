import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WitnessStore } from './store.js';
import { startBankReconciliation } from './reconcile.js';

const port = Number(process.env.WITNESS_PORT || 8787);
const bindHost = process.env.WITNESS_BIND_HOST || '127.0.0.1';
const nodeId = process.env.WITNESS_NODE_ID || '';
const hmacSecret = process.env.WITNESS_HMAC_SECRET || '';
const dataPath = process.env.WITNESS_DATA_PATH || '/var/lib/banking-witness/ledger.jsonl';
const maxBodyBytes = 16 * 1024;
const html = readFileSync(new URL('./auditor.html', import.meta.url), 'utf8');
// Set on ct105-ai only after the Layer 1 command tripwire is installed there; otherwise the card reads IDLE.
const layer1Enabled = process.env.WITNESS_LAYER1_ENABLED === '1';
// ct105's monitor sends a heartbeat every interval; this many missed beats raise a Layer 2 'silence' alert.
const heartbeatIntervalS = Number(process.env.WITNESS_HEARTBEAT_S || 30);
const heartbeatMissedLimit = Number(process.env.WITNESS_HEARTBEAT_MISSED || 3);
// Same Layer 2 alert kinds the Cybersec auditor view groups under the Layer 2 card.
const LAYER2_KINDS = new Set(['sequence_gap', 'chain_break', 'bad_signature', 'unknown_key_id', 'entry_edited',
  'entry_deleted', 'entries_reordered', 'entry_replayed', 'late_entry', 'challenge_mismatch',
  'bad_challenge_signature', 'record_mismatch', 'non_monotonic_timestamp', 'silence', 'missed_challenge',
  'bad_heartbeat', 'replayed_heartbeat', 'balance_misreported', 'db_edited_without_log']);

const readBody = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(JSON.stringify(payload));
};

const toEpochSeconds = (value) => (value ? Date.parse(value) / 1000 : null);

const auditorStatus = (store) => {
  const status = store.status();
  const reconciliation = status.bank_reconciliation;
  const hasVerifiedRecords = reconciliation.checked_transactions > 0;
  const successfulCheck = reconciliation.state === 'unavailable'
    ? store.lastSuccessfulReconciliationAt
    : reconciliation.checked_at;
  const checkedAt = hasVerifiedRecords ? toEpochSeconds(successfulCheck) : null;
  const baseConnection =
    reconciliation.state === 'mismatch' || (reconciliation.state === 'ok' && hasVerifiedRecords)
      ? 'connected'
      : reconciliation.state === 'unavailable'
        ? 'lost'
        : 'waiting';
  // Heartbeat silence means the monitored host went quiet, whatever the bank API says.
  const connection = store.hasOpenLayerEvent('silence') ? 'lost' : baseConnection;
  const latest = store.latestCommittedEvent();
  return {
    integration_mode: 'banking-witness',
    platform_id: 'banking-system',
    connection,
    // Seconds since ct105's last heartbeat; null until the first one arrives.
    heartbeat_age: store.lastHeartbeatAt ? Math.max(0, (Date.now() - store.lastHeartbeatAt) / 1000) : null,
    heartbeat_interval: heartbeatIntervalS,
    records_verified: reconciliation.checked_transactions,
    last_verified: hasVerifiedRecords && latest
      ? { seq: latest.transaction_id, time: latest.updated_at }
      : null,
    last_sweep: checkedAt,
    server_time: Date.now() / 1000,
    checks: {
      A: status.healthy ? 'green' : 'red',
      B: reconciliation.state === 'ok'
        ? hasVerifiedRecords ? 'green' : 'unknown'
        : reconciliation.state === 'mismatch' ? 'red' : 'unknown',
      C: 'unknown'
    },
    layers: { 1: layer1Enabled ? 'on' : 'off', 2: 'on', 3: 'off' },
    state: !status.healthy || reconciliation.state === 'mismatch'
      ? 'alert'
      : reconciliation.state === 'ok' && hasVerifiedRecords ? 'normal' : 'unknown',
    // Layer 3 (quarantine) is not deployed on the banking host; the auditor view still needs this shape.
    quarantine: { active: false, since: null, confirmed: false, id: null, unverified: null, after: 45, needed: 2, holders: [], unlock_issued: false },
    bank_reconciliation: {
      state: reconciliation.state,
      checked_at: hasVerifiedRecords ? successfulCheck : null,
      last_successful_check: store.lastSuccessfulReconciliationAt,
      checked_transactions: reconciliation.checked_transactions,
      mismatch_count: reconciliation.mismatches.length
    }
  };
};

const auditorAlerts = (store) => {
  const status = store.status();
  const checkedAt = toEpochSeconds(
    status.bank_reconciliation.state === 'unavailable'
      ? store.lastSuccessfulReconciliationAt
      : status.bank_reconciliation.checked_at
  ) || Date.now() / 1000;
  const alerts = status.bank_reconciliation.mismatches.map((mismatch) => ({
    kind: 'record_mismatch',
    ref: String(mismatch.transaction_id),
    tamper_type: mismatch.issue,
    detail: `Transaction ${mismatch.transaction_id}: ${mismatch.issue.replaceAll('_', ' ')}`,
    time: checkedAt,
    resolved: 0
  }));
  if (!status.healthy) {
    alerts.unshift({
      kind: 'chain_break',
      ref: 'ledger',
      tamper_type: 'entry_edited',
      detail: 'Witness JSONL ledger integrity validation failed; writes are disabled.',
      time: Date.now() / 1000,
      resolved: 0
    });
  }
  for (const record of store.recentLayerEvents()) {
    if (record.state !== 'alert' || record.resolved) {
      continue;
    }
    alerts.push({
      kind: record.layer === 1 ? 'layer1_tripwire' : record.kind,
      ref: record.trigger,
      tamper_type: record.trigger,
      detail: record.summary,
      time: toEpochSeconds(record.recorded_at),
      resolved: 0
    });
  }
  return alerts;
};

const auditorLayerEvents = (store) => store.recentLayerEvents().map((record) => ({
  layer: record.layer,
  trigger: record.trigger,
  state: record.state,
  time: toEpochSeconds(record.recorded_at),
  who: record.who || {},
  resolved: Boolean(record.resolved),
  detail: { ...record.detail, summary: record.summary }
}));

const auditorMismatches = (store) => {
  const status = store.status();
  const caughtAt = toEpochSeconds(
    status.bank_reconciliation.state === 'unavailable'
      ? store.lastSuccessfulReconciliationAt
      : status.bank_reconciliation.checked_at
  ) || Date.now() / 1000;
  return status.bank_reconciliation.mismatches.map((mismatch) => {
    const changedFields = mismatch.fields || [];
    const witnessCopy = {
      txn_id: mismatch.transaction_id,
      type: mismatch.witnessed_type,
      amount_minor: mismatch.witnessed_amount_minor,
      event_id: mismatch.witnessed_event_id
    };
    const serverCopy = mismatch.issue === 'missing'
      ? null
      : {
          txn_id: mismatch.transaction_id,
          type: mismatch.bank_type,
          amount_minor: mismatch.bank_amount_minor,
          event_id: mismatch.bank_event_id
        };
    return {
      source: 'bank_reconciliation',
      seq: mismatch.transaction_id,
      caught_time: caughtAt,
      caught_by: 'bank transaction reconciliation',
      fields: changedFields,
      witness_copy: witnessCopy,
      server_copy: serverCopy,
      issue: mismatch.issue
    };
  });
};

const validateLayerEvent = (event) => {
  const fields = ['layer', 'trigger', 'state', 'kind', 'summary', 'detail', 'who'];
  const required = ['layer', 'trigger', 'state', 'summary'];
  const detail = event?.detail ?? {};
  const who = event?.who ?? {};
  const invalid = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  };
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    invalid('Layer event must be a JSON object');
  }
  if (Object.keys(event).some((field) => !fields.includes(field)) || required.some((field) => !Object.hasOwn(event, field))) {
    invalid('Layer event has missing or unknown fields');
  }
  if (![1, 2].includes(event.layer)) {
    invalid('layer must be 1 or 2');
  }
  if (typeof event.trigger !== 'string' || !/^[a-z0-9_:.-]{1,80}$/.test(event.trigger)) {
    invalid('trigger must be a short lowercase identifier');
  }
  if (!['alert', 'normal'].includes(event.state)) {
    invalid('state must be alert or normal');
  }
  if (event.layer === 2 && !LAYER2_KINDS.has(event.kind)) {
    invalid('Layer 2 events need a known kind');
  }
  if (event.layer === 1 && event.kind !== undefined) {
    invalid('Layer 1 events do not take a kind');
  }
  if (typeof event.summary !== 'string' || event.summary.length === 0 || event.summary.length > 200) {
    invalid('summary must be 1 to 200 characters');
  }
  if (
    typeof detail !== 'object' || Array.isArray(detail) || Object.keys(detail).length > 20 ||
    Object.values(detail).some((value) => !(
      (typeof value === 'string' && value.length <= 4000) ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'boolean'
    ))
  ) {
    invalid('detail must be a flat object of up to 20 short values');
  }
  if (
    typeof who !== 'object' || Array.isArray(who) || Object.keys(who).length > 10 ||
    Object.values(who).some((value) => !(
      (typeof value === 'string' && value.length <= 200) ||
      (typeof value === 'number' && Number.isFinite(value))
    ))
  ) {
    invalid('who must be a flat object of up to 10 short values');
  }
};

const validateEvent = (event) => {
  const expectedFields = ['event_id', 'transaction_id', 'type', 'amount_minor', 'occurred_at'];
  if (
    !event ||
    Object.keys(event).some((field) => !expectedFields.includes(field)) ||
    expectedFields.some((field) => !Object.hasOwn(event, field)) ||
    typeof event.event_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.event_id) ||
    !Number.isSafeInteger(event.transaction_id) ||
    event.transaction_id <= 0 ||
    !['deposit', 'withdrawal', 'transfer', 'external_incoming', 'external_outgoing'].includes(event.type) ||
    !Number.isSafeInteger(event.amount_minor) ||
    event.amount_minor <= 0 ||
    typeof event.occurred_at !== 'string' ||
    Number.isNaN(Date.parse(event.occurred_at))
  ) {
    const error = new Error('Invalid transaction evidence event');
    error.statusCode = 400;
    throw error;
  }
};

const authorize = (request, pathname, body) => {
  if (!hmacSecret || !nodeId) {
    throw new Error('Witness authentication is not configured');
  }
  const timestamp = request.headers['x-witness-timestamp'];
  const suppliedNodeId = request.headers['x-witness-node'];
  const suppliedSignature = request.headers['x-witness-signature'];
  const timestampValue = Number(timestamp);
  if (
    suppliedNodeId !== nodeId ||
    !Number.isSafeInteger(timestampValue) ||
    Math.abs(Date.now() - timestampValue) > 60_000 ||
    typeof suppliedSignature !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(suppliedSignature)
  ) {
    const error = new Error('Unauthorized witness request');
    error.statusCode = 401;
    throw error;
  }
  const expected = createHmac('sha256', hmacSecret)
    .update(`${request.method}\n${pathname}\n${timestamp}\n${body}`)
    .digest();
  const provided = Buffer.from(suppliedSignature, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    const error = new Error('Unauthorized witness request');
    error.statusCode = 401;
    throw error;
  }
};

export const createWitnessServer = (store) =>
  createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    // A signed request that passes authorization is proof of contact with ct105.
    const authorizeContact = (req, requestPath, body) => {
      authorize(req, requestPath, body);
      store.lastContactAt = Date.now();
    };
    try {
      if (request.method === 'GET' && pathname === '/health') {
        return sendJson(response, store.status().healthy ? 200 : 503, {
          status: store.status().healthy ? 'ok' : 'error',
          ...store.status()
        });
      }
      if (request.method === 'GET' && pathname === '/v1/status') {
        return sendJson(response, 200, store.status());
      }
      if (request.method === 'GET' && pathname === '/v1/events') {
        return sendJson(response, 200, store.recentEvents());
      }
      if (request.method === 'GET' && pathname === '/status') {
        return sendJson(response, 200, auditorStatus(store));
      }
      if (request.method === 'GET' && pathname === '/alerts') {
        return sendJson(response, 200, { alerts: auditorAlerts(store) });
      }
      if (request.method === 'GET' && pathname === '/timeline') {
        const transactionEvents = store.recentEvents().map((event) => ({
          layer: 2,
          trigger: `transaction:${event.state}`,
          state: 'normal',
          time: event.updated_at || event.occurred_at,
          detail: {
            transaction_id: event.transaction_id,
            type: event.type,
            amount_minor: event.amount_minor
          }
        }));
        const events = [...transactionEvents, ...auditorLayerEvents(store)];
        return sendJson(response, 200, { events });
      }
      if (request.method === 'GET' && pathname === '/mismatches') {
        return sendJson(response, 200, { mismatches: auditorMismatches(store) });
      }
      if (request.method === 'GET' && pathname === '/activity') {
        const rawSinceId = new URL(request.url, 'http://localhost').searchParams.get('since_id') || '0';
        if (!/^\d+$/.test(rawSinceId) || !Number.isSafeInteger(Number(rawSinceId))) {
          return sendJson(response, 400, { error: 'since_id must be a non-negative integer' });
        }
        return sendJson(response, 200, {
          activity: store.recentActivity(Number(rawSinceId), 200)
        });
      }
      // Website "Restore to normal" button. It queues one fixed action for ct105 to pick up; it takes
      // no parameters, and ct105 polls for it with a signed request, so nothing on ct105 is exposed.
      if (request.method === 'POST' && pathname === '/v1/restore-request') {
        await readBody(request);
        const now = Date.now();
        if (store.restoreRequest) {
          return sendJson(response, 409, { status: 'already_requested', id: store.restoreRequest.id });
        }
        if (now - store.lastRestoreRequestAt < 60_000) {
          const retry = Math.ceil((60_000 - (now - store.lastRestoreRequestAt)) / 1000);
          return sendJson(response, 429, { status: 'rate_limited', retry_after_s: retry });
        }
        store.lastRestoreRequestAt = now;
        store.restoreRequest = { id: randomUUID(), requested_at: new Date(now).toISOString() };
        store.recordActivity('restore_requested', 'restore to normal requested from the website; waiting for ct105');
        return sendJson(response, 202, { status: 'requested', id: store.restoreRequest.id });
      }
      if (request.method === 'GET' && pathname === '/v1/restore-pending') {
        authorizeContact(request, pathname, '');
        return sendJson(response, 200, { pending: store.restoreRequest });
      }
      if (request.method === 'POST' && pathname === '/v1/restore-ack') {
        const body = await readBody(request);
        authorizeContact(request, pathname, body);
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          return sendJson(response, 400, { error: 'Invalid JSON body' });
        }
        if (!store.restoreRequest || payload.id !== store.restoreRequest.id) {
          return sendJson(response, 404, { error: 'No such restore request' });
        }
        const ok = payload.ok === true;
        const summary = String(payload.summary || (ok ? 'restore finished' : 'restore failed')).slice(0, 300);
        store.restoreRequest = null;
        if (ok) {
          await store.resolveLayerEvents('restore completed');
        }
        store.recordActivity(ok ? 'restore_completed' : 'restore_failed', summary);
        return sendJson(response, 200, { status: 'acknowledged' });
      }
      if (request.method === 'POST' && pathname === '/quarantine/approve') {
        await readBody(request);
        return sendJson(response, 409, {
          status: 'disabled',
          dry_run: true,
          reason: 'Layer 3 quarantine is not integrated; no system actions are available.'
        });
      }
      if (request.method === 'GET' && pathname === '/') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
          'x-content-type-options': 'nosniff'
        });
        response.end(html);
        return;
      }
      if (
        request.method !== 'POST' ||
        !['/v1/prepare', '/v1/commit', '/v1/abort', '/v1/layer-events', '/v1/heartbeat'].includes(pathname)
      ) {
        return sendJson(response, 404, { error: 'Not found' });
      }

      const body = await readBody(request);
      authorizeContact(request, pathname, body);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        const error = new Error('Invalid JSON body');
        error.statusCode = 400;
        throw error;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        const error = new Error('Request body must be a JSON object');
        error.statusCode = 400;
        throw error;
      }

      let result;
      if (pathname === '/v1/heartbeat') {
        // seq must rise: ct105 uses its clock in ms, so it keeps rising across monitor restarts.
        if (!Number.isSafeInteger(payload.seq) || payload.seq <= 0) {
          return sendJson(response, 400, { error: 'seq must be a positive integer' });
        }
        if (payload.seq <= store.lastHeartbeatSeq) {
          store.recordActivity('heartbeat_rejected', `replayed heartbeat seq ${payload.seq}`);
          return sendJson(response, 409, { error: 'Replayed heartbeat' });
        }
        store.lastHeartbeatSeq = payload.seq;
        store.lastHeartbeatAt = Date.now();
        store.recordActivity('heartbeat', `heartbeat from ${nodeId}`);
        if (store.hasOpenLayerEvent('silence')) {
          await store.resolveLayerEvents('heartbeat resumed', { layer: 2, kind: 'silence' });
        }
        return sendJson(response, 200, { status: 'ok', interval_s: heartbeatIntervalS });
      }
      if (pathname === '/v1/layer-events') {
        validateLayerEvent(payload);
        const record = await store.recordLayerEvent({
          layer: payload.layer,
          trigger: payload.trigger,
          state: payload.state,
          ...(payload.layer === 2 && { kind: payload.kind }),
          summary: payload.summary,
          detail: payload.detail ?? {},
          who: payload.who ?? {}
        });
        return sendJson(response, 200, { status: 'recorded', seq: record.seq });
      }
      if (pathname === '/v1/prepare') {
        validateEvent(payload.event);
        const event = {
          event_id: payload.event.event_id,
          transaction_id: payload.event.transaction_id,
          type: payload.event.type,
          amount_minor: payload.event.amount_minor,
          occurred_at: payload.event.occurred_at
        };
        result = await store.prepare(event);
      } else {
        if (!payload || typeof payload.event_id !== 'string') {
          const error = new Error('event_id is required');
          error.statusCode = 400;
          throw error;
        }
        result = await store.transition(payload.event_id, pathname === '/v1/commit' ? 'commit' : 'abort');
      }
      return sendJson(response, 200, result);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) {
        console.error('Witness request failed:', error.message);
      }
      return sendJson(response, statusCode, { error: statusCode >= 500 ? 'Witness request failed' : error.message });
    }
  });

// Raises a Layer 2 'silence' alert once the monitored host has missed too many heartbeats. It only
// arms after the first heartbeat, so a witness restart does not alert before ct105 has had a chance to beat.
export const checkHeartbeatSilence = async (store, nowMs = Date.now()) => {
  if (store.integrityError || !store.lastHeartbeatAt || store.hasOpenLayerEvent('silence')) {
    return false;
  }
  const silentS = (nowMs - store.lastHeartbeatAt) / 1000;
  if (silentS <= heartbeatIntervalS * heartbeatMissedLimit) {
    return false;
  }
  await store.recordLayerEvent({
    layer: 2,
    trigger: 'heartbeat_silence',
    kind: 'silence',
    state: 'alert',
    summary: `no heartbeat from the monitored host for ${Math.round(silentS)} s`,
    detail: { seconds: Math.round(silentS), expected_every_s: heartbeatIntervalS },
    who: {}
  });
  return true;
};

const start = async () => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('WITNESS_PORT must be a valid TCP port');
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(nodeId) || hmacSecret.length < 32) {
    throw new Error('Configure a valid WITNESS_NODE_ID and a WITNESS_HMAC_SECRET of at least 32 characters');
  }
  const store = new WitnessStore(dataPath);
  try {
    await store.initialize();
  } catch (error) {
    console.error('Witness ledger integrity validation failed; entering read-only alert mode:', error.message);
  }
  const server = createWitnessServer(store);
  startBankReconciliation(store);
  setInterval(() => {
    checkHeartbeatSilence(store).catch((error) => console.error('Heartbeat silence check failed:', error.message));
  }, 5_000);
  server.listen(port, bindHost, () => {
    console.log(`Witness listening on ${bindHost}:${port}; ledger ${dataPath}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((error) => {
    console.error('Witness failed to start:', error);
    process.exit(1);
  });
}
