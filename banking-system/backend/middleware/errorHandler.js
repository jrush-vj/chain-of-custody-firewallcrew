export const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);

  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: err.message });
  }

  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Malformed JSON or oversized bodies from express.json()
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }

  if (err.code === 'ECONNREFUSED') {
    return res.status(503).json({ error: 'Database connection failed' });
  }

  const status = Number.isInteger(err.status) ? err.status : 500;
  // Messages on errors we raised deliberately (4xx, 202 witness outcomes, 503 witness down) are safe
  // to show. Anything else may carry database or stack details, so it gets a generic message.
  const exposeMessage = status < 500 || err.name === 'WitnessUnavailableError';

  res.status(status).json({
    error: exposeMessage ? err.message : 'Internal server error',
    ...(err.witnessEventId && { witness_event_id: err.witnessEventId }),
    ...(err.witnessStatus && { witness_status: err.witnessStatus }),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

export const notFoundHandler = (req, res) => {
  res.status(404).json({ error: 'Route not found' });
};
