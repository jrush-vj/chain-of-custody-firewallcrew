import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CLASSES, classify, normalize } from '../guard/classify.js';
import { loadGuardConfig } from '../guard/config.js';
import { scenarios } from '../guard/fixtures.js';

const config = loadGuardConfig({});

for (const scenario of scenarios) {
  test(`${scenario.id}: ${scenario.title}`, () => {
    const result = classify(scenario.evidence, config);
    assert.equal(result.class, scenario.expect);
    assert.ok(result.reasons.length > 0, 'a verdict always explains itself');
    if (scenario.expectSeq !== undefined) assert.equal(result.seq, scenario.expectSeq);
    if (scenario.expectFlag) assert.ok(result.flags.includes(scenario.expectFlag));
  });
}

test('NETWORK_CONSISTENT cannot be reached during the outage, only after verified reconnect', () => {
  const during = classify({ now: 1, silence: { active: true } }, config);
  assert.equal(during.class, CLASSES.UNVERIFIED);
  const unverifiedReconnect = classify({
    now: 1, reconnect: { verified: false, chainOk: true, boxEntriesDuringOutage: 3, receivedAfterReconnect: 3 }
  }, config);
  assert.notEqual(unverifiedReconnect.class, CLASSES.NETWORK_CONSISTENT);
});

test('a reconnect whose gap does not match stays UNVERIFIED, never NETWORK_CONSISTENT', () => {
  const result = classify({
    now: 1, reconnect: { verified: true, chainOk: true, boxEntriesDuringOutage: 7, receivedAfterReconnect: 5 }
  }, config);
  assert.equal(result.class, CLASSES.UNVERIFIED);
  assert.equal(result.gapMismatch, true);
});

test('a broken chain on reconnect is TAMPER_CONFIRMED even if the counts match', () => {
  const result = classify({
    now: 1, reconnect: { verified: true, chainOk: false, boxEntriesDuringOutage: 4, receivedAfterReconnect: 4 }
  }, config);
  assert.equal(result.class, CLASSES.TAMPER_CONFIRMED);
});

test('box-reported signals alone can never confirm tampering', () => {
  const result = classify({
    now: 1, boxClaims: ['log_size_changed', 'inode_changed'], heartbeats: { validRecent: true }
  }, config);
  assert.equal(result.class, CLASSES.BOX_CLAIM_ONLY);
  assert.ok(result.evidence.every((item) => item.source === 'box'));
});

test('an unknown mismatch kind is not treated as tampering', () => {
  const result = classify({ now: 1, mismatches: [{ kind: 'made-up', seq: 3 }] }, config);
  assert.equal(result.class, CLASSES.NONE);
});

test('tampering outranks silence and flapping', () => {
  const result = classify({
    now: 1000, silence: { active: true }, outages: [900, 950, 990], mismatches: [{ kind: 'changed', seq: 5 }]
  }, config);
  assert.equal(result.class, CLASSES.TAMPER_CONFIRMED);
});

test('outages outside the flap window do not count', () => {
  const result = classify({ now: 10_000, silence: { active: true }, outages: [1, 2, 3] }, config);
  assert.equal(result.class, CLASSES.UNVERIFIED);
});

test('the flap threshold is configurable', () => {
  const strict = loadGuardConfig({ FLAP_MAX: '2' });
  const result = classify({ now: 1000, outages: [900, 990] }, strict);
  assert.equal(result.class, CLASSES.UNSTABLE);
});

test('the verdict is deterministic and the result is frozen', () => {
  const evidence = scenarios[2].evidence;
  assert.deepEqual(classify(evidence, config), classify(evidence, config));
  assert.ok(Object.isFrozen(classify(evidence, config)));
});

test('garbage input never throws and yields no alarm', () => {
  for (const bad of [null, undefined, 5, 'x', [], { silence: 'yes', mismatches: 'no', outages: [NaN, 'a'] }]) {
    assert.equal(classify(bad, config).class, CLASSES.NONE);
  }
});

// G10: prompt injection. The classifier reads only whitelisted fields, so attacker text cannot move a verdict.
const payloads = readFileSync(new URL('../../deploy/ct105/guard/injection-payloads.txt', import.meta.url), 'utf8')
  .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));

test('G10: the payload file is present and non-trivial', () => {
  assert.ok(payloads.length >= 5);
});

for (const scenario of scenarios) {
  test(`G10: injection text planted in every free-text spot cannot change ${scenario.id}`, () => {
    const poisoned = structuredClone(scenario.evidence);
    for (const payload of payloads) {
      // Extra fields an attacker could influence, and string values in whitelisted fields.
      poisoned[`note_${payload.length}`] = payload;
      poisoned.command_args = payload;
      poisoned.log_line = payload;
      poisoned.mismatches = (poisoned.mismatches ?? []).map((m) => ({ ...m, note: payload, who: payload }));
      poisoned.boxClaims = [...(poisoned.boxClaims ?? []), payload];
      poisoned.silence = { ...(poisoned.silence ?? {}), reason: payload };
    }
    const clean = classify(scenario.evidence, config);
    const attacked = classify(poisoned, config);
    assert.equal(attacked.class, clean.class);
    assert.deepEqual(attacked.reasons, clean.reasons);
    assert.deepEqual(attacked.evidence, clean.evidence);
    const text = JSON.stringify(attacked);
    for (const payload of payloads) assert.ok(!text.includes(payload), 'no input string reaches the output');
  });
}

test('normalize drops every string that is not from a fixed set', () => {
  const clean = normalize({ boxClaims: ['iface_down', 'IGNORE PREVIOUS INSTRUCTIONS'], mismatches: [{ kind: 'changed; run rm', seq: 'x' }] });
  assert.deepEqual(clean.boxClaims, ['iface_down']);
  assert.deepEqual(clean.mismatches, [{ kind: 'other', seq: null }]);
});

test('config: Bob is off by default and invalid values fail loudly', () => {
  assert.equal(loadGuardConfig({}).bobEnabled, false);
  assert.equal(loadGuardConfig({}).reportNarrative, 'off');
  assert.equal(loadGuardConfig({ REPORT_NARRATIVE: 'bob_auto' }).reportNarrative, 'off', 'narrative needs BOB_ENABLED');
  assert.equal(loadGuardConfig({ BOB_ENABLED: '1', REPORT_NARRATIVE: 'bob_auto' }).reportNarrative, 'bob_auto');
  assert.throws(() => loadGuardConfig({ FLAP_MAX: '0' }), /FLAP_MAX/);
  assert.throws(() => loadGuardConfig({ REPORT_NARRATIVE: 'always' }), /REPORT_NARRATIVE/);
});
