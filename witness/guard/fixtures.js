// Scenario fixtures G1-G10 for the guard classifier. These are our own scenarios (there is no external
// simulator spec); each is modelled on an attack from the cybersec attack list or on the guard plan.
// "live" says whether this repo's witness can produce that evidence today, or only a fixture can.
import { CLASSES } from './classify.js';

const NOW = 1_800_000_000; // fixed clock so every fixture is reproducible

export const scenarios = [
  {
    id: 'G1', live: true, expect: CLASSES.NETWORK_CONSISTENT,
    title: 'Link cut, then reconnect with a clean chain and a matching gap (A9/A13)',
    evidence: { now: NOW, reconnect: { verified: true, chainOk: true, boxEntriesDuringOutage: 7, receivedAfterReconnect: 7 } }
  },
  {
    id: 'G2', live: true, expect: CLASSES.UNVERIFIED,
    title: 'Agent killed, no reconnect (A4)',
    evidence: { now: NOW, silence: { active: true } }
  },
  {
    id: 'G3', live: true, expect: CLASSES.TAMPER_CONFIRMED, expectSeq: 42,
    title: 'A committed record was edited (A7, Layer 2)',
    evidence: { now: NOW, chain: { ok: false, badSeq: 42 }, mismatches: [{ kind: 'changed', seq: 42 }] }
  },
  {
    id: 'G4', live: true, expect: CLASSES.TAMPER_CONFIRMED, expectSeq: 17,
    title: 'Rows deleted or truncated (T1c)',
    evidence: { now: NOW, mismatches: [{ kind: 'missing', seq: 17 }, { kind: 'missing', seq: 18 }] }
  },
  {
    id: 'G5', live: true, expect: CLASSES.BOX_CLAIM_ONLY,
    title: 'Box says "interface down" while valid heartbeats keep arriving',
    evidence: { now: NOW, boxClaims: ['iface_down'], heartbeats: { validRecent: true } }
  },
  {
    id: 'G6', live: true, expect: CLASSES.UNVERIFIED, expectFlag: 'invalid_heartbeats_ignored',
    title: 'Unsigned or replayed heartbeats do not count as liveness (A5)',
    evidence: { now: NOW, silence: { active: true }, heartbeats: { validRecent: false, rejectedRecent: 9 } }
  },
  {
    id: 'G7', live: true, expect: CLASSES.UNSTABLE,
    title: 'Three link cuts inside the flap window',
    evidence: { now: NOW, outages: [NOW - 700, NOW - 400, NOW - 100], silence: { active: true } }
  },
  {
    id: 'G8', live: true, expect: CLASSES.CHALLENGE_FAIL,
    title: 'Challenge-response signature fails',
    evidence: { now: NOW, challenge: { failed: true } }
  },
  {
    id: 'G9a', live: false, expect: CLASSES.SITE_OUTAGE,
    title: 'Several boxes at one site silent together (fixture only: this witness watches one box)',
    evidence: { now: NOW, silence: { active: true }, site: { silentBoxes: 3, totalBoxes: 3 } }
  },
  {
    id: 'G9b', live: false, expect: CLASSES.PROBE_FAIL,
    title: 'Witness probe to the site gateway fails (fixture only: no probe exists yet)',
    evidence: { now: NOW, probe: { witnessUp: true, gatewayOk: false } }
  }
];

// G10 is a property, not a single input: see injection.test in test/guard-classify.test.js.
