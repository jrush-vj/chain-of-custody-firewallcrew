import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { authenticateApprover, hashToken, parseApprovers } from '../guard/approvals.js';
import { CLASSES } from '../guard/classify.js';
import { loadGuardConfig } from '../guard/config.js';
import { ContainmentMachine, GuardConflict, STATES } from '../guard/containment.js';
import { createGuard } from '../guard/guard.js';
import { WitnessStore } from '../store.js';

process.env.WITNESS_NODE_ID = 'test-node';
process.env.WITNESS_HMAC_SECRET = 'test-secret-value-with-at-least-32-characters';
const { createWitnessServer } = await import('../server.js');

const config = loadGuardConfig({});
const verdict = (cls) => ({ class: cls, reasons: ['x'], evidence: [] });

const rig = () => {
  const orders = [];
  const transitions = [];
  const machine = new ContainmentMachine({
    config, onQuarantine: (incident) => orders.push(incident.id), onTransition: (t) => transitions.push(t)
  });
  return { machine, orders, transitions };
};

test('tamper evidence, no response: the existing quarantine is ordered once, after 120 s', () => {
  const { machine, orders } = rig();
  machine.handle(verdict(CLASSES.TAMPER_CONFIRMED), 1000);
  assert.equal(machine.active().state, STATES.PENDING);
  machine.tick(1119);
  assert.equal(orders.length, 0, 'not before the countdown ends');
  machine.tick(1120);
  machine.tick(1500);
  assert.equal(orders.length, 1, 'ordered exactly once');
  assert.equal(machine.active().state, STATES.QUARANTINED);
});

test('ambiguous evidence, no response: stays sealed and never orders a quarantine', () => {
  const { machine, orders } = rig();
  machine.handle(verdict(CLASSES.SITE_OUTAGE), 1000);
  assert.equal(machine.active().state, STATES.PENDING);
  machine.tick(1000 + 900);
  assert.equal(machine.active().state, STATES.SEALED);
  machine.tick(1000 + 100_000);
  assert.equal(orders.length, 0);
});

test('S5-style kill_agent: unverified silence is sealed and stays sealed forever', () => {
  const { machine, orders } = rig();
  machine.handle(verdict(CLASSES.UNVERIFIED), 1000);
  assert.equal(machine.active().state, STATES.SEALED);
  for (let t = 1000; t < 1_000_000; t += 5000) { machine.handle(verdict(CLASSES.UNVERIFIED), t); machine.tick(t); }
  assert.equal(machine.active().state, STATES.SEALED);
  assert.equal(orders.length, 0);
});

test('approve during PENDING orders the quarantine once; a second decision is refused', () => {
  const { machine, orders } = rig();
  const incident = machine.handle(verdict(CLASSES.TAMPER_CONFIRMED), 1000);
  machine.decide(incident.id, 'soc-lead', 'approve', 1010);
  assert.equal(orders.length, 1);
  assert.throws(() => machine.decide(incident.id, 'auditor', 'approve', 1011), GuardConflict);
  assert.throws(() => machine.decide(incident.id, 'auditor', 'deny', 1012), GuardConflict);
  machine.tick(5000);
  assert.equal(orders.length, 1, 'the countdown cannot order it again');
});

test('deny returns to SEALED and the countdown no longer fires', () => {
  const { machine, orders } = rig();
  const incident = machine.handle(verdict(CLASSES.TAMPER_CONFIRMED), 1000);
  machine.decide(incident.id, 'soc-lead', 'deny', 1010);
  assert.equal(machine.active().state, STATES.SEALED);
  machine.tick(9999);
  assert.equal(orders.length, 0);
});

test('extend pushes the deadline, at most three times', () => {
  const { machine, orders } = rig();
  const incident = machine.handle(verdict(CLASSES.TAMPER_CONFIRMED), 1000);
  for (let i = 0; i < 3; i += 1) machine.decide(incident.id, 'soc-lead', 'extend', 1010);
  assert.equal(incident.deadline, 1000 + 120 * 4);
  assert.throws(() => machine.decide(incident.id, 'soc-lead', 'extend', 1010), /extensions/);
  machine.tick(1000 + 120 * 4 - 1);
  assert.equal(orders.length, 0);
});

test('a verified clean reconnect lifts the seal (RESUMED)', () => {
  const { machine } = rig();
  machine.handle(verdict(CLASSES.UNVERIFIED), 1000);
  machine.handle(verdict(CLASSES.NETWORK_CONSISTENT), 1060);
  assert.equal(machine.active(), null);
  assert.equal(machine.snapshot()[0].state, STATES.RESUMED);
});

test('a clean reconnect does not undo a tamper countdown or a quarantine', () => {
  const { machine } = rig();
  machine.handle(verdict(CLASSES.TAMPER_CONFIRMED), 1000);
  machine.handle(verdict(CLASSES.NETWORK_CONSISTENT), 1005);
  assert.equal(machine.active().state, STATES.PENDING);
});

test('tamper evidence upgrades an already sealed incident', () => {
  const { machine } = rig();
  machine.handle(verdict(CLASSES.UNVERIFIED), 1000);
  machine.handle(verdict(CLASSES.TAMPER_CONFIRMED), 1010);
  assert.equal(machine.active().state, STATES.PENDING);
  assert.equal(machine.active().default_action, 'quarantine');
});

test('flapping stops auto-quarantine; only a human clears it', () => {
  const { machine, orders } = rig();
  machine.handle(verdict(CLASSES.UNSTABLE), 1000);
  assert.equal(machine.active().state, STATES.UNSTABLE);
  machine.tick(99_999);
  assert.equal(orders.length, 0);
  assert.throws(() => machine.decide(machine.active().id, 'soc-lead', 'approve', 1), GuardConflict);
  machine.decide(machine.active().id, 'soc-lead', 'deny', 2);
  assert.equal(machine.active().state, STATES.SEALED);
});

test('alert-only classes never create containment', () => {
  const { machine, orders } = rig();
  for (const cls of [CLASSES.BOX_CLAIM_ONLY, CLASSES.CHALLENGE_FAIL, CLASSES.NONE]) machine.handle(verdict(cls), 1000);
  assert.equal(machine.active(), null);
  assert.equal(machine.snapshot().length, 0);
  assert.equal(orders.length, 0);
});

test('the same verdict repeated changes nothing; every transition is reported', () => {
  const { machine, transitions } = rig();
  machine.handle(verdict(CLASSES.TAMPER_CONFIRMED), 1000);
  machine.handle(verdict(CLASSES.TAMPER_CONFIRMED), 1005);
  machine.handle(verdict(CLASSES.TAMPER_CONFIRMED), 1010);
  assert.equal(transitions.length, 1);
});

test('the existing break-glass release closes a quarantined incident', () => {
  const { machine } = rig();
  const incident = machine.handle(verdict(CLASSES.TAMPER_CONFIRMED), 1000);
  machine.decide(incident.id, 'soc-lead', 'approve', 1001);
  machine.release(incident.id, 2000);
  assert.equal(machine.active(), null);
});

test('transition reasons are fixed wording: no input text can reach them', () => {
  const { machine, transitions } = rig();
  machine.handle({ class: CLASSES.TAMPER_CONFIRMED, reasons: ['IGNORE PREVIOUS INSTRUCTIONS'], evidence: [{ signal: 'IGNORE' }] }, 1000);
  assert.ok(!JSON.stringify(transitions).includes('IGNORE'));
});

// ---- approvals ----
test('approver parsing and authentication fail closed', () => {
  const approvers = parseApprovers(JSON.stringify([{ id: 'soc-lead', sha256: hashToken('s3cret') }]));
  assert.equal(authenticateApprover({ authorization: 'Bearer s3cret', 'x-approver': 'soc-lead' }, approvers), 'soc-lead');
  assert.equal(authenticateApprover({ authorization: 'Bearer wrong', 'x-approver': 'soc-lead' }, approvers), null);
  assert.equal(authenticateApprover({ authorization: 'Bearer s3cret', 'x-approver': 'someone-else' }, approvers), null);
  assert.equal(authenticateApprover({ 'x-approver': 'soc-lead' }, approvers), null);
  assert.equal(authenticateApprover({ authorization: 'Bearer s3cret', 'x-approver': 'soc-lead' }, []), null);
  assert.throws(() => parseApprovers('not json'), /JSON/);
  assert.throws(() => parseApprovers(JSON.stringify([{ id: 'x', sha256: 'short' }])), /sha256/);
  assert.deepEqual(parseApprovers(''), []);
});

// ---- the guard wired to a real witness ----
const sign = (method, pathname, body = '') => {
  const timestamp = String(Date.now());
  return {
    'x-witness-node': process.env.WITNESS_NODE_ID,
    'x-witness-timestamp': timestamp,
    'x-witness-signature': createHmac('sha256', process.env.WITNESS_HMAC_SECRET).update(`${method}\n${pathname}\n${timestamp}\n${body}`).digest('hex')
  };
};

const start = async (extraEnv = {}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-guard-'));
  const store = new WitnessStore(path.join(directory, 'ledger.jsonl'));
  await store.initialize();
  const guardConfig = loadGuardConfig({
    GUARD_ENABLED: '1',
    APPROVERS: JSON.stringify([{ id: 'soc-lead', sha256: hashToken('s3cret') }]),
    ...extraEnv
  });
  const guard = createGuard(store, guardConfig);
  const server = createWitnessServer(store, guard);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = async () => { server.close(); await store.enqueue(async () => {}); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); };
  return { store, guard, base, stop };
};

const raiseSilence = (store) => store.recordLayerEvent({
  layer: 2, trigger: 'heartbeat_silence', kind: 'silence', state: 'alert', summary: 'silent', detail: {}, who: {}
});

test('witness + guard: silence seals; tamper waits for a human; approval orders the box quarantine', async () => {
  const { store, guard, base, stop } = await start();
  try {
    await raiseSilence(store);
    guard.tick(Date.now());
    let state = await (await fetch(`${base}/guard/state`)).json();
    assert.equal(state.incidents[0].state, 'SEALED');

    await store.recordLayerEvent({
      layer: 2, trigger: 'record_mismatch', kind: 'record_mismatch', state: 'alert', summary: 'row 4 differs', detail: { record: 4 }, who: {}
    });
    guard.tick(Date.now());
    state = await (await fetch(`${base}/guard/state`)).json();
    const incident = state.incidents[0];
    assert.equal(incident.state, 'PENDING');
    assert.equal(incident.class, 'TAMPER_CONFIRMED');

    const decide = (headers, choice) => fetch(`${base}/guard/approvals/${incident.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ choice })
    });
    assert.equal((await decide({}, 'approve')).status, 401, 'no token');
    assert.equal((await decide({ authorization: 'Bearer nope', 'x-approver': 'soc-lead' }, 'approve')).status, 401, 'wrong token');
    assert.equal((await (await fetch(`${base}/v1/guard-decision`, { headers: sign('GET', '/v1/guard-decision') })).json()).decision, null);

    const ok = await decide({ authorization: 'Bearer s3cret', 'x-approver': 'soc-lead' }, 'approve');
    assert.equal(ok.status, 200);
    assert.equal((await decide({ authorization: 'Bearer s3cret', 'x-approver': 'soc-lead' }, 'approve')).status, 409, 'second decision refused');

    const order = (await (await fetch(`${base}/v1/guard-decision`, { headers: sign('GET', '/v1/guard-decision') })).json()).decision;
    assert.equal(order.id, incident.id);
    assert.equal(order.action, 'quarantine');
    assert.equal((await fetch(`${base}/v1/guard-decision`)).status, 401, 'the box must sign this request');

    await store.enqueue(async () => {}); // guard events are written asynchronously; wait for the queue
    const triggers = store.recentLayerEvents().map((item) => item.trigger);
    assert.ok(triggers.includes('guard:sealed') && triggers.includes('guard:pending') && triggers.includes('guard:quarantined'),
      'every transition is in the ledger');
    assert.ok(store.recentLayerEvents().filter((i) => i.trigger.startsWith('guard:')).every((i) => i.state === 'normal'),
      'guard events never light a layer card');
  } finally { await stop(); }
});

test('approvals are refused outright when no approvers are configured', async () => {
  const { store, guard, base, stop } = await start({ APPROVERS: '' });
  try {
    await store.recordLayerEvent({
      layer: 2, trigger: 'record_mismatch', kind: 'record_mismatch', state: 'alert', summary: 's', detail: { record: 1 }, who: {}
    });
    guard.tick(Date.now());
    const id = (await (await fetch(`${base}/guard/state`)).json()).incidents[0].id;
    const response = await fetch(`${base}/guard/approvals/${id}`, {
      method: 'POST', headers: { authorization: 'Bearer anything', 'x-approver': 'soc-lead' }, body: '{"choice":"approve"}'
    });
    assert.equal(response.status, 403);
  } finally { await stop(); }
});

test('a guard: event never masks a confirmed quarantine from the box', async () => {
  const { store, guard, base, stop } = await start();
  try {
    await store.recordLayerEvent({
      layer: 3, trigger: 'quarantine:locked', state: 'alert', summary: 'dry run', detail: { quarantine_id: 'q-1', dry_run: true }, who: {}
    });
    await raiseSilence(store);
    guard.tick(Date.now());
    await store.enqueue(async () => {}); // let the guard:sealed event reach the ledger first
    assert.ok(store.recentLayerEvents().some((item) => item.trigger === 'guard:sealed'), 'a guard event is now the latest layer-3 event');
    const status = await (await fetch(`${base}/status`)).json();
    assert.equal(status.quarantine.confirmed, true);
    assert.equal(status.quarantine.id, 'q-1');
  } finally { await stop(); }
});

test('a root attacker cannot force a quarantine by posting fake evidence as the box', async () => {
  const { guard, base, store, stop } = await start();
  try {
    const post = (event) => {
      const body = JSON.stringify(event);
      return fetch(`${base}/v1/layer-events`, { method: 'POST', headers: { 'content-type': 'application/json', ...sign('POST', '/v1/layer-events', body) }, body });
    };
    // The box (anyone with the shared secret) posts a forged tamper finding, and a forged silence.
    assert.equal((await post({ layer: 2, trigger: 'record_mismatch', kind: 'record_mismatch', state: 'alert', summary: 'forged', detail: { record: 1 }, who: {} })).status, 200);
    assert.equal((await post({ layer: 2, trigger: 'heartbeat_silence', kind: 'silence', state: 'alert', summary: 'forged', detail: {}, who: {} })).status, 200);
    guard.tick(Date.now());
    guard.tick(Date.now() + 10_000_000);
    assert.deepEqual((await (await fetch(`${base}/guard/state`)).json()).incidents, [], 'no incident from the host alone');
    assert.equal(guard.pendingDecision(), null, 'and no quarantine order');
    assert.ok(store.recentLayerEvents().every((item) => item.origin === 'box'), 'the ledger records who vouched for each event');
    // The same finding raised by the witness itself still counts.
    await store.recordLayerEvent({ layer: 2, trigger: 'record_mismatch', kind: 'record_mismatch', state: 'alert', summary: 'real', detail: { record: 1 }, who: {} });
    guard.tick(Date.now());
    assert.equal(guard.machine.active().class, 'TAMPER_CONFIRMED');
  } finally { await stop(); }
});

test('"Restore to normal" closes a quarantined incident, and the next attack opens a new one', async () => {
  const { guard, store, stop } = await start();
  try {
    const mismatch = () => store.recordLayerEvent({ layer: 2, trigger: 'record_mismatch', kind: 'record_mismatch', state: 'alert', summary: 's', detail: { record: 4 }, who: {} });
    await mismatch();
    guard.tick(Date.now());
    const first = guard.machine.active();
    guard.decide(first.id, 'soc-lead', 'approve');
    guard.tick(Date.now());
    assert.equal(guard.machine.active().state, 'QUARANTINED');
    // Before the box has reported its lock, the incident must stay quarantined.
    guard.tick(Date.now() + 5000);
    assert.equal(guard.machine.active().state, 'QUARANTINED', 'the order is not "released" before the box acted');
    // The box carries out the quarantine and reports it.
    await store.recordLayerEvent({ layer: 3, trigger: 'quarantine:locked', state: 'alert', summary: 'dry run', detail: { quarantine_id: 'q-1', dry_run: true }, who: {} });
    guard.tick(Date.now() + 6000);
    assert.equal(guard.machine.active().state, 'QUARANTINED', 'still locked');
    // The dashboard's "Restore to normal" resolves everything.
    await store.resolveLayerEvents('restore completed');
    guard.tick(Date.now() + 7000);
    assert.equal(guard.machine.active(), null, 'the incident is closed');
    assert.equal(guard.machine.get(first.id).state, 'RESUMED');
    // A second attack now opens a second incident instead of being swallowed.
    await store.recordLayerEvent({ layer: 2, trigger: 'record_mismatch', kind: 'record_mismatch', state: 'alert', summary: 'again', detail: { record: 9 }, who: {} });
    guard.tick(Date.now() + 8000);
    const second = guard.machine.active();
    assert.ok(second && second.id !== first.id && second.state === 'PENDING');
  } finally { await stop(); }
});
