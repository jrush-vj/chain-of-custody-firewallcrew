// With the guard on and BOB_ENABLED unset, Bob is OFF by default.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WitnessStore } from '../store.js';

process.env.WITNESS_NODE_ID = 'test-node';
process.env.WITNESS_HMAC_SECRET = 'test-secret-value-with-at-least-32-characters';
process.env.GUARD_ENABLED = '1';
delete process.env.BOB_ENABLED;
const { createWitnessServer } = await import('../server.js');

test('guard on, BOB_ENABLED unset: Bob is off, and the state API says so', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-bobdef-'));
  const store = new WitnessStore(path.join(directory, 'ledger.jsonl'));
  await store.initialize();
  const server = createWitnessServer(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/v1/diagnose-request`, { method: 'POST', body: '{}' })).status, 403);
    const state = await (await fetch(`${base}/guard/state`)).json();
    assert.equal(state.bob_enabled, false);
    assert.equal(state.report_narrative, 'off');
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
