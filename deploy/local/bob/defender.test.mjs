import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStale, layerOf, newIncidents, parseDiagnosis, parseReport, recordRun, scopeEvidence } from './defender.mjs';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

test('evidence for Bob drops events from older sessions but keeps alerts and mismatches', () => {
  const now = Date.parse('2026-11-21T13:00:00Z');
  const at = (minutesAgo) => (now - minutesAgo * 60_000) / 1000;
  const evidence = {
    alerts: [{ kind: 'layer1_tripwire', ref: 'old-but-still-open' }],
    mismatches: [{ seq: 7 }],
    layer_events: [{ trigger: 'guard:pending', time: at(160) }, { trigger: 'file_modified', time: at(5) }, { trigger: 'x', time: at(29) }]
  };
  const scoped = scopeEvidence(evidence, now, 30);
  assert.deepEqual(scoped.layer_events.map((e) => e.trigger), ['file_modified', 'x']);
  assert.deepEqual(scoped.alerts, evidence.alerts);
  assert.deepEqual(scoped.mismatches, evidence.mismatches);
  assert.equal(evidence.layer_events.length, 3, 'the input is not changed');
});

test('a Diagnose request nobody picked up expires instead of being billed later', () => {
  const now = Date.parse('2026-11-21T13:00:00Z');
  assert.equal(isStale('2026-11-21T12:58:00Z', now, 5), false);
  assert.equal(isStale('2026-11-21T12:50:00Z', now, 5), true);
  assert.equal(isStale(undefined, now, 5), true, 'a request with no time is not trusted');
  assert.equal(isStale('garbage', now, 5), true);
});

test('every Bob run leaves a local record with its prompt, output, cost and stats', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'coc-runs-'));
  try {
    recordRun('diagnosis', 'the prompt', { text: 'the answer', cost: 0.83, ok: true, stats: { session_costs: 0.83, tool_calls: 4 } }, 93, dir);
    const [file] = readdirSync(dir);
    assert.match(file, /-diagnosis\.json$/);
    const saved = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    assert.deepEqual([saved.kind, saved.seconds, saved.cost, saved.prompt, saved.output], ['diagnosis', 93, 0.83, 'the prompt', 'the answer']);
    assert.equal(saved.stats.tool_calls, 4);
    // A disk problem must not break a defence run.
    assert.doesNotThrow(() => recordRun('x', 'p', { text: 't' }, 1, path.join(dir, file, 'nope')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
