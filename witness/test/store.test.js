import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WitnessStore } from '../store.js';

const sampleEvent = {
  event_id: 'c80ba038-26ef-4d2f-84a8-e504a67ec7e6',
  transaction_id: 12,
  type: 'deposit',
  amount_minor: 50000,
  occurred_at: '2026-10-14T10:00:00.000Z'
};

test('prepares, commits, persists and reloads an append-only chain', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-witness-'));
  const ledger = path.join(directory, 'ledger.jsonl');
  try {
    const store = new WitnessStore(ledger);
    await store.initialize();
    const prepared = await store.prepare(sampleEvent);
    assert.equal(prepared.state, 'prepared');
    assert.equal((await store.prepare(sampleEvent)).prepare_seq, prepared.prepare_seq);
    const committed = await store.transition(sampleEvent.event_id, 'commit');
    assert.equal(committed.state, 'committed');
    assert.equal(store.status().record_count, 2);

    const restored = new WitnessStore(ledger);
    await restored.initialize();
    assert.equal(restored.recentEvents()[0].state, 'committed');
    assert.equal(restored.status().latest_seq, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a modified ledger record on startup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-witness-'));
  const ledger = path.join(directory, 'ledger.jsonl');
  try {
    const store = new WitnessStore(ledger);
    await store.initialize();
    await store.prepare(sampleEvent);
    const entry = JSON.parse(await readFile(ledger, 'utf8'));
    entry.payload.event.amount_minor = 5;
    await writeFile(ledger, `${JSON.stringify(entry)}\n`);
    await assert.rejects(() => new WitnessStore(ledger).initialize(), /integrity check failed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects conflicting reuse and commit after abort', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-witness-'));
  const ledger = path.join(directory, 'ledger.jsonl');
  try {
    const store = new WitnessStore(ledger);
    await store.initialize();
    await store.prepare(sampleEvent);
    await assert.rejects(
      () => store.prepare({ ...sampleEvent, amount_minor: 5 }),
      /different content/
    );
    await store.transition(sampleEvent.event_id, 'abort');
    await assert.rejects(() => store.transition(sampleEvent.event_id, 'commit'), /aborted/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
