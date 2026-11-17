// Soft containment: a state machine that sits in front of the existing Layer 3 quarantine.
//
//   SEALED       unverified or ambiguous: box marked unverified, no lockout; waits for a verified reconnect
//   PENDING      a human must decide (approve / deny / extend) before a countdown ends
//   QUARANTINED  the existing quarantine was ordered (this module never performs it)
//   RESUMED      a verified clean reconnect lifted the seal (terminal)
//   UNSTABLE     flapping: nothing automatic; a human clears it (terminal once cleared)
//
// Pure logic. Time is passed in (seconds), side effects go through two callbacks, and nothing here
// reads files, the network or Bob. The quarantine itself is only ever *ordered* through onQuarantine.
import { CLASSES } from './classify.js';

export const STATES = Object.freeze({
  SEALED: 'SEALED', PENDING: 'PENDING', QUARANTINED: 'QUARANTINED', RESUMED: 'RESUMED', UNSTABLE: 'UNSTABLE'
});

export class GuardConflict extends Error {
  constructor(message) { super(message); this.statusCode = 409; }
}
export class GuardNotFound extends Error {
  constructor(message) { super(message); this.statusCode = 404; }
}

const MAX_EXTENSIONS = 3;
const OPEN = new Set([STATES.SEALED, STATES.PENDING, STATES.UNSTABLE]);
// Fixed, attacker-proof wording for each reason; no input text is ever copied in.
const REASON = Object.freeze({
  TAMPER_CONFIRMED: 'the witness copy disagrees with the box',
  SITE_OUTAGE: 'several boxes at the site went silent together',
  PROBE_FAIL: 'the witness cannot reach the site gateway',
  UNVERIFIED: 'the box is silent and has not reconnected',
  UNSTABLE: 'the link keeps dropping',
  CHALLENGE_FAIL: 'challenge-response failed'
});

export class ContainmentMachine {
  constructor({ config, onQuarantine = () => {}, onTransition = () => {} }) {
    this.config = config;
    this.onQuarantine = onQuarantine;
    this.onTransition = onTransition;
    this.incidents = new Map();
    this.counter = 0;
  }

  active() {
    return [...this.incidents.values()].find((item) => OPEN.has(item.state) || item.state === STATES.QUARANTINED) || null;
  }

  move(incident, to, now, why, approver = null) {
    const from = incident.state;
    incident.state = to;
    incident.updated_at = now;
    this.onTransition({ id: incident.id, from, to, class: incident.class, why, approver, at: now });
    return incident;
  }

  open(cls, state, now, deadline, defaultAction, why) {
    this.counter += 1;
    const incident = {
      id: `g-${Math.floor(now)}-${this.counter}`, class: cls, state: null, opened_at: now, updated_at: now,
      deadline, default_action: defaultAction, extensions: 0, auto_quarantine: defaultAction === 'quarantine'
    };
    this.incidents.set(incident.id, incident);
    return this.move(incident, state, now, why);
  }

  // Feed one classifier verdict. Idempotent: the same verdict twice changes nothing.
  handle(verdict, now) {
    const cls = verdict.class;
    const live = this.active();
    const reason = REASON[cls] || 'no alarm';

    if (cls === CLASSES.TAMPER_CONFIRMED) {
      if (live && live.state === STATES.QUARANTINED) return live;
      const deadline = now + this.config.tamperTimeoutS;
      if (live && live.state === STATES.PENDING && live.default_action === 'quarantine') return live;
      if (live && (live.state === STATES.PENDING || live.state === STATES.SEALED || live.state === STATES.UNSTABLE)) {
        // Upgrade an ambiguous or sealed incident: tamper evidence is the stronger fact.
        live.class = cls; live.deadline = deadline; live.default_action = 'quarantine'; live.auto_quarantine = true;
        return this.move(live, STATES.PENDING, now, reason);
      }
      return this.open(cls, STATES.PENDING, now, deadline, 'quarantine', reason);
    }

    if (cls === CLASSES.NETWORK_CONSISTENT) {
      if (live && (live.state === STATES.SEALED || (live.state === STATES.PENDING && live.default_action !== 'quarantine'))) {
        return this.move(live, STATES.RESUMED, now, 'verified clean reconnect; gap matches');
      }
      return live;
    }

    if (cls === CLASSES.UNSTABLE) {
      if (live && live.state === STATES.QUARANTINED) return live;
      if (live && live.state === STATES.UNSTABLE) return live;
      if (live) {
        live.auto_quarantine = false; // flapping stops anything automatic
        return this.move(live, STATES.UNSTABLE, now, reason);
      }
      return this.open(cls, STATES.UNSTABLE, now, null, 'none', reason);
    }

    if (cls === CLASSES.SITE_OUTAGE || cls === CLASSES.PROBE_FAIL) {
      if (live) return live;
      return this.open(cls, STATES.PENDING, now, now + this.config.ambiguousTimeoutS, 'stay_sealed', reason);
    }

    if (cls === CLASSES.UNVERIFIED) {
      if (live) return live;
      return this.open(cls, STATES.SEALED, now, null, 'none', reason);
    }

    // BOX_CLAIM_ONLY, CHALLENGE_FAIL, NONE: alert only, never containment.
    return live;
  }

  // Advance timers. A tamper countdown that runs out orders the quarantine; an ambiguous one stays sealed.
  tick(now) {
    for (const incident of this.incidents.values()) {
      if (incident.state !== STATES.PENDING || incident.deadline === null || now < incident.deadline) continue;
      if (incident.default_action === 'quarantine' && incident.auto_quarantine) {
        this.move(incident, STATES.QUARANTINED, now, 'countdown ended with no decision');
        this.onQuarantine(incident);
      } else {
        this.move(incident, STATES.SEALED, now, 'countdown ended; staying sealed');
      }
    }
  }

  // An approver's decision. A decided item leaves PENDING at once, so a second decision on it is refused.
  decide(id, approver, choice, now) {
    const incident = this.incidents.get(id);
    if (!incident) throw new GuardNotFound('no such incident');
    if (!['approve', 'deny', 'extend'].includes(choice)) throw new GuardConflict('choice must be approve, deny or extend');
    if (incident.state === STATES.UNSTABLE && choice === 'deny') {
      return this.move(incident, STATES.SEALED, now, 'a human cleared the flapping alert', approver);
    }
    if (incident.state !== STATES.PENDING) throw new GuardConflict(`incident is ${incident.state}, not PENDING`);
    if (choice === 'approve') {
      this.move(incident, STATES.QUARANTINED, now, 'approved by a human', approver);
      this.onQuarantine(incident);
      return incident;
    }
    if (choice === 'deny') return this.move(incident, STATES.SEALED, now, 'denied by a human', approver);
    if (incident.extensions >= MAX_EXTENSIONS) throw new GuardConflict('no more extensions');
    incident.extensions += 1;
    incident.deadline += incident.default_action === 'quarantine' ? this.config.tamperTimeoutS : this.config.ambiguousTimeoutS;
    this.onTransition({ id, from: STATES.PENDING, to: STATES.PENDING, class: incident.class, why: 'countdown extended', approver, at: now });
    return incident;
  }

  // The existing break-glass release was recorded: close the incident.
  release(id, now) {
    const incident = this.incidents.get(id);
    if (incident && incident.state === STATES.QUARANTINED) {
      incident.released = true;
      this.move(incident, STATES.RESUMED, now, 'quarantine released by the existing key-holder approval');
    }
  }

  snapshot() {
    return [...this.incidents.values()].map(({ id, class: cls, state, opened_at, updated_at, deadline, default_action, extensions }) =>
      ({ id, class: cls, state, opened_at, updated_at, deadline, default_action, extensions }));
  }
}
