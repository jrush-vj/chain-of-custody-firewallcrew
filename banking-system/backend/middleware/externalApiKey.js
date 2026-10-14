export const requireExternalApiKey = (req, res, next) => {
  const configuredKey = process.env.EXTERNAL_PAYMENTS_API_KEY;
  if (!configuredKey) {
    return res.status(503).json({ error: 'External payments API key is not configured' });
  }

  const incomingKey = req.headers['x-external-api-key'] || req.headers['x-api-key'];
  if (!incomingKey || incomingKey !== configuredKey) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  next();
};
