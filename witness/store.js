import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

const ZERO_HASH = '0'.repeat(64);

const recordHash = (record) =>
  createHash('sha256').update(JSON.stringify(record)).digest('hex');

export class WitnessStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.records = [];
    this.events = new Map();
    this.layerEvents = [];
    this.queue = Promise.resolve();
    this.integrityError = null;
    this.lastSuccessfulReconciliationAt = null;
    this.reconciliation = {
      state: 'checking',
      checked_at: null,
      checked_transactions: 0,
      mismatches: []
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
          !['prepare', 'commit', 'abort', 'layer_event'].includes(record.action) ||
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
    return latest ? { ...latest[1].event, event_id: latest[0], state: latest[1].state } : null;
  }

  setReconciliation(result) {
    const checkedAt = new Date().toISOString();
    if (result.checked_transactions > 0) {
      this.lastSuccessfulReconciliationAt = checkedAt;
    }
    this.reconciliation = {
      ...result,
      checked_at: checkedAt
    };
  }

  setReconciliationUnavailable(error) {
    this.reconciliation = {
      ...this.reconciliation,
      state: 'unavailable',
      error: 'Bank transaction source could not be checked.',
      last_error: error,
      checked_at: new Date().toISOString()
    };
  }

  status() {
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
    return this.records
      .filter((record) => record.seq > sinceId)
      .slice(-limit)
      .map((record) => {
        if (record.action === 'layer_event') {
          return {
            id: record.seq,
            time: Date.parse(record.recorded_at) / 1000,
            kind: `layer${record.payload.layer}_${record.payload.trigger}`,
            detail: record.payload.summary
          };
        }
        const eventId = record.payload.event_id;
        const event = this.events.get(eventId)?.event;
        return {
          id: record.seq,
          time: Date.parse(record.recorded_at) / 1000,
          kind: `witness_${record.action}`,
          detail: event
            ? `Transaction ${event.transaction_id} ${record.action} (${event.type}, ${event.amount_minor} minor units)`
            : `Transaction event ${eventId} ${record.action}`
        };
      });
  }
}
