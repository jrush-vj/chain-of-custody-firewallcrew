import { createHash, timingSafeEqual } from 'node:crypto';

// Hash both sides so the comparison is constant-time regardless of key length.
const digest = (value) => createHash('sha256').update(String(value)).digest();

export const requireExternalApiKey = (req, res, next) => {
  const configuredKey = process.env.EXTERNAL_PAYMENTS_API_KEY;
  if (!configuredKey) {
    return res.status(503).json({ error: 'External payments API key is not configured' });
  }

  const incomingKey = req.headers['x-external-api-key'] || req.headers['x-api-key'];
  if (!incomingKey || !timingSafeEqual(digest(incomingKey), digest(configuredKey))) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  next();
};
