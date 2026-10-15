import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

const ZERO_HASH = '0'.repeat(64);
const BANK_CALL_WINDOW_MS = 15 * 60 * 1000;
const BANK_CALL_BUDGET = 60;
const BANK_HEARTBEAT_HIGH_WATER = BANK_CALL_BUDGET * 0.8;
const BANK_HEARTBEAT_LOW_WATER = BANK_CALL_BUDGET * 0.5;
const clampHeartbeatInterval = (value) => Math.max(15, Math.min(120, Math.round(value)));

const recordHash = (record) =>
  createHash('sha256').update(JSON.stringify(record)).digest('hex');

export class WitnessStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.records = [];
    this.events = new Map();
    this.layerEvents = [];
    // Activity feed: ledger records plus live heartbeat and challenge entries. Ids keep rising across
    // restarts because the counter starts from the clock, so the auditor's since_id polling still works.
    this.activity = [];
    this.activityCounter = Date.now();
    this.lastHeartbeatAt = null;       // ms; heartbeats are held in memory, not the ledger
    this.lastHeartbeatSeq = 0;
    this.heartbeatIntervalS = clampHeartbeatInterval(Number(process.env.WITNESS_HEARTBEAT_S) || 30);
    this.lastHeartbeatPromisedS = this.heartbeatIntervalS;
    this.lastContactAt = null;         // ms; any signed request from ct105 counts as contact
    this.holderApprovals = new Set();  // key holders who approved the current quarantine (indexes)
    this.challengedEventIds = new Set(); // committed records already shown as a challenge on the graph
    // Per witnessed transaction: when it last matched the bank, and when it first stopped matching.
    // In memory, so after a restart the window starts again from the first pass.
    this.recordHealth = new Map();
    // Copies of the bank's transaction rows (allowlisted columns only), keyed by id, first seen version.
    this.copies = new Map();
    this.baselineMaxId = null;   // rows up to this id existed before copying began; later rows must be witnessed
    this.baselineComplete = false; // true once every baseline row has been copied
    this.bankView = null;        // the latest summary ct105 sent with a heartbeat
    this.currentHashes = new Map(); // id -> { hash, at } as last seen in the bank, from sweeps and received rows
    this.copyMatchedAt = new Map(); // id -> ms: the last time the bank row matched its copy
    this.challengeBaselineSet = false;
    this.lastRandomChallengeAt = 0;
    this.restoreRequest = null;        // one pending website restore, picked up by ct105
    this.lastRestoreRequestAt = 0;     // rate limit: one request per minute
    this.queue = Promise.resolve();
    this.integrityError = null;
    this.lastSuccessfulReconciliationAt = null;
    this.bankFindings = new Map();
    // Record ids a heartbeat asked the bank to re-check (a suspect, or a finding whose row is back).
    // An id stays here until the bank gives a definitive answer, so a budget or back-off skip is retried.
    this.bankPendingIds = new Set();
    this.bankPassedIds = new Set();
    this.bankCallLog = [];
    this.bank429Log = [];
    this.bankBackoffUntil = 0;
    this.bankBackoffReason = null;
    this.bankBudgetLimitedAt = null;
    this.bankPressureSince = this.heartbeatIntervalS >= 60 ? Date.now() : null;
    this.lastBankCheckAt = null;
    this.lastBankCallFailed = false;
    this.lastBankCallError = null;
    this.reconciliation = {
      state: 'checking',
      checked_at: null,
      checked_transactions: 0,
      mismatches: [],
      bank_calls_last_15m: 0,
      rate_limited: false,
      rate_limit_reason: null,
      backoff_until: null
    };
  }

  async initialize() {
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      let contents;
      try {
        contents = await readFile(this.filePath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') {
          return;
        }
        throw error;
      }
      await chmod(this.filePath, 0o600);

      if (contents && !contents.endsWith('\n')) {
        throw new Error('Witness ledger ends with an incomplete record');
      }
      const lines = contents.split('\n').filter(Boolean);
      let previousHash = ZERO_HASH;
      for (let index = 0; index < lines.length; index += 1) {
        let record;
        try {
          record = JSON.parse(lines[index]);
        } catch {
          throw new Error(`Witness ledger contains invalid JSON at line ${index + 1}`);
        }
        const expected = {
          seq: index + 1,
          previous_hash: previousHash,
          action: record.action,
          payload: record.payload,
          recorded_at: record.recorded_at
        };
        const expectedHash = recordHash(expected);
        if (
          !['prepare', 'commit', 'abort', 'layer_event', 'layer_resolve', 'record_copy', 'sync_baseline'].includes(record.action) ||
          record.seq !== expected.seq ||
          record.previous_hash !== expected.previous_hash ||
          record.hash !== expectedHash
        ) {
          throw new Error(`Witness ledger integrity check failed at sequence ${index + 1}`);
        }
        this.applyRecord(record);
        this.records.push(record);
        previousHash = record.hash;
      }
    } catch (error) {
      this.records = [];
      this.events.clear();
      this.layerEvents = [];
      this.activity = [];
      this.copies.clear();
      this.baselineMaxId = null;
      this.baselineComplete = false;
      this.integrityError = error.message;
      throw error;
    }
  }

  assertHealthy() {
    if (this.integrityError) {
      const error = new Error('Witness ledger integrity validation failed; writes are disabled');
      error.statusCode = 503;
      throw error;
    }
  }

  applyRecord(record) {
    this.applyState(record);
    this.noteActivity(record);
  }

  noteActivity(record) {
    if (['layer_resolve', 'record_copy', 'sync_baseline'].includes(record.action)) {
      return;
    }
    if (record.action === 'layer_event') {
      this.pushActivity(`layer${record.payload.layer}_${record.payload.trigger}`, record.payload.summary, record.recorded_at);
      return;
    }
    const event = this.events.get(record.payload.event_id)?.event;
    const detail = event
      ? `Transaction ${event.transaction_id} ${record.action} (${event.type}, ${event.amount_minor} minor units)`
      : `Transaction event ${record.payload.event_id} ${record.action}`;
    this.pushActivity(`witness_${record.action}`, detail, record.recorded_at);
  }

  pushActivity(kind, detail, at = new Date().toISOString()) {
    this.activityCounter += 1;
    this.activity.push({ id: this.activityCounter, time: Date.parse(at) / 1000, kind, detail });
    if (this.activity.length > 500) {
      this.activity.splice(0, this.activity.length - 500);
    }
  }

  recordActivity(kind, detail) {
    this.pushActivity(kind, detail);
  }

  applyState(record) {
    if (record.action === 'sync_baseline') {
      this.baselineMaxId = record.payload.max_id;
      if (record.payload.complete) this.baselineComplete = true;
      return;
    }
    if (record.action === 'record_copy') {
      for (const row of record.payload.rows) {
        this.copies.set(row.id, { ...row, baseline: Boolean(record.payload.baseline), copied_at: record.recorded_at });
      }
      return;
    }
    if (record.action === 'layer_resolve') {
      // Resolves the layer events recorded before it, optionally only one layer or kind; the history stays.
      const { layer, kind, record: recordId } = record.payload;
      for (const item of this.layerEvents) {
        if (item.id < record.seq && (!layer || item.layer === layer) && (!kind || item.kind === kind)
            && (recordId === undefined || item.detail?.record === recordId)) {
          item.resolved = true;
        }
      }
      return;
    }
    if (record.action === 'layer_event') {
      this.layerEvents.push({ id: record.seq, ...record.payload, recorded_at: record.recorded_at });
      return;
    }
    const { event_id: eventId } = record.payload;
    if (record.action === 'prepare') {
      this.events.set(eventId, {
        event: record.payload.event,
        state: 'prepared',
        prepare_seq: record.seq,
        updated_at: record.recorded_at
      });
      return;
    }

    const event = this.events.get(eventId);
    if (!event) {
      throw new Error(`Ledger references unknown event ${eventId}`);
    }
    event.state = record.action === 'commit' ? 'committed' : 'aborted';
    event.updated_at = record.recorded_at;
    event.last_seq = record.seq;
  }

  append(action, payload) {
    return this.enqueue(() => this.appendRecord(action, payload));
  }

  enqueue(operation) {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }

  async appendRecord(action, payload) {
    this.assertHealthy();
    const record = {
      seq: this.records.length + 1,
      previous_hash: this.records.at(-1)?.hash || ZERO_HASH,
      action,
      payload,
      recorded_at: new Date().toISOString()
    };
    const entry = { ...record, hash: recordHash(record) };
    const file = await open(this.filePath, 'a', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    this.applyRecord(entry);
    this.records.push(entry);
    return entry;
  }

  resolveLayerEvents(reason, scope = {}) {
    return this.enqueue(() => this.appendRecord('layer_resolve', { reason, ...scope }));
  }

  recordCopies(rows, baseline = false) {
    return this.enqueue(() => this.appendRecord('record_copy', { rows, baseline }));
  }

  recordBaseline(maxId, complete = false) {
    return this.enqueue(() => this.appendRecord('sync_baseline', { max_id: maxId, complete }));
  }

  // An unresolved finding about one bank row, e.g. kind 'entry_edited' for record 12.
  openEvidence(kind, recordId) {
    return this.layerEvents.find((item) => item.kind === kind && item.detail?.record === recordId && item.state === 'alert' && !item.resolved) || null;
  }

  hasOpenLayerEvent(kind) {
    return this.layerEvents.some((item) => item.kind === kind && item.state === 'alert' && !item.resolved);
  }

  recordLayerEvent(payload) {
    return this.enqueue(() => this.appendRecord('layer_event', payload));
  }

  recentLayerEvents(limit = 200) {
    if (this.integrityError) {
      return [];
    }
    return this.layerEvents.slice(-limit);
  }

  async prepare(event) {
    return this.enqueue(async () => {
      this.assertHealthy();
      const existing = this.events.get(event.event_id);
      if (existing) {
        if (JSON.stringify(existing.event) !== JSON.stringify(event)) {
          const error = new Error('Event ID already exists with different content');
          error.statusCode = 409;
          throw error;
        }
        if (existing.state === 'aborted') {
          const error = new Error('Event was already aborted');
          error.statusCode = 409;
          throw error;
        }
        return { event_id: event.event_id, state: existing.state, prepare_seq: existing.prepare_seq };
      }
      const record = await this.appendRecord('prepare', { event_id: event.event_id, event });
      return { event_id: event.event_id, state: 'prepared', prepare_seq: record.seq };
    });
  }

  async transition(eventId, action) {
    return this.enqueue(async () => {
      this.assertHealthy();
      const existing = this.events.get(eventId);
      if (!existing) {
        const error = new Error('Unknown event ID');
        error.statusCode = 404;
        throw error;
      }

      const requestedState = action === 'commit' ? 'committed' : 'aborted';
      if (existing.state === requestedState) {
        return { event_id: eventId, state: existing.state, prepare_seq: existing.prepare_seq };
      }
      if (existing.state !== 'prepared') {
        const error = new Error(`Cannot ${action} an event in state ${existing.state}`);
        error.statusCode = 409;
        throw error;
      }

      await this.appendRecord(action, { event_id: eventId });
      return { event_id: eventId, state: requestedState, prepare_seq: existing.prepare_seq };
    });
  }

  committedEvents() {
    if (this.integrityError) {
      return [];
    }
    return [...this.events.entries()]
      .filter(([, item]) => item.state === 'committed')
      .map(([eventId, item]) => ({ ...item.event, event_id: eventId }));
  }

  latestCommittedEvent() {
    if (this.integrityError) {
      return null;
    }
    const latest = [...this.events.entries()]
      .reverse()
      .find(([, item]) => item.state === 'committed');
    return latest
      ? { ...latest[1].event, event_id: latest[0], state: latest[1].state, updated_at: latest[1].updated_at }
      : null;
  }

  // Committed records with the time they were committed, oldest first.
  committedRecords() {
    if (this.integrityError) {
      return [];
    }
    return [...this.events.entries()]
      .filter(([, item]) => item.state === 'committed')
      .map(([eventId, item]) => ({ event: { ...item.event, event_id: eventId }, committed_at: item.updated_at }));
  }

  // One check of a record against the bank, as the auditor graph draws it: a crest when the witness
  // asks, then a trough when the bank answers. result is 'ok', 'mismatch', or 'none' (no answer).
  recordChallenge(transactionId, result, text = '') {
    const id = `c-${randomBytes(4).toString('hex')}`;
    const note = result === 'none' && text === 'rate limited by the bank' ? ` ${text}` : '';
    this.pushActivity('challenge_issued', `${id} record #${transactionId}${note}`);
    if (result === 'ok') {
      this.pushActivity('challenge_ok', `${id} record #${transactionId} ${text}`.trim());
    } else if (result === 'mismatch') {
      this.pushActivity('challenge_mismatch', `${id} record #${transactionId} ${text}`.trim());
    }
    return id;
  }

  pruneBankCalls(nowMs = Date.now()) {
    const cutoff = nowMs - BANK_CALL_WINDOW_MS;
    this.bankCallLog = this.bankCallLog.filter((at) => at > cutoff);
    this.bank429Log = this.bank429Log.filter((at) => at > cutoff);
  }

  updateHeartbeatInterval(nowMs = Date.now()) {
    this.pruneBankCalls(nowMs);
    const underPressure = this.bank429Log.length > 0 || this.bankCallLog.length > BANK_HEARTBEAT_HIGH_WATER;
    if (underPressure) {
      if (this.heartbeatIntervalS < 60) this.bankPressureSince = nowMs;
      this.heartbeatIntervalS = Math.max(this.heartbeatIntervalS, 60);
    } else if (
      this.heartbeatIntervalS > 30 &&
      this.bankCallLog.length < BANK_HEARTBEAT_LOW_WATER &&
      this.bankPressureSince !== null &&
      nowMs - this.bankPressureSince >= BANK_CALL_WINDOW_MS
    ) {
      this.heartbeatIntervalS = 30;
      this.bankPressureSince = null;
    }
    this.heartbeatIntervalS = clampHeartbeatInterval(this.heartbeatIntervalS);
    return this.heartbeatIntervalS;
  }

  canCallBank(nowMs = Date.now()) {
    this.updateHeartbeatInterval(nowMs);
    return nowMs >= this.bankBackoffUntil && this.bankCallLog.length < BANK_CALL_BUDGET;
  }

  recordBankCall(nowMs = Date.now()) {
    this.pruneBankCalls(nowMs);
    this.bankCallLog.push(nowMs);
    this.lastBankCheckAt = nowMs;
    this.updateHeartbeatInterval(nowMs);
  }

  recordBankBudgetLimit(nowMs = Date.now()) {
    this.bankBudgetLimitedAt = nowMs;
    this.setReconciliation();
  }

  recordBankCallResult({ ok, error = null, retryAfterMs = null } = {}, nowMs = Date.now()) {
    this.lastBankCheckAt = nowMs;
    this.lastBankCallFailed = !ok;
    this.lastBankCallError = error;
    if (ok) this.lastSuccessfulReconciliationAt = new Date(nowMs).toISOString();
    if (retryAfterMs !== null) {
      this.bank429Log.push(nowMs);
      this.bankBackoffUntil = Math.max(this.bankBackoffUntil, nowMs + retryAfterMs);
      this.bankBackoffReason = 'bank rate-limited';
      this.bankPressureSince = nowMs;
    } else if (ok && nowMs >= this.bankBackoffUntil) {
      this.bankBackoffReason = null;
    }
    this.updateHeartbeatInterval(nowMs);
    this.setReconciliation();
  }

  setReconciliation(result) {
    this.pruneBankCalls();
    if (result && Array.isArray(result.mismatches)) {
      this.lastBankCheckAt ??= Date.now();
      this.lastBankCallFailed = false;
      this.bankFindings.clear();
      for (const finding of result.mismatches) {
        this.bankFindings.set(finding.transaction_id, finding);
      }
      if (Number.isSafeInteger(result.checked_transactions)) {
        const findingIds = new Set(this.bankFindings.keys());
        this.bankPassedIds = new Set(
          this.committedEvents()
            .map((event) => event.transaction_id)
            .filter((id) => !findingIds.has(id))
            .slice(0, result.checked_transactions)
        );
      }
      if (result.checked_transactions > 0) {
        this.lastSuccessfulReconciliationAt = new Date(this.lastBankCheckAt).toISOString();
      }
    }
    const mismatches = [...this.bankFindings.values()]
      .sort((a, b) => a.transaction_id - b.transaction_id);
    const checkedAt = this.lastBankCheckAt === null
      ? null
      : new Date(this.lastBankCheckAt).toISOString();
    const backoffActive = Date.now() < this.bankBackoffUntil;
    const budgetLimited = this.bankCallLog.length >= BANK_CALL_BUDGET ||
      (this.bankBudgetLimitedAt !== null && Date.now() - this.bankBudgetLimitedAt < BANK_CALL_WINDOW_MS);
    const rateLimited = backoffActive || budgetLimited;
    this.reconciliation = {
      state: mismatches.length
        ? 'mismatch'
        : this.lastBankCallFailed
          ? 'unavailable'
          : checkedAt
            ? 'ok'
            : 'checking',
      checked_at: checkedAt,
      checked_transactions: this.bankPassedIds.size,
      mismatches,
      ...(this.lastBankCallError && { error: 'Bank transaction source could not be checked.', last_error: this.lastBankCallError }),
      rate_limited: rateLimited,
      rate_limit_reason: rateLimited
        ? backoffActive ? this.bankBackoffReason || 'bank rate-limited' : 'witness request budget exhausted'
        : null,
      bank_calls_last_15m: this.bankCallLog.length,
      backoff_until: this.bankBackoffUntil > Date.now()
        ? new Date(this.bankBackoffUntil).toISOString()
        : null
    };
    return this.reconciliation;
  }

  setReconciliationUnavailable(error) {
    this.recordBankCallResult({ ok: false, error }, Date.now());
  }

  status() {
    this.updateHeartbeatInterval();
    this.setReconciliation();
    return {
      healthy: !this.integrityError,
      ...(this.integrityError && {
        integrity_error: 'Ledger integrity validation failed; witness writes are disabled.'
      }),
      record_count: this.records.length,
      latest_seq: this.records.at(-1)?.seq || 0,
      latest_hash: this.records.at(-1)?.hash || ZERO_HASH,
      prepared_count: [...this.events.values()].filter((event) => event.state === 'prepared').length,
      bank_reconciliation: this.reconciliation
    };
  }

  recentEvents(limit = 50) {
    if (this.integrityError) {
      return [];
    }
    return [...this.events.entries()]
      .map(([eventId, item]) => ({
        ...item.event,
        state: item.state,
        prepare_seq: item.prepare_seq,
        updated_at: item.updated_at
      }))
      .sort((left, right) => right.prepare_seq - left.prepare_seq)
      .slice(0, limit);
  }

  recentActivity(sinceId = 0, limit = 200) {
    if (this.integrityError) {
      return [];
    }
    return this.activity.filter((item) => item.id > sinceId).slice(-limit);
  }
}
