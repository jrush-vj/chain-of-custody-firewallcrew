import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WitnessStore } from './store.js';
import { recheckPendingBankRows, startChallenges } from './reconcile.js';
import { amountMinor } from './records.js';
import { evaluateHeartbeat, evidenceMismatches, receiveRows, recordCounts } from './banksync.js';
import { loadGuardConfig } from './guard/config.js';
import { createGuard } from './guard/guard.js';

const port = Number(process.env.WITNESS_PORT || 8787);
const bindHost = process.env.WITNESS_BIND_HOST || '127.0.0.1';
const nodeId = process.env.WITNESS_NODE_ID || '';
const hmacSecret = process.env.WITNESS_HMAC_SECRET || '';
const dataPath = process.env.WITNESS_DATA_PATH || '/var/lib/banking-witness/ledger.jsonl';
const maxBodyBytes = 16 * 1024;
const html = readFileSync(new URL('./auditor.html', import.meta.url), 'utf8');
// IBM Plex (OFL, fonts/OFL.txt) for the dashboard, read once; only these names are served.
const fonts = new Map(['mono-latin-400', 'mono-latin-500', 'sans-latin-400', 'sans-latin-500', 'sans-latin-600']
  .map((name) => `ibm-plex-${name}-normal.woff2`)
  .map((file) => [`/fonts/${file}`, readFileSync(new URL(`./fonts/${file}`, import.meta.url))]));
// Set on ct105-ai only after the Layer 1 command tripwire is installed there; otherwise the card reads IDLE.
const layer1Enabled = process.env.WITNESS_LAYER1_ENABLED === '1';
// ct105's monitor sends a heartbeat every negotiated interval; this many missed beats raise silence.
const heartbeatMissedLimit = Number(process.env.WITNESS_HEARTBEAT_MISSED || 3);
// Layer 3: this long without any signed request from ct105 and the witness presumes a quarantine.
const quarantineAfterS = Number(process.env.WITNESS_QUARANTINE_AFTER_S || 45);
const holderNames = ['SOC lead', 'Auditor', 'Compliance officer'];
// Soft containment (witness/guard). Off unless GUARD_ENABLED=1, so default behaviour is unchanged.
const guardConfig = loadGuardConfig();
// Same Layer 2 alert kinds the Cybersec auditor view groups under the Layer 2 card.
const LAYER2_KINDS = new Set(['sequence_gap', 'chain_break', 'bad_signature', 'unknown_key_id', 'entry_edited',
  'entry_deleted', 'entries_reordered', 'entry_replayed', 'late_entry', 'challenge_mismatch',
  'bad_challenge_signature', 'record_mismatch', 'non_monotonic_timestamp', 'silence', 'missed_challenge',
  'bad_heartbeat', 'replayed_heartbeat', 'balance_misreported', 'db_edited_without_log',
  'bob_response']);  // IBM Bob defender reports (deploy/local/bob), always state "normal"

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

// The dashboard's own buttons carry no secret, so a page on another site must not be able to press them for
// the operator's browser. Browsers always send Origin on a POST; scripts (curl) send none and are unaffected.
const isCrossOrigin = (request) => {
  const origin = request.headers.origin;
  return Boolean(origin) && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`;
};

// Layer 3 state, derived from what ct105 reported. A confirmed quarantine is an unresolved
// 'quarantine:locked' event that no later event releases. Without one, the witness still presumes a
// quarantine when ct105 has been silent past the threshold (only after the first contact).
const quarantineState = (store, nowMs = Date.now()) => {
  // bob:* events are IBM Bob's briefs about Layer 3, not ct105 state; they must not mask a quarantine.
  const latest = store.recentLayerEvents()
    .filter((item) => item.layer === 3 && !item.resolved && !item.trigger.startsWith('bob:') && !item.trigger.startsWith('guard:')).at(-1);
  const base = {
    after: quarantineAfterS,
    needed: 2,
    holders: holderNames.map((name, index) => ({ name, approved: store.holderApprovals.has(index) })),
    unlock_issued: store.holderApprovals.size >= 2,
    unverified: null
  };
  if (latest && latest.trigger === 'quarantine:locked') {
    return {
      ...base,
      active: true,
      since: toEpochSeconds(latest.recorded_at),
      confirmed: true,
      id: latest.detail.quarantine_id || null
    };
  }
  // With the guard on, silence alone no longer presumes a quarantine: the guard seals and asks a human.
  if (!guardConfig.guardEnabled && store.lastContactAt && nowMs - store.lastContactAt > quarantineAfterS * 1000) {
    return { ...base, active: true, since: store.lastContactAt / 1000, confirmed: false, id: null };
  }
  return { ...base, active: false, since: null, confirmed: false, id: null };
};

const auditorStatus = (store) => {
  const status = store.status();
  const reconciliation = status.bank_reconciliation;
  const hasVerifiedRecords = reconciliation.checked_transactions > 0;
  const checkedAt = toEpochSeconds(reconciliation.checked_at);
  const baseConnection =
    reconciliation.state === 'mismatch' || (reconciliation.state === 'ok' && hasVerifiedRecords)
      ? 'connected'
      : reconciliation.state === 'unavailable'
        ? 'lost'
        : 'waiting';
  // Heartbeat silence means the monitored host went quiet, whatever the bank API says.
  const connection = store.hasOpenLayerEvent('silence') ? 'lost' : baseConnection;
  const latest = store.committedRecords()
    .filter(({ event }) => store.bankPassedIds.has(event.transaction_id))
    .at(-1);
  return {
    integration_mode: 'banking-witness',
    platform_id: 'banking-system',
    connection,
    // Seconds since ct105's last heartbeat; null until the first one arrives.
    heartbeat_age: store.lastHeartbeatAt ? Math.max(0, (Date.now() - store.lastHeartbeatAt) / 1000) : null,
    heartbeat_interval: store.heartbeatIntervalS,
    records_verified: reconciliation.checked_transactions,
    last_verified: hasVerifiedRecords && latest
      ? { seq: latest.event.transaction_id, time: latest.committed_at }
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
    layers: { 1: layer1Enabled ? 'on' : 'off', 2: 'on', 3: 'on' },
    state: !status.healthy || reconciliation.state === 'mismatch'
      ? 'alert'
      : reconciliation.state === 'ok' && hasVerifiedRecords ? 'normal' : 'unknown',
    quarantine: quarantineState(store),
    bob_diagnosis: store.bobDiagnosis,
    records: recordCounts(store),
    bank_reconciliation: {
      state: reconciliation.state,
      checked_at: reconciliation.checked_at,
      last_successful_check: store.lastSuccessfulReconciliationAt,
      checked_transactions: reconciliation.checked_transactions,
      mismatch_count: reconciliation.mismatches.length,
      bank_calls_last_15m: reconciliation.bank_calls_last_15m,
      rate_limited: reconciliation.rate_limited,
      rate_limit_reason: reconciliation.rate_limit_reason,
      backoff_until: reconciliation.backoff_until,
      last_error: reconciliation.last_error || null
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
      kind: record.layer === 1 ? 'layer1_tripwire' : record.layer === 3 ? (String(record.trigger).startsWith('guard:') ? 'guard_alert' : 'quarantine') : record.kind,
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
  detail: record.layer === 3
    ? {
        ...record.detail,
        summary: record.summary,
        // The page lists these as {cmd} rows; they travel as newline-joined strings to keep the payload flat.
        site_down: String(record.detail.site_down || '').split('\n').filter(Boolean).map((cmd) => ({ cmd })),
        lockout: String(record.detail.lockout || '').split('\n').filter(Boolean).map((cmd) => ({ cmd }))
      }
    : { ...record.detail, summary: record.summary }
}));

const auditorMismatches = (store) => {
  const status = store.status();
  const caughtAt = toEpochSeconds(
    status.bank_reconciliation.state === 'unavailable'
      ? store.lastSuccessfulReconciliationAt
      : status.bank_reconciliation.checked_at
  ) || Date.now() / 1000;
  const reconciled = status.bank_reconciliation.mismatches.map((mismatch) => {
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
      issue: mismatch.issue,
      // The nearest earlier record that matched the bank in the same pass (null if there is none).
      previous_healthy: mismatch.previous_healthy
        ? {
            seq: mismatch.previous_healthy.transaction_id,
            copy: {
              txn_id: mismatch.previous_healthy.transaction_id,
              type: mismatch.previous_healthy.type,
              amount_minor: mismatch.previous_healthy.amount_minor,
              event_id: mismatch.previous_healthy.event_id
            },
            verified_time: toEpochSeconds(mismatch.previous_healthy.verified_at)
          }
        : null,
      // The tamper window: last time this record matched the bank, and the first time it did not.
      last_matched_time: toEpochSeconds(mismatch.matched_before),
      first_seen_time: toEpochSeconds(mismatch.first_seen_at)
    };
  });
  return mergeEvidence(store, reconciled);
};

// The bank row as the Layer 2 panel shows it. The extra columns appear only when they changed.
const rowView = (row, eventId) => row && {
  txn_id: row.id,
  type: row.type,
  amount_minor: amountMinor(row),
  event_id: eventId,
  status: row.status,
  from_account_id: row.from_account_id,
  to_account_id: row.to_account_id,
  timestamp: row.timestamp
};

// Findings from the witness's copies of the bank rows join the four-field reconciliation, so one
// record is one entry: a status or account change appears beside an amount change on the same record.
const mergeEvidence = (store, reconciled) => {
  const witnessedIds = new Map(store.committedEvents().map((event) => [event.transaction_id, event.event_id]));
  const merged = [...reconciled];
  for (const item of evidenceMismatches(store)) {
    const eventId = witnessedIds.get(item.seq);
    const unwitnessed = item.kind === 'db_edited_without_log';
    const witnessCopy = unwitnessed ? {} : rowView(item.before, eventId) || {};
    const serverCopy = item.kind === 'entry_deleted' ? null : rowView(item.after, eventId);
    const fields = unwitnessed ? ['type', 'amount', 'status', 'from_account_id', 'to_account_id', 'timestamp'] : item.fields;
    const existing = merged.find((entry) => entry.seq === item.seq);
    if (existing) {
      existing.fields = [...new Set([...existing.fields, ...fields])];
      existing.witness_copy = { ...witnessCopy, ...existing.witness_copy };
      if (existing.server_copy && serverCopy) existing.server_copy = { ...serverCopy, ...existing.server_copy };
      continue;
    }
    merged.push({
      source: 'bank_records',
      seq: item.seq,
      caught_time: toEpochSeconds(item.detected_at),
      caught_by: unwitnessed ? 'record copy check (never witnessed)' : 'record copy check',
      fields,
      witness_copy: witnessCopy,
      server_copy: serverCopy,
      issue: unwitnessed ? 'unwitnessed' : item.kind === 'entry_deleted' ? 'missing' : 'changed',
      previous_healthy: item.previous_healthy
        ? { seq: item.previous_healthy.id, copy: rowView(item.previous_healthy, witnessedIds.get(item.previous_healthy.id)), verified_time: toEpochSeconds(item.verified_at) }
        : null,
      // An unwitnessed row never matched anything, so it has no earlier match to report.
      last_matched_time: unwitnessed ? null : toEpochSeconds(item.matched_before),
      first_seen_time: toEpochSeconds(item.detected_at)
    });
  }
  return merged.sort((a, b) => a.seq - b.seq);
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
  if (![1, 2, 3].includes(event.layer)) {
    invalid('layer must be 1, 2 or 3');
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
  if (event.layer !== 2 && event.kind !== undefined) {
    invalid('Only Layer 2 events take a kind');
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

// Bob's diagnosis report. Bob's text is LLM output about attacker activity: untrusted, so it is only
// size-checked here and the dashboard renders it as plain text.
const validateDiagnosisReport = (payload) => {
  const invalid = (message) => {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  };
  const text = (value, max) => value === undefined || (typeof value === 'string' && value.length <= max);
  if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string') invalid('Report needs an id');
  if (!['running', 'done', 'failed'].includes(payload.state)) invalid('state must be running, done or failed');
  if (!text(payload.summary, 600) || !text(payload.cost, 20)) invalid('summary or cost too long');
  if (payload.seconds !== undefined && !Number.isFinite(payload.seconds)) invalid('seconds must be a number');
  const layers = payload.layers ?? [];
  if (!Array.isArray(layers) || layers.length > 3) invalid('layers must be up to 3 entries');
  for (const item of layers) {
    if (!item || typeof item !== 'object' || ![1, 2, 3].includes(item.layer) || !text(item.status, 40) ||
        !text(item.what, 1200) || !text(item.did, 1800) || !text(item.result, 800)) {
      invalid('each layer needs layer 1-3 and short status/what/did/result text');
    }
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

export const createWitnessServer = (store, guard = guardConfig.guardEnabled ? createGuard(store, guardConfig) : null) => {
  const server = createServer(async (request, response) => {
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
        if (isCrossOrigin(request)) {
          return sendJson(response, 403, { error: 'Cross-origin request refused' });
        }
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
      // Website "Diagnose with Bob" button: same shape as restore-request. The Bob defender polls with a
      // signed request. These use authorize(), not authorizeContact(): Bob polling is not ct105 contact.
      if (request.method === 'POST' && pathname === '/v1/diagnose-request') {
        await readBody(request);
        // Master switch: with Bob off, the button does nothing and no paid run is ever queued.
        if (!guardConfig.bobAllowed) return sendJson(response, 403, { error: 'Bob is disabled on this witness', bob: 'disabled' });
        // Each request starts a paid Bob run with root on the lab: only this dashboard may ask.
        if (isCrossOrigin(request)) {
          return sendJson(response, 403, { error: 'Cross-origin request refused' });
        }
        const now = Date.now();
        const busy = store.diagnoseRequest || store.bobDiagnosis?.state === 'running';
        // A request no defender finished within 15 min (defender stopped or crashed) no longer blocks the button.
        const stale = busy && now - Date.parse(store.bobDiagnosis?.requested_at) > 15 * 60_000;
        if (busy && !stale) {
          return sendJson(response, 409, { status: 'already_running', id: store.bobDiagnosis?.id });
        }
        if (now - store.lastDiagnoseRequestAt < 60_000) {
          const retry = Math.ceil((60_000 - (now - store.lastDiagnoseRequestAt)) / 1000);
          return sendJson(response, 429, { status: 'rate_limited', retry_after_s: retry });
        }
        store.lastDiagnoseRequestAt = now;
        store.diagnoseRequest = { id: randomUUID(), requested_at: new Date(now).toISOString() };
        store.bobDiagnosis = { ...store.diagnoseRequest, state: 'requested' };
        return sendJson(response, 202, { status: 'requested', id: store.diagnoseRequest.id });
      }
      if (request.method === 'GET' && pathname === '/v1/diagnose-pending') {
        authorize(request, pathname, '');
        return sendJson(response, 200, { pending: store.diagnoseRequest });
      }
      if (request.method === 'POST' && pathname === '/v1/diagnose-report') {
        const body = await readBody(request);
        authorize(request, pathname, body);
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          return sendJson(response, 400, { error: 'Invalid JSON body' });
        }
        validateDiagnosisReport(payload);
        if (!store.bobDiagnosis || payload.id !== store.bobDiagnosis.id) {
          return sendJson(response, 404, { error: 'No such diagnosis request' });
        }
        store.diagnoseRequest = null;  // picked up
        store.bobDiagnosis = {
          id: payload.id, requested_at: store.bobDiagnosis.requested_at, state: payload.state,
          updated_at: new Date().toISOString(), summary: payload.summary ?? '', cost: payload.cost ?? '',
          seconds: payload.seconds ?? null,
          layers: (payload.layers ?? []).map(({ layer, status, what, did, result }) => ({ layer, status, what, did, result }))
        };
        return sendJson(response, 200, { status: 'recorded' });
      }
      // Soft containment API (only when GUARD_ENABLED=1). Approvals need an approver token; no UI.
      if (guard && request.method === 'GET' && pathname === '/guard/state') {
        return sendJson(response, 200, guard.state());
      }
      if (guard && request.method === 'GET' && pathname === '/guard/reports') {
        return sendJson(response, 200, { reports: guard.listReports() });
      }
      const reportRoute = guard && request.method === 'GET' ? /^\/guard\/reports\/([A-Za-z0-9_-]{1,96})$/.exec(pathname) : null;
      if (reportRoute) {
        const result = guard.getReport(reportRoute[1]);
        if (result.status === 404) return sendJson(response, 404, { error: 'No such report' });
        // A report that fails verification is never shown.
        if (result.status === 409) return sendJson(response, 409, { error: 'Report failed verification against the ledger', problems: result.problems });
        return sendJson(response, 200, result.report);
      }
      const makeNarrative = guard && request.method === 'POST' ? /^\/guard\/incidents\/([A-Za-z0-9_-]{1,64})\/narrative$/.exec(pathname) : null;
      if (makeNarrative) {
        await readBody(request);
        if (!guard.authenticate(request.headers)) {
          return sendJson(response, guard.approversConfigured ? 401 : 403, { error: 'Approver authentication required' });
        }
        if (!guard.config.bobAllowed) return sendJson(response, 403, { error: 'Bob is disabled on this witness', bob: 'disabled' });
        if (guard.config.reportNarrative === 'off') return sendJson(response, 403, { error: 'Report narrative is off (REPORT_NARRATIVE)' });
        const report = await guard.generateReport(makeNarrative[1], { narrate: true });
        return report ? sendJson(response, 201, { report_id: report.report_id, narrative: report.narrative.status }) : sendJson(response, 404, { error: 'No such incident' });
      }
      const makeReport = guard && request.method === 'POST' ? /^\/guard\/incidents\/([A-Za-z0-9_-]{1,64})\/report$/.exec(pathname) : null;
      if (makeReport) {
        await readBody(request);
        if (!guard.authenticate(request.headers)) {
          return sendJson(response, guard.approversConfigured ? 401 : 403, { error: 'Approver authentication required' });
        }
        const report = await guard.generateReport(makeReport[1]);
        return report ? sendJson(response, 201, { report_id: report.report_id }) : sendJson(response, 404, { error: 'No such incident' });
      }
      if (guard && request.method === 'GET' && pathname === '/v1/guard-decision') {
        authorize(request, pathname, '');
        return sendJson(response, 200, { decision: guard.pendingDecision() });
      }
      if (guard && request.method === 'POST' && pathname === '/v1/guard-ack') {
        const body = await readBody(request);
        authorize(request, pathname, body);
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(response, 400, { error: 'Invalid JSON body' }); }
        if (typeof parsed.id === 'string') guard.acknowledge(parsed.id);
        return sendJson(response, 200, { status: 'ok' });
      }
      const approval = guard && request.method === 'POST' ? /^\/guard\/approvals\/([A-Za-z0-9_-]{1,64})$/.exec(pathname) : null;
      if (approval) {
        const body = await readBody(request);
        const approver = guard.authenticate(request.headers);
        if (!approver) {
          return sendJson(response, guard.approversConfigured ? 401 : 403,
            { error: guard.approversConfigured ? 'Approver authentication failed' : 'No approvers are configured' });
        }
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch { return sendJson(response, 400, { error: 'Invalid JSON body' }); }
        const incident = guard.decide(approval[1], approver, parsed.choice);
        return sendJson(response, 200, { status: 'recorded', incident: { id: incident.id, state: incident.state } });
      }
      // Key-holder approval for a confirmed quarantine. The quarantine is a dry run, so nothing on ct105
      // needs unlocking: two approvals only record a release on the witness.
      if (request.method === 'POST' && pathname === '/quarantine/approve') {
        if (isCrossOrigin(request)) {
          return sendJson(response, 403, { error: 'Cross-origin request refused' });
        }
        let payload = {};
        try {
          payload = JSON.parse((await readBody(request)) || '{}');
        } catch {
          return sendJson(response, 400, { error: 'Invalid JSON body' });
        }
        const holder = payload.holder;
        if (!Number.isInteger(holder) || holder < 0 || holder >= holderNames.length) {
          return sendJson(response, 400, { error: 'holder must be 0, 1 or 2' });
        }
        const state = quarantineState(store);
        if (!state.active || !state.confirmed) {
          return sendJson(response, 409, { status: 'nothing_to_release', reason: 'No confirmed quarantine is waiting for approval' });
        }
        store.holderApprovals.add(holder);
        const approvals = store.holderApprovals.size;
        if (approvals >= 2) {
          store.holderApprovals.clear();
          // Website approval only ever records the vote: the witness cannot reach back into ct105.
          // A real (non-dry-run) lockout is only actually reversed by running unlock.sh with 2 of the
          // 3 printed keys on ct105 itself; say that plainly instead of implying this button did it.
          const lockedEvent = store.recentLayerEvents().find(
            (item) => item.layer === 3 && item.trigger === 'quarantine:locked' && item.detail.quarantine_id === state.id
          );
          const wasReal = lockedEvent && lockedEvent.detail.dry_run === false;
          await store.recordLayerEvent({
            layer: 3,
            trigger: 'quarantine:released',
            state: 'normal',
            summary: wasReal
              ? 'two key-holders approved on the website; the demo account on ct105 is only really restored by running unlock.sh there with 2 of the 3 keys'
              : 'quarantine released after two key-holder approvals (dry run: nothing had been locked)',
            detail: { quarantine_id: state.id || '', dry_run: !wasReal, website_approval_only: wasReal },
            who: {}
          });
        }
        return sendJson(response, 200, { status: 'recorded', approvals });
      }
      if (request.method === 'GET' && fonts.has(pathname)) {
        response.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=86400',
          'x-content-type-options': 'nosniff' });
        response.end(fonts.get(pathname));
        return;
      }
      if (request.method === 'GET' && pathname === '/') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src 'self'; connect-src 'self'",
          'x-content-type-options': 'nosniff'
        });
        response.end(html);
        return;
      }
      if (
        request.method !== 'POST' ||
        !['/v1/prepare', '/v1/commit', '/v1/abort', '/v1/layer-events', '/v1/heartbeat', '/v1/records'].includes(pathname)
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
      if (pathname === '/v1/records') {
        return sendJson(response, 200, await receiveRows(store, payload.rows));
      }
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
        // A heartbeat may carry a view of the bank's rows. A bad view must not undo the heartbeat itself.
        const reply = { status: 'ok', interval_s: store.updateHeartbeatInterval() };
        if (payload.bank !== undefined) {
          try {
            reply.sync = await evaluateHeartbeat(store, payload.bank);
            // Pending ids include anything a budget or back-off skipped on an earlier beat, so they retry here.
            if (store.bankPendingIds.size > 0) {
              await recheckPendingBankRows(store);
              reply.interval_s = store.updateHeartbeatInterval();
            }
          } catch (error) {
            if (!error.statusCode) throw error;
            reply.sync_error = error.message;
          }
        }
        store.lastHeartbeatPromisedS = reply.interval_s;
        return sendJson(response, 200, reply);
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
          who: payload.who ?? {},
          // Posted by the monitored host, so only the host vouches for it. The guard never treats it as
          // witness-established evidence (a root attacker holds the shared secret and could forge it).
          origin: 'box'
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
  server.guard = guard;
  return server;
};

// Raises a Layer 2 'silence' alert once the monitored host has missed too many heartbeats. It only
// arms after the first heartbeat, so a witness restart does not alert before ct105 has had a chance to beat.
export const checkHeartbeatSilence = async (store, nowMs = Date.now()) => {
  if (store.integrityError || !store.lastHeartbeatAt || store.hasOpenLayerEvent('silence')) {
    return false;
  }
  const silentS = (nowMs - store.lastHeartbeatAt) / 1000;
  const promisedIntervalS = store.lastHeartbeatPromisedS;
  if (silentS <= promisedIntervalS * heartbeatMissedLimit) {
    return false;
  }
  await store.recordLayerEvent({
    layer: 2,
    trigger: 'heartbeat_silence',
    kind: 'silence',
    state: 'alert',
    summary: `no heartbeat from the monitored host for ${Math.round(silentS)} s`,
    detail: { seconds: Math.round(silentS), expected_every_s: promisedIntervalS },
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
  startChallenges(store);
  if (server.guard) {
    setInterval(() => {
      try { server.guard.tick(); } catch (error) { console.error('Guard tick failed:', error.message); }
    }, 5_000);
  }
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
