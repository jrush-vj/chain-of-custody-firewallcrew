// Deterministic incident report. No Bob, no key, no network, no free text.
//
// Every value comes from the containment machine, the classifier's enumerated output, or the witness's own
// ledger. Text from the box (summaries, command arguments, notes) is never copied in: ledger entries are
// cited by seq/hash/time and by a trigger name that must match a strict pattern. The summary is built
// from fixed sentences filled with those verified values.
import { REASON } from '../containment.js';
import { checkChain, reportHash } from './verify.js';

const SAFE_NAME = /^[a-z0-9:_.-]{1,48}$/;
const LOOKBACK_S = 300; // layer events up to five minutes before the incident opened belong to it
const cite = (record) => ({ seq: record.seq, hash: record.hash, recorded_at: record.recorded_at });
const safeName = (value) => (typeof value === 'string' && SAFE_NAME.test(value) ? value : '(unrecognised)');

const OPEN_ITEMS = Object.freeze({
  PENDING: 'An approver has not yet decided (approve, deny or extend).',
  QUARANTINED: 'The quarantine was ordered; the break-glass unlock (2 of 3 key-holders) has not been recorded.',
  SEALED: 'The box remains sealed until a verified clean reconnect or an approver decision.',
  UNSTABLE: 'The link is flapping; a human must clear it before any automatic action resumes.'
});

export const buildReport = ({ incident, records, config, now = new Date(), narrative: given = null }) => {
  const opened = incident.opened_at;
  const inWindow = (record) => {
    const at = Date.parse(record.recorded_at) / 1000;
    return at >= opened - LOOKBACK_S;
  };

  const layers = records
    .filter((record) => record.action === 'layer_event' && inWindow(record) && !String(record.payload.trigger).startsWith('guard:'))
    .map((record) => ({
      ...cite(record), layer: [1, 2, 3].includes(record.payload.layer) ? record.payload.layer : null,
      trigger: safeName(record.payload.trigger), kind: safeName(record.payload.kind || '')
    }));
  const containment = records
    .filter((record) => record.action === 'layer_event' && record.payload.trigger?.startsWith('guard:')
      && record.payload.trigger !== 'guard:report' && record.payload.detail?.incident === incident.id)
    .map((record) => ({
      ...cite(record), from: record.payload.detail.from ? safeName(String(record.payload.detail.from).toLowerCase()) : 'start',
      to: safeName(String(record.payload.detail.to).toLowerCase()), approver: safeName(record.payload.detail.approver || 'none')
    }));

  const cited = [...layers, ...containment].map((entry) => entry.seq);
  const first = cited.length ? Math.min(...cited) : null;
  const last = cited.length ? Math.max(...cited) : null;
  const chain = checkChain(records);
  const verdict = incident.verdict || { class: incident.class, reasons: [], evidence: [], seq: null, flags: [] };
  const approvers = containment.map((entry) => entry.approver).filter((name) => name !== 'none');

  const summary = [
    `Incident ${incident.id} was classified ${incident.class} (${REASON[incident.class] || 'see evidence'}).`,
    `The witness checked its own ledger chain over ${chain.checked} records and found it ${chain.ok ? 'intact' : 'BROKEN'}.`,
    `Containment state is ${incident.state}${approvers.length ? `, with decisions by ${[...new Set(approvers)].join(', ')}` : ''}.`,
    verdict.seq !== null && verdict.seq !== undefined ? `The first disagreeing record is ledger entry ${verdict.seq}.` : null
  ].filter(Boolean);

  // The narrative is optional and always labelled; the template above stands without it.
  const narrative = given || (config.reportNarrative === 'off'
    ? { mode: 'off', status: 'not requested', text: null }
    : { mode: config.reportNarrative, status: 'not requested', text: null });

  const report = {
    version: 1,
    report_id: `r-${incident.id}-${records.length}`,
    incident: {
      id: incident.id, class: incident.class, state: incident.state,
      opened_at: new Date(opened * 1000).toISOString(), extensions: incident.extensions
    },
    generated_at: now.toISOString(),
    detection: {
      // The witness stamps its own receive time on every entry; the box's clock is not trusted or reported.
      box_clock: 'not reported',
      witness_received_at: containment.length ? containment[0].recorded_at : null
    },
    classification: {
      class: verdict.class, reasons: verdict.reasons, flags: verdict.flags,
      evidence: verdict.evidence, seq: verdict.seq ?? null
    },
    layers,
    containment,
    seq_range: cited.length
      ? { first, last, first_hash: records[first - 1].hash, last_hash: records[last - 1].hash }
      : null,
    chain_verification: { ok: chain.ok, checked_records: chain.checked, head_seq: chain.head_seq, head_hash: chain.head_hash },
    scope: 'One protected bank host and its witness copy. Evidence is what the witness itself holds; box-reported signals are marked weak.',
    open_items: [OPEN_ITEMS[incident.state]].filter(Boolean),
    sign_off: { prepared_by: 'witness (automatic)', reviewed_by: null, approved_by: null, signed_at: null },
    summary,
    narrative
  };
  report.sha256 = reportHash(report);
  return report;
};
