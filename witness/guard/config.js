// Guard configuration: environment variables with validated defaults. No dependencies.
// Phase 1 uses FLAP_MAX and FLAP_WINDOW_S; the containment, report and Bob settings are defined here so
// later phases read one validated source. Nothing here touches the existing witness settings.

const integer = (env, name, fallback, { min = 1 } = {}) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return value;
};

const choice = (env, name, fallback, allowed) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!allowed.includes(raw)) throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  return raw;
};

export const REPORT_NARRATIVE_MODES = Object.freeze(['off', 'bob_on_demand', 'bob_auto']);

export const loadGuardConfig = (env = process.env) => {
  const config = {
    // Flapping: this many outages inside the window means UNSTABLE (the count is inclusive).
    flapMax: integer(env, 'FLAP_MAX', 3),
    flapWindowS: integer(env, 'FLAP_WINDOW_S', 900),
    // Containment timers (used from Phase 2).
    tamperTimeoutS: integer(env, 'CONTAIN_TAMPER_TIMEOUT_S', 120),
    ambiguousTimeoutS: integer(env, 'CONTAIN_AMBIG_TIMEOUT_S', 900),
    ambiguousDefault: choice(env, 'CONTAIN_AMBIG_DEFAULT', 'stay_sealed', ['stay_sealed']),
    // The whole guard is OFF unless enabled, so the witness behaves exactly as before by default.
    guardEnabled: env.GUARD_ENABLED === '1',
    approversRaw: env.APPROVERS || '',
    // Bob is OFF unless explicitly enabled. The narrative modes also need BOB_ENABLED=1 (used from Phase 3).
    bobEnabled: env.BOB_ENABLED === '1',
    reportNarrative: choice(env, 'REPORT_NARRATIVE', 'off', REPORT_NARRATIVE_MODES)
  };
  // Master switch for every Bob feature, including the existing "Diagnose with Bob" button.
  // Guard on: Bob is allowed only if BOB_ENABLED=1. Guard off: legacy behaviour (allowed) unless BOB_ENABLED=0.
  config.bobAllowed = config.guardEnabled ? config.bobEnabled : env.BOB_ENABLED !== '0';
  // A narrative mode without Bob enabled is a configuration contradiction: fail safe to the template.
  if (!config.bobEnabled) config.reportNarrative = 'off';
  return Object.freeze(config);
};
