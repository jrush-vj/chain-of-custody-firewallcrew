// The dashboard's unauthenticated buttons must refuse requests that a page on another site makes through the
// operator's browser, while the dashboard itself and command-line scripts (no Origin header) keep working.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WitnessStore } from '../store.js';

process.env.WITNESS_NODE_ID = 'test-node';
process.env.WITNESS_HMAC_SECRET = 'test-secret-value-with-at-least-32-characters';
const { createWitnessServer } = await import('../server.js');

const rig = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-witness-origin-'));
  const store = new WitnessStore(path.join(directory, 'ledger.jsonl'));
  await store.initialize();
  const server = createWitnessServer(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const stop = async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  return { store, baseUrl, stop };
};

test('"Restore to normal" refuses other origins, accepts the dashboard and scripts', async () => {
  const { store, baseUrl, stop } = await rig();
  try {
    const ask = (headers = {}) => fetch(`${baseUrl}/v1/restore-request`, { method: 'POST', headers });
    assert.equal((await ask({ origin: 'https://evil.example' })).status, 403);
    assert.equal(store.restoreRequest, null, 'a refused request queues nothing');
    assert.equal((await ask({ origin: baseUrl })).status, 202, 'the dashboard itself may ask');
    store.restoreRequest = null;
    store.lastRestoreRequestAt = 0;
    assert.equal((await ask()).status, 202, 'a script with no Origin header may ask');
  } finally {
    await stop();
  }
});

test('key-holder approval refuses other origins and counts nothing for them', async () => {
  const { store, baseUrl, stop } = await rig();
  try {
    const approve = (headers) => fetch(`${baseUrl}/quarantine/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ holder: 0 })
    });
    assert.equal((await approve({ origin: 'https://evil.example' })).status, 403);
    assert.equal(store.holderApprovals.size, 0, 'a refused approval is not recorded');
    // Same origin passes the origin check and is then judged on its merits (no quarantine to release).
    assert.equal((await approve({ origin: baseUrl })).status, 409);
  } finally {
    await stop();
  }
});
