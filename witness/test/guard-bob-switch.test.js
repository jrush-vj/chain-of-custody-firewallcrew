// BOB_ENABLED=0 is read when the witness module loads, so this file sets it before importing.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WitnessStore } from '../store.js';

process.env.WITNESS_NODE_ID = 'test-node';
process.env.WITNESS_HMAC_SECRET = 'test-secret-value-with-at-least-32-characters';
process.env.BOB_ENABLED = '0';
delete process.env.BOB_KEY;
const { createWitnessServer } = await import('../server.js');

test('with Bob disabled, "Diagnose with Bob" is refused and nothing is queued', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-bobsw-'));
  const store = new WitnessStore(path.join(directory, 'ledger.jsonl'));
  await store.initialize();
  const server = createWitnessServer(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/diagnose-request`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Bob is disabled on this witness', bob: 'disabled' });
    assert.equal(store.diagnoseRequest, null);
    assert.equal(store.bobDiagnosis, null);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
