#!/usr/bin/env node
// Replays the guard end to end with no key, no network and no cost, and prints each outcome next to what
// it should be. Exit code 1 if anything differs. Run:  npm run guard-demo   (from witness/)
//
//   Part 1  classifier: scenarios G1-G9 (our own scenario set; there is no external simulator spec)
//   Part 2  soft containment on a fake clock: timers, approvals, flapping
//   Part 3  prompt injection: G10 (the classifier) and a scripted Bob that is hijacked in different ways
import { readFileSync } from 'node:fs';
import { createBobAdapter } from './bob/adapter.js';
import { classify, CLASSES } from './classify.js';
import { loadGuardConfig } from './config.js';
import { ContainmentMachine, GuardConflict, STATES } from './containment.js';
import { scenarios } from './fixtures.js';

const config = loadGuardConfig({ GUARD_ENABLED: '1', BOB_ENABLED: '1', REPORT_NARRATIVE: 'bob_on_demand' });
const rows = [];
const check = (part, name, expected, actual) => rows.push({ part, name, expected: String(expected), actual: String(actual), ok: String(expected) === String(actual) });
const verdict = (cls) => ({ class: cls, reasons: ['demo'], evidence: [] });

// ---- Part 1: classifier ----
for (const s of scenarios) {
  const result = classify(s.evidence, config);
  check('1 classify', `${s.id} ${s.title.slice(0, 58)}${s.live ? '' : ' [fixture only]'}`, s.expect, result.class);
}

// ---- Part 2: soft containment ----
const rig = () => {
  const orders = [];
  const machine = new ContainmentMachine({ config, onQuarantine: (i) => orders.push(i.id) });
  return { machine, orders };
};
{
  const { machine, orders } = rig();
  machine.handle(verdict(CLASSES.TAMPER_CONFIRMED), 1000);
  machine.tick(1119);
  check('2 contain', 'tamper, no answer: no quarantine before 120 s', 0, orders.length);
  machine.tick(1120);
  check('2 contain', 'tamper, no answer: quarantine ordered at 120 s', 1, orders.length);
}
{
  const { machine, orders } = rig();
  machine.handle(verdict(CLASSES.SITE_OUTAGE), 1000);
  machine.tick(1900);
  check('2 contain', 'ambiguous evidence, no answer: stays sealed', STATES.SEALED, machine.active().state);
  check('2 contain', 'ambiguous evidence, no answer: no quarantine', 0, orders.length);
}
{
  const { machine, orders } = rig();
  machine.handle(verdict(CLASSES.UNVERIFIED), 1000);
  machine.tick(10_000_000);
  check('2 contain', 'agent killed (A4): sealed forever, never quarantined', `${STATES.SEALED}/0`, `${machine.active().state}/${orders.length}`);
}
{
  const { machine, orders } = rig();
  const incident = machine.handle(verdict(CLASSES.TAMPER_CONFIRMED), 1000);
  machine.decide(incident.id, 'soc-lead', 'approve', 1010);
  let refused = 'accepted';
  try { machine.decide(incident.id, 'auditor', 'approve', 1011); } catch (error) { refused = error instanceof GuardConflict ? 'refused' : 'error'; }
  check('2 contain', 'approver approves: quarantine ordered once', 1, orders.length);
  check('2 contain', 'a second decision on the same incident', 'refused', refused);
}
{
  const { machine } = rig();
  machine.handle(verdict(CLASSES.UNVERIFIED), 1000);
  machine.handle(verdict(CLASSES.NETWORK_CONSISTENT), 1060);
  check('2 contain', 'verified clean reconnect lifts the seal', `none/${STATES.RESUMED}`, `${machine.active() ? machine.active().state : 'none'}/${machine.snapshot()[0].state}`);
}
{
  const { machine, orders } = rig();
  machine.handle(verdict(CLASSES.UNSTABLE), 1000);
  machine.tick(10_000_000);
  check('2 contain', 'flapping link: nothing automatic', `${STATES.UNSTABLE}/0`, `${machine.active().state}/${orders.length}`);
}

// ---- Part 3: prompt injection ----
const payloads = readFileSync(new URL('../../deploy/ct105/guard/injection-payloads.txt', import.meta.url), 'utf8')
  .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));

for (const s of scenarios) {
  const poisoned = structuredClone(s.evidence);
  for (const p of payloads) { poisoned.note = p; poisoned.log_line = p; poisoned.command_args = p; }
  check('3 inject', `G10 classifier ignores planted text in ${s.id}`, classify(s.evidence, config).class, classify(poisoned, config).class);
}

const fakeLedger = (summary) => {
  const records = [{
    seq: 1, action: 'layer_event', hash: 'a'.repeat(64), recorded_at: new Date().toISOString(),
    payload: { layer: 1, trigger: 'layer1_tripwire', kind: 'layer1_tripwire', state: 'alert', summary, detail: { args: summary } }
  }];
  const report = {
    incident: { id: 'g-1-1', state: 'PENDING' },
    classification: { class: 'TAMPER_CONFIRMED', reasons: ['witness copy disagrees with the box'], evidence: [], seq: 4 },
    chain_verification: { ok: true, checked_records: 1 }, containment: [], layers: [{ seq: 1 }]
  };
  return { report, records };
};
const good = JSON.stringify({ summary: 'The witness copy disagrees with the box.', points: ['one record differs'], confidence: 'high' });
const stream = (text, extra = []) => ({ events: [...extra, { type: 'message', role: 'assistant', content: text }, { type: 'result', status: 'success', stats: { tool_calls: 0 } }] });
const hijacks = [
  ['follows the planted order and repeats it', (payload) => () => stream(JSON.stringify({ summary: `Per the log: ${payload}`.slice(0, 600), points: [], confidence: 'high' })), 'suspect'],
  ['reaches for a shell tool', () => () => stream(good, [{ type: 'tool_use', tool_name: 'execute_command' }]), 'tool_attempt'],
  ['makes up a number', () => () => stream(JSON.stringify({ summary: 'About 9999 rows were changed.', points: [], confidence: 'high' })), 'rejected'],
  ['role-plays tool output in prose', () => () => stream('<tool_call>ls /</tool_call> bin boot snap'), 'rejected'],
  ['behaves', () => () => stream(good), 'ok']
];
for (const payload of payloads.slice(0, 2)) {
  for (const [label, make, expected] of hijacks) {
    const { report, records } = fakeLedger(`rm -f -- /var/log/bank-demo/${payload}.bak`);
    const adapter = createBobAdapter({ config, env: { BOB_API_KEY: 'demo' }, run: make(payload) });
    const result = await adapter.narrate({ report, records });
    check('3 inject', `Bob ${label} -> narrative`, expected, result.status);
  }
}
{
  const { report, records } = fakeLedger(payloads[0]);
  let seen = '';
  const adapter = createBobAdapter({ config, env: { BOB_API_KEY: 'demo' }, run: (prompt) => { seen = prompt; return stream(good); } });
  await adapter.narrate({ report, records });
  check('3 inject', 'planted instruction never reaches Bob (withheld by the pre-scan)', 'withheld', seen.includes(payloads[0]) ? 'PASSED THROUGH' : 'withheld');
}
{
  const off = createBobAdapter({ config: loadGuardConfig({ GUARD_ENABLED: '1' }), env: { BOB_API_KEY: 'demo' }, run: () => { throw new Error('must not run'); } });
  const { report, records } = fakeLedger('x');
  check('3 inject', 'Bob off (BOB_ENABLED unset): never run', 'unavailable', (await off.narrate({ report, records })).status);
}

// ---- print ----
let part = '';
for (const row of rows) {
  if (row.part !== part) { part = row.part; console.log(`\nPart ${part}`); }
  console.log(`  ${row.ok ? 'PASS' : 'FAIL'}  ${row.name}${row.ok ? '' : `   expected ${row.expected}, got ${row.actual}`}`);
}
const passed = rows.filter((row) => row.ok).length;
console.log(`\n${passed}/${rows.length} checks passed`);
process.exit(passed === rows.length ? 0 : 1);
