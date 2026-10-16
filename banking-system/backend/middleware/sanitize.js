// Keys that could alter an object's prototype when copied onto it.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const sanitizeValue = (value) => {
  if (typeof value === 'string') {
    return value.replace(/\0/g, '').trim();
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((acc, [key, val]) => {
      if (!FORBIDDEN_KEYS.has(key)) {
        acc[key] = sanitizeValue(val);
      }
      return acc;
    }, {});
  }

  return value;
};

export const sanitizeRequest = (req, _res, next) => {
  if (req.body) {
    req.body = sanitizeValue(req.body);
  }
  if (req.query) {
    req.query = sanitizeValue(req.query);
  }
  if (req.params) {
    req.params = sanitizeValue(req.params);
  }
  next();
};
