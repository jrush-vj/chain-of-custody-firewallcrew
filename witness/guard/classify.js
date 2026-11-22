// Alarm classifier. A pure function: evidence in, verdict out. No I/O, no clock, no network, no Bob.
//
// It reads ONLY structured, whitelisted fields (booleans, finite numbers, and strings from fixed sets).
// Free text (command arguments, log lines, notes, anything an attacker can write) is never read, and no
// input string is ever copied into the result. That is what makes it immune to prompt injection: there is
// no path from attacker-controlled text to a verdict or to the report text built from it.
//
// Evidence is witness-side. Box-reported signals are weak: they can only produce BOX_CLAIM_ONLY and never
// TAMPER_CONFIRMED on their own.
import { loadGuardConfig } from './config.js';

export const CLASSES = Object.freeze({
  TAMPER_CONFIRMED: 'TAMPER_CONFIRMED',
  NETWORK_CONSISTENT: 'NETWORK_CONSISTENT',
  SITE_OUTAGE: 'SITE_OUTAGE',
  PROBE_FAIL: 'PROBE_FAIL',
  BOX_CLAIM_ONLY: 'BOX_CLAIM_ONLY',
  CHALLENGE_FAIL: 'CHALLENGE_FAIL',
  UNSTABLE: 'UNSTABLE',
  UNVERIFIED: 'UNVERIFIED',
  NONE: 'NONE'
});

// Mismatch kinds the witness itself can establish by comparing its own copy.
const WITNESS_TAMPER_KINDS = new Set(['changed', 'missing', 'unwitnessed', 'chain']);
// Signals only the box reports about itself.
const BOX_CLAIM_KINDS = new Set(['iface_down', 'log_size_changed', 'inode_changed', 'agent_stopping']);

const bool = (value) => value === true;
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
const epoch = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
const seq = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
const fromSet = (value, set, fallback) => (typeof value === 'string' && set.has(value) ? value : fallback);

// Reduce arbitrary input to the whitelisted shape. Anything not listed here is dropped.
export const normalize = (raw) => {
  const input = raw && typeof raw === 'object' ? raw : {};
  const silence = input.silence && typeof input.silence === 'object' ? input.silence : {};
  const reconnect = input.reconnect && typeof input.reconnect === 'object' ? input.reconnect : null;
  const chain = input.chain && typeof input.chain === 'object' ? input.chain : {};
  const challenge = input.challenge && typeof input.challenge === 'object' ? input.challenge : {};
  const site = input.site && typeof input.site === 'object' ? input.site : {};
  const probe = input.probe && typeof input.probe === 'object' ? input.probe : {};
  const heartbeats = input.heartbeats && typeof input.heartbeats === 'object' ? input.heartbeats : {};
  return {
    now: epoch(input.now),
    silenceActive: bool(silence.active),
    reconnect: reconnect && {
      verified: bool(reconnect.verified), // the witness compared its own copy after the link came back
      chainOk: bool(reconnect.chainOk),
      boxEntriesDuringOutage: count(reconnect.boxEntriesDuringOutage),
      receivedAfterReconnect: count(reconnect.receivedAfterReconnect)
    },
    chainOk: chain.ok !== false, // absent means no chain problem was found
    chainBadSeq: seq(chain.badSeq),
    mismatches: (Array.isArray(input.mismatches) ? input.mismatches : []).slice(0, 200).map((item) => ({
      kind: fromSet(item && item.kind, WITNESS_TAMPER_KINDS, 'other'),
      seq: seq(item && item.seq)
    })),
    challengeFailed: bool(challenge.failed),
    silentBoxes: count(site.silentBoxes),
    totalBoxes: count(site.totalBoxes),
    probeGatewayOk: probe.gatewayOk === true ? true : probe.gatewayOk === false ? false : null,
    probeWitnessUp: bool(probe.witnessUp),
    validHeartbeatRecent: bool(heartbeats.validRecent),
    rejectedHeartbeats: count(heartbeats.rejectedRecent),
    boxClaims: (Array.isArray(input.boxClaims) ? input.boxClaims : [])
      .map((kind) => fromSet(kind, BOX_CLAIM_KINDS, null)).filter(Boolean).slice(0, 20),
    outages: (Array.isArray(input.outages) ? input.outages : []).map(epoch).filter((t) => t !== null).slice(-200)
  };
};

const verdict = (cls, reasons, used, extra = {}) =>
  Object.freeze({ class: cls, reasons: Object.freeze(reasons), evidence: Object.freeze(used), ...extra });

export const classify = (raw, config = loadGuardConfig()) => {
  const e = normalize(raw);
  const used = [];
  const use = (signal, value, source = 'witness') => used.push({ signal, value, source });

  // 1. Hard evidence from the witness's own copy.
  const badSeqs = e.mismatches.filter((m) => WITNESS_TAMPER_KINDS.has(m.kind)).map((m) => m.seq);
  const chainBroken = !e.chainOk || (e.reconnect && e.reconnect.verified && !e.reconnect.chainOk);
  if (chainBroken || badSeqs.length > 0) {
    if (!e.chainOk) use('chain_ok', false);
    if (e.reconnect && e.reconnect.verified && !e.reconnect.chainOk) use('reconnect_chain_ok', false);
    for (const m of e.mismatches) use(`mismatch_${m.kind}`, m.seq);
    const where = e.chainBadSeq !== null ? e.chainBadSeq : badSeqs.find((s) => s !== null) ?? null;
    return verdict(CLASSES.TAMPER_CONFIRMED, ['witness copy disagrees with the box'], used, { seq: where });
  }

  // 2. A failed challenge proves the key is not held, nothing more.
  if (e.challengeFailed) {
    use('challenge_failed', true);
    return verdict(CLASSES.CHALLENGE_FAIL, ['challenge-response failed; key possession not shown'], used);
  }

  // 3. Flapping stops anything automatic.
  if (e.now !== null) {
    const recent = e.outages.filter((t) => t <= e.now && e.now - t <= config.flapWindowS);
    if (recent.length >= config.flapMax) {
      use('outages_in_window', recent.length);
      return verdict(CLASSES.UNSTABLE, [`${recent.length} outages within ${config.flapWindowS} s`], used);
    }
  }

  // 4. Only after reconnect verification, and only if the gap matches what the box wrote.
  if (e.reconnect && e.reconnect.verified) {
    use('reconnect_verified', true);
    use('reconnect_chain_ok', true);
    use('box_entries_during_outage', e.reconnect.boxEntriesDuringOutage, 'box');
    use('received_after_reconnect', e.reconnect.receivedAfterReconnect);
    if (e.reconnect.boxEntriesDuringOutage === e.reconnect.receivedAfterReconnect) {
      return verdict(CLASSES.NETWORK_CONSISTENT, ['clean chain on reconnect; gap equals entries written during the outage'], used);
    }
    return verdict(CLASSES.UNVERIFIED, ['gap does not match the entries the box says it wrote'], used, { gapMismatch: true });
  }

  // 5. Silence, with no verified reconnect yet.
  if (e.silenceActive) {
    use('silence', true);
    if (e.silentBoxes >= 2 && e.totalBoxes >= e.silentBoxes) {
      use('silent_boxes', e.silentBoxes);
      return verdict(CLASSES.SITE_OUTAGE, ['several boxes at the site went silent together'], used);
    }
    if (e.probeWitnessUp && e.probeGatewayOk === false) {
      use('probe_gateway_ok', false);
      return verdict(CLASSES.PROBE_FAIL, ['the witness cannot reach the site gateway'], used);
    }
    const flags = [];
    if (e.rejectedHeartbeats > 0 && !e.validHeartbeatRecent) {
      use('rejected_heartbeats', e.rejectedHeartbeats);
      flags.push('invalid_heartbeats_ignored');
    }
    return verdict(CLASSES.UNVERIFIED, ['silent, and no verified reconnect yet'], used, { flags: Object.freeze(flags) });
  }

  // 6. A probe failure with no silence is still a witness-side fact.
  if (e.probeWitnessUp && e.probeGatewayOk === false) {
    use('probe_gateway_ok', false);
    return verdict(CLASSES.PROBE_FAIL, ['the witness cannot reach the site gateway'], used);
  }

  // 7. Only the box says something is wrong: weak, never contains.
  if (e.boxClaims.length > 0) {
    for (const kind of e.boxClaims) use(`box_claim_${kind}`, true, 'box');
    return verdict(CLASSES.BOX_CLAIM_ONLY, ['only the box reports a problem; the witness sees none'], used);
  }

  return verdict(CLASSES.NONE, ['no alarm'], used);
};
