import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerOf, newIncidents, parseDiagnosis, parseReport } from './defender.mjs';

test('alerts map to layers', () => {
  assert.equal(layerOf({ kind: 'layer1_tripwire' }), 1);
  assert.equal(layerOf({ kind: 'record_mismatch' }), 2);
  assert.equal(layerOf({ kind: 'quarantine' }), 3);
});

test('only alerts not open on the last poll are new, grouped by layer', () => {
  const a = { kind: 'layer1_tripwire', ref: 'nano', time: 1 }, b = { kind: 'record_mismatch', ref: '7', time: 2 };
  const fresh = newIncidents([a, b], new Set(['layer1_tripwire|nano|1']));
  assert.deepEqual([...fresh.keys()], [2]);
  assert.deepEqual(fresh.get(2), [b]);
});

test('report JSON at the end of Bob output is parsed and clipped', () => {
  const r = parseReport('I checked things.\n{"status":"contained","summary":"' + 'x'.repeat(300) + '","what":"w","did":"d","result":"ok"}');
  assert.equal(r.status, 'contained');
  assert.equal(r.summary.length, 200);
  assert.equal(r.did, 'd');
});

test('plain-text Bob output falls back to a report', () => {
  const r = parseReport('Restored row 7.\nAll good.');
  assert.equal(r.status, 'reported');
  assert.equal(r.summary, 'Restored row 7.');
});

test('a repeat tripwire is new; a re-checked mismatch is not', () => {
  const open = new Set(['layer1_tripwire|file_modified|1', 'record_mismatch|7|']);
  const fresh = newIncidents([{ kind: 'layer1_tripwire', ref: 'file_modified', time: 9 },
    { kind: 'record_mismatch', ref: '7', time: 9 }], open);
  assert.deepEqual([...fresh.keys()], [1]);
});

test('a diagnosis walkthrough is parsed into exactly layers 1-3', () => {
  const r = parseDiagnosis('Checked everything.\n{"summary":"Two attacks.","layers":[{"layer":2,"status":"contained","what":"w","did":"d","result":"ok"},{"layer":1,"status":"no attack seen"}]}');
  assert.equal(r.summary, 'Two attacks.');
  assert.deepEqual(r.layers.map((l) => [l.layer, l.status]), [[1, 'no attack seen'], [2, 'contained'], [3, 'not reported']]);
  assert.equal(parseDiagnosis('no json here'), null);
});
