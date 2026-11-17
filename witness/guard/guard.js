// Wires the classifier and the containment machine to the witness store. Witness-side only.
//
// Reads what the witness itself knows (its ledger, its row copies, its heartbeats), classifies it, and
// drives the containment machine. It never contacts the box: the box polls GET /v1/guard-decision and
// performs the EXISTING quarantine itself. Every transition and decision is written to the ledger as a
// layer-3 event with state "normal" and a "guard:" trigger, so it is tamper-evident and does not light up
// any layer card.
import { classify } from './classify.js';
import { ContainmentMachine, STATES } from './containment.js';
import { authenticateApprover, parseApprovers } from './approvals.js';
import { loadGuardConfig } from './config.js';
import { buildReport } from './report/template.js';
import { verifyReport } from './report/verify.js';
import { createBobAdapter } from './bob/adapter.js';

// Open Layer 2 findings the witness itself established by comparing its own copy.
const TAMPER_KIND = { record_mismatch: 'changed', entry_edited: 'changed', entry_deleted: 'missing', db_edited_without_log: 'unwitnessed' };

const DECISION_SUMMARY = Object.freeze({
  SEALED: 'guard: sealed (unverified; no lockout)',
  PENDING: 'guard: waiting for an approver',
  QUARANTINED: 'guard: existing quarantine ordered',
  RESUMED: 'guard: resumed (seal lifted)',
  UNSTABLE: 'guard: link flapping; human needed'
});

export const createGuard = (store, config = loadGuardConfig(), { bob: bobOverride, bobRun, bobEnv } = {}) => {
  const approvers = parseApprovers(config.approversRaw);
  const tracker = { silent: false, outages: [], atStart: null, reconnectAt: null, reconnect: null };
  let pendingOrder = null; // the quarantine the box has not yet picked up

  const record = (transition) => store.recordLayerEvent({
    layer: 3,
    trigger: `guard:${transition.to.toLowerCase()}`,
    state: 'normal',
    summary: DECISION_SUMMARY[transition.to],
    // Flat strings from fixed vocabularies only; the approver id is validated at configuration time.
    detail: {
      incident: transition.id, from: transition.from, to: transition.to, class: transition.class,
      why: transition.why, approver: transition.approver || ''
    },
    who: {}
  }).catch((error) => console.error('guard: could not record transition:', error.message));

  const machine = new ContainmentMachine({
    config,
    onTransition: (transition) => {
      record(transition);
      // An incident that concluded gets its report automatically; the others are on request.
      if (transition.to === STATES.QUARANTINED || transition.to === STATES.RESUMED) {
        generateReport(transition.id).catch((error) => console.error('guard: could not record report:', error.message));
      }
    },
    onQuarantine: (incident) => {
      pendingOrder = { id: incident.id, action: 'quarantine', reason: `guard: ${incident.class.toLowerCase().replace(/_/g, ' ')}` };
    }
  });

  // Bob's side effects on the ledger: a tool-call attempt is a tamper event; instruction-like input is a warning.
  const bobEvent = (event) => {
    const entry = event.type === 'tool_attempt'
      ? { trigger: 'guard:bob_tool_attempt', state: 'alert', summary: 'guard: Bob tried to call a tool (it has none; blocked)', detail: { tools: event.tools.join(','), count: String(event.count) } }
      : { trigger: 'guard:provenance_warning', state: 'normal', summary: 'guard: instruction-like text withheld from Bob', detail: { ref: event.ref, field: event.field, rule: event.rule, rules: (event.rules || [event.rule]).join(','), chars: String(event.chars) } };
    store.recordLayerEvent({ layer: 3, ...entry, who: {} }).catch((error) => console.error('guard: could not record Bob event:', error.message));
  };
  // bobRun / bobEnv let tests script Bob; in production both are undefined and the real CLI runner is used.
  const bob = bobOverride || createBobAdapter({ config, run: bobRun, env: bobEnv || process.env, onEvent: bobEvent });

  // Build a report from the witness's own ledger and store it in that ledger (so it is tamper-evident too).
  // With narrate=true (or REPORT_NARRATIVE=bob_auto for a concluded incident) Bob adds a labelled note; if
  // Bob is off, keyless, fails validation or tries a tool, the template stands alone and says why.
  async function generateReport(incidentId, { narrate = false } = {}) {
    const incident = machine.get(incidentId);
    if (!incident) return null;
    await store.enqueue(async () => {}); // let queued transition entries reach the ledger first
    let report = buildReport({ incident, records: store.records, config });
    const mode = config.reportNarrative;
    if (mode !== 'off' && (narrate || mode === 'bob_auto')) {
      const result = await bob.narrate({ report, records: store.records });
      await store.enqueue(async () => {}); // Bob's own ledger events first
      const narrative = result.status === 'ok'
        ? { mode, status: 'ok', source: 'IBM Bob (AI-written; not verified)', text: result.value.summary, points: result.value.points, confidence: result.value.confidence }
        : { mode, status: result.status, reason: result.reason, text: null };
      report = buildReport({ incident, records: store.records, config, narrative });
    }
    await store.recordLayerEvent({
      layer: 3, trigger: 'guard:report', state: 'normal', summary: 'guard: incident report recorded',
      detail: { report_id: report.report_id, incident: incident.id, sha256: report.sha256, body: JSON.stringify(report) },
      who: {}
    });
    return report;
  }

  const storedReports = () => store.records
    .filter((record) => record.action === 'layer_event' && record.payload.trigger === 'guard:report')
    .map((record) => { try { return JSON.parse(record.payload.detail.body); } catch { return null; } })
    .filter(Boolean);

  // A report is only ever returned if it verifies against the ledger as it is now.
  const listReports = () => storedReports().map((report) => ({
    report_id: report.report_id, incident: report.incident.id, generated_at: report.generated_at,
    verified: verifyReport(report, store.records).ok
  }));
  const getReport = (id) => {
    const report = storedReports().find((item) => item.report_id === id);
    if (!report) return { status: 404 };
    const result = verifyReport(report, store.records);
    return result.ok ? { status: 200, report } : { status: 409, problems: result.problems };
  };

  // An open alert the WITNESS raised itself. Events the box posted are the box's word, not evidence.
  const openWitnessEvent = (kind) => store.recentLayerEvents().some((item) => item.kind === kind && item.state === 'alert' && !item.resolved && item.origin !== 'box');

  const bankCount = () => (store.bankView ? store.bankView.count : 0);

  const buildEvidence = (nowMs) => {
    const silence = openWitnessEvent('silence');
    if (silence && !tracker.silent) {
      tracker.silent = true;
      tracker.outages.push(nowMs / 1000);
      tracker.atStart = { bank: bankCount(), copies: store.copies.size };
      tracker.reconnect = null;
      tracker.reconnectAt = null;
    } else if (!silence && tracker.silent) {
      tracker.silent = false;
      tracker.reconnectAt = nowMs;
    }
    const mismatches = store.recentLayerEvents().filter((item) => item.state === 'alert' && !item.resolved && item.origin !== 'box' && TAMPER_KIND[item.kind])
      .map((item) => ({ kind: TAMPER_KIND[item.kind], seq: Number.isInteger(item.id) ? item.id : null }));
    const chainOk = !store.integrityError;
    // After the link returns, wait for the witness's own bank comparison to run again before trusting it.
    if (tracker.reconnectAt !== null && !tracker.reconnect) {
      const checkedAt = store.reconciliation && store.reconciliation.checked_at ? Date.parse(store.reconciliation.checked_at) : 0;
      if (checkedAt > tracker.reconnectAt && store.reconciliation.state !== 'unavailable') {
        tracker.reconnect = {
          verified: true,
          chainOk: chainOk && mismatches.length === 0,
          boxEntriesDuringOutage: Math.max(0, bankCount() - tracker.atStart.bank),
          receivedAfterReconnect: Math.max(0, store.copies.size - tracker.atStart.copies)
        };
      }
    }
    const promised = store.lastHeartbeatPromisedS || 30;
    return {
      now: nowMs / 1000,
      silence: { active: silence },
      reconnect: tracker.reconnect,
      chain: { ok: chainOk },
      mismatches,
      challenge: { failed: openWitnessEvent('bad_challenge_signature') },
      outages: tracker.outages,
      heartbeats: { validRecent: Boolean(store.lastHeartbeatAt) && nowMs - store.lastHeartbeatAt < promised * 2000 }
    };
  };

  // Called every few seconds by the witness.
  const tick = (nowMs = Date.now()) => {
    const nowS = nowMs / 1000;
    const verdict = classify(buildEvidence(nowMs), config);
    machine.handle(verdict, nowS);
    machine.tick(nowS);
    if (verdict.class === 'NETWORK_CONSISTENT') tracker.reconnect = null; // consumed
    // The existing break-glass release closes a quarantined incident.
    const live = machine.active();
    if (live && live.state === STATES.QUARANTINED) {
      const released = store.recentLayerEvents().some((item) => item.layer === 3 && item.trigger === 'quarantine:released' && item.id > (live.updated_at_seq || 0)
        && Date.parse(item.recorded_at) / 1000 >= live.updated_at);
      if (released) machine.release(live.id, nowS);
    }
    return verdict;
  };

  const decide = (id, approver, choice, nowMs = Date.now()) => machine.decide(id, approver, choice, nowMs / 1000);

  return {
    config,
    machine,
    tick,
    decide,
    generateReport,
    listReports,
    getReport,
    authenticate: (headers) => authenticateApprover(headers, approvers),
    approversConfigured: approvers.length > 0,
    // What the box asks for with a signed GET. Returns the order once per incident until the box acts.
    pendingDecision: () => pendingOrder,
    acknowledge: (id) => { if (pendingOrder && pendingOrder.id === id) pendingOrder = null; },
    state: () => ({
      enabled: true,
      bob_enabled: config.bobAllowed,
      report_narrative: config.reportNarrative,
      approvals: approvers.length > 0 ? 'configured' : 'no approvers configured (approvals refused)',
      incidents: machine.snapshot()
    })
  };
};
