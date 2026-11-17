// Strict validation of Bob's output. Anything that does not match exactly is rejected, and the caller
// falls back to the deterministic template. Bob's text is untrusted: it is shown labelled, never acted on.

export const LIMITS = Object.freeze({ summary: 700, point: 200, points: 5 });
const CONFIDENCE = new Set(['high', 'medium', 'low']);
// Small numbers an honest summary may use without them appearing in the bundle ("2 layers", "3 steps").
const NUMBER_WHITELIST = new Set(['0', '1', '2', '3', '4', '5']);
const NUMBER = /\d+(?:\.\d+)?/g;

export const numbersIn = (text) => new Set(String(text).match(NUMBER) || []);

// Returns { ok, value } or { ok: false, reason }. `bundleNumbers` is the set of numbers present in the bundle.
export const validateOutput = (raw, { bundleNumbers, canary, untrustedValues = [] }) => {
  let value;
  try {
    value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, reason: 'output is not JSON' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'output is not an object' };
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'confidence,points,summary') return { ok: false, reason: 'output keys do not match the schema' };
  if (typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > LIMITS.summary) {
    return { ok: false, reason: 'summary is missing or too long' };
  }
  if (!Array.isArray(value.points) || value.points.length > LIMITS.points
    || value.points.some((point) => typeof point !== 'string' || !point.trim() || point.length > LIMITS.point)) {
    return { ok: false, reason: 'points are invalid' };
  }
  if (!CONFIDENCE.has(value.confidence)) return { ok: false, reason: 'confidence is invalid' };

  const text = [value.summary, ...value.points].join('\n');
  if (canary && text.includes(canary)) return { ok: false, reason: 'canary echoed', suspect: true };
  for (const untrusted of untrustedValues) {
    if (untrusted.length >= 12 && text.includes(untrusted)) return { ok: false, reason: 'repeats attacker-controlled text', suspect: true };
  }
  if (/https?:\/\/|```|<\s*\/?\s*(tool|system|function)/i.test(text)) return { ok: false, reason: 'output contains a link, code block or markup' };
  for (const number of numbersIn(text)) {
    if (!bundleNumbers.has(number) && !NUMBER_WHITELIST.has(number)) return { ok: false, reason: `number ${number} is not in the evidence` };
  }
  return { ok: true, value: { summary: value.summary.trim(), points: value.points.map((p) => p.trim()), confidence: value.confidence } };
};
