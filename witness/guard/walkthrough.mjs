#!/usr/bin/env node
// A guided tour of the guard against the REAL witness server, over real HTTP. No key, no Docker, no cost.
//   node guard/walkthrough.mjs        (from witness/)
//
// What is real: the HTTP server, the signed box requests, approver tokens, the ledger file, the reports and the
// independent verifier. What is simulated: time (the countdowns are fast-forwarded) and the witness's own bank
// comparison (a finding is recorded straight into the ledger, the way the witness does it after a mismatch).
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = randomBytes(12).toString('hex');
process.env.WITNESS_NODE_ID = 'demo-node';
process.env.WITNESS_HMAC_SECRET = randomBytes(24).toString('hex');
process.env.GUARD_ENABLED = '1';
process.env.APPROVERS = JSON.stringify([{ id: 'soc-lead', sha256: createHash('sha256').update(TOKEN).digest('hex') }]);
delete process.env.BOB_ENABLED; // Bob stays OFF
delete process.env.BOB_API_KEY;

const { WitnessStore } = await import('../store.js');
const { createWitnessServer } = await import('../server.js');
const { createGuard } = await import('./guard.js');
const { loadGuardConfig } = await import('./config.js');

const directory = await mkdtemp(path.join(os.tmpdir(), 'coc-walkthrough-'));
const store = new WitnessStore(path.join(directory, 'ledger.jsonl'));
await store.initialize();
const config = loadGuardConfig(process.env);
const guard = createGuard(store, config);
const server = createWitnessServer(store, guard);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

const t0 = Date.now();
const at = (seconds) => t0 + seconds * 1000;
const sign = (method, pathname, body = '') => {
  const ts = String(Date.now());
  return {
    'x-witness-node': process.env.WITNESS_NODE_ID, 'x-witness-timestamp': ts,
    'x-witness-signature': createHmac('sha256', process.env.WITNESS_HMAC_SECRET).update(`${method}\n${pathname}\n${ts}\n${body}`).digest('hex')
  };
};
const approver = { authorization: `Bearer ${TOKEN}`, 'x-approver': 'soc-lead' };
const flush = () => store.enqueue(async () => {});
const state = async () => (await (await fetch(`${base}/guard/state`)).json());
const brief = (s) => {
  const open = s.incidents.filter((i) => i.state !== 'RESUMED');
  const resumed = s.incidents.length - open.length;
  const text = open.map((i) => `${i.class}: ${i.state}${i.state === 'PENDING' && i.deadline ? ` (${Math.round(i.deadline - i.opened_at)} s to decide)` : ''}`).join('; ') || '(no open incident)';
  return resumed ? `${text}   [${resumed} earlier incident resumed]` : text;
};
const step = (n, title) => console.log(`\n== ${n}. ${title}`);
const say = (text) => console.log(`   ${text}`);
const http = async (label, response) => { say(`${label} -> HTTP ${response.status}`); return response; };

console.log(`Witness running at ${base}  (guard ON, Bob OFF, one approver: soc-lead)`);

step(1, 'Fresh start');
let s = await state();
say(`state: ${brief(s)}`);
say(`Bob allowed: ${s.bob_enabled}   report narrative: ${s.report_narrative}`);

step(2, 'A root attacker on the box posts FAKE evidence, signed with the shared secret');
for (const event of [
  { layer: 2, trigger: 'record_mismatch', kind: 'record_mismatch', state: 'alert', summary: 'forged tamper finding', detail: { record: 1 }, who: {} },
  { layer: 2, trigger: 'heartbeat_silence', kind: 'silence', state: 'alert', summary: 'forged silence', detail: {}, who: {} }
]) {
  const body = JSON.stringify(event);
  await http(`POST /v1/layer-events (${event.kind})`, await fetch(`${base}/v1/layer-events`, { method: 'POST', headers: { 'content-type': 'application/json', ...sign('POST', '/v1/layer-events', body) }, body }));
}
guard.tick(at(1));
guard.tick(at(100_000));
say(`state after 27 hours: ${brief(await state())}`);
say('The host\'s word alone never opens an incident, and the ledger records that it came from the host.');
await store.resolveLayerEvents('demo: clearing the forged events', {});

step(3, 'The link goes quiet (the witness itself raises silence)');
await store.recordLayerEvent({ layer: 2, trigger: 'heartbeat_silence', kind: 'silence', state: 'alert', summary: 'no heartbeat', detail: {}, who: {} });
guard.tick(at(10));
say(`state: ${brief(await state())}`);
guard.tick(at(3600));
say(`an hour later: ${brief(await state())}`);
say(`box asks "any orders?" (signed GET /v1/guard-decision): ${JSON.stringify((await (await fetch(`${base}/v1/guard-decision`, { headers: sign('GET', '/v1/guard-decision') })).json()).decision)}`);
say('Sealed, not quarantined: silence alone never locks anyone out.');

step(4, 'The link comes back and the witness verifies it (clean chain, matching gap)');
await store.resolveLayerEvents('heartbeat resumed', { layer: 2, kind: 'silence' });
guard.tick(at(3601));
store.reconciliation = { ...store.reconciliation, state: 'ok', checked_at: new Date(at(3602)).toISOString() };
guard.tick(at(3603));
await flush();
say(`state: ${brief(await state())}`);
say('RESUMED: only after the witness checked its own copy, never during the outage.');

step(5, 'Real tampering: the witness finds a bank row that differs from its copy');
await store.recordLayerEvent({ layer: 2, trigger: 'record_mismatch', kind: 'record_mismatch', state: 'alert', summary: 'row 4 differs from the witness copy', detail: { record: 4 }, who: {} });
guard.tick(at(4000));
s = await state();
const incident = s.incidents.find((i) => i.state === 'PENDING');
say(`state: ${brief(s)}`);
const decide = (headers, choice) => fetch(`${base}/guard/approvals/${incident.id}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ choice }) });
await http('approve with NO token', await decide({}, 'approve'));
await http('approve with a WRONG token', await decide({ authorization: 'Bearer nope', 'x-approver': 'soc-lead' }, 'approve'));
guard.tick(at(4119));
say(`119 s in, nobody has answered: ${brief(await state())}   (no quarantine yet)`);
await http('approve with the real token', await decide(approver, 'approve'));
await http('a second approval on the same incident', await decide(approver, 'approve'));
say(`state: ${brief(await state())}`);
const order = (await (await fetch(`${base}/v1/guard-decision`, { headers: sign('GET', '/v1/guard-decision') })).json()).decision;
say(`box polls and receives the order: ${JSON.stringify(order)}`);
say('The box then runs the EXISTING quarantine. This module only ever orders it.');
const ackBody = JSON.stringify({ id: order.id });
await fetch(`${base}/v1/guard-ack`, { method: 'POST', headers: { 'content-type': 'application/json', ...sign('POST', '/v1/guard-ack', ackBody) }, body: ackBody });
say(`after the box acknowledges: order = ${JSON.stringify(guard.pendingDecision())}`);

step(6, 'The incident report: built from the ledger, no key, no Bob');
for (let i = 0; i < 150 && !guard.listReports().some((r) => r.incident === incident.id); i += 1) await new Promise((r) => setTimeout(r, 20));
await flush();
const list = (await (await fetch(`${base}/guard/reports`)).json()).reports;
say(`reports in the ledger: ${list.map((r) => `${r.report_id} (verified: ${r.verified})`).join(', ')}`);
const report = await (await fetch(`${base}/guard/reports/${list.find((r) => r.incident === incident.id).report_id}`)).json();
for (const line of report.summary) say(`> ${line}`);
say(`narrative: ${report.narrative.mode} / ${report.narrative.status}`);
say(`containment steps cited from the ledger: ${report.containment.map((c) => `#${c.seq} ${c.from}->${c.to} by ${c.approver}`).join(', ')}`);

step(7, 'Check the report independently, with no witness running');
const cli = fileURLToPath(new URL('./report/verify-cli.js', import.meta.url));
const good = path.join(directory, 'report.json');
await writeFile(good, JSON.stringify(report));
const ok = spawnSync(process.execPath, [cli, store.filePath, good], { encoding: 'utf8' });
say(`verify-cli on the real report: exit ${ok.status}: ${ok.stdout.trim()}`);
const forged = structuredClone(report);
forged.containment[0].approver = 'attacker';
forged.containment[0].seq += 1;
const bad = path.join(directory, 'forged.json');
await writeFile(bad, JSON.stringify(forged));
const no = spawnSync(process.execPath, [cli, store.filePath, bad], { encoding: 'utf8' });
say(`verify-cli on a doctored copy: exit ${no.status}: ${no.stdout.trim().split('\n')[0]}`);

step(8, 'Bob is OFF: nothing can start a paid run');
await http('POST /guard/incidents/<id>/narrative (with approver token)', await fetch(`${base}/guard/incidents/${incident.id}/narrative`, { method: 'POST', headers: approver }));
await http('POST /v1/diagnose-request (the dashboard button)', await fetch(`${base}/v1/diagnose-request`, { method: 'POST', body: '{}' }));
say(`state API reports bob_enabled: ${(await state()).bob_enabled}`);

step(9, 'What the ledger now holds (every guard decision, tamper-evident)');
for (const record of store.records.filter((r) => r.payload && String(r.payload.trigger).startsWith('guard:') && r.payload.trigger !== 'guard:report')) {
  const d = record.payload.detail;
  say(`#${String(record.seq).padStart(2)} ${record.payload.trigger.padEnd(18)} ${d.from || ''}${d.from ? ' -> ' : ''}${d.to || ''}  ${d.why || ''}${d.approver ? `  [by ${d.approver}]` : ''}`);
}
const { checkChain } = await import('./report/verify.js');
say(`ledger chain: ${JSON.stringify(checkChain(store.records)).slice(0, 80)}...`);

server.close();
await rm(directory, { recursive: true, force: true });
console.log('\nDone. Nothing was written outside a temp folder, which is now deleted.');
process.exit(0);
