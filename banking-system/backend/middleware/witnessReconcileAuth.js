import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_SKEW_MS = 60_000;

// The witness signs reconciliation reads with the same shared secret it uses for /v1/* requests.
// Message: "bank-reconcile\nGET\n<path>\n<timestamp>\n<query string>" (the prefix keeps it from
// ever matching a witness-bound signature).
export const reconcileSignature = (secret, method, pathname, timestamp, search) =>
  createHmac('sha256', secret)
    .update(`bank-reconcile\n${method}\n${pathname}\n${timestamp}\n${search}`)
    .digest('hex');

const isSignatureValid = (req) => {
  const secret = process.env.WITNESS_HMAC_SECRET;
  const nodeId = process.env.WITNESS_NODE_ID;
  if (!secret || secret.length < 32 || !nodeId) {
    return false;
  }
  const timestamp = req.headers['x-witness-timestamp'];
  const signature = req.headers['x-witness-signature'];
  const timestampValue = Number(timestamp);
  if (
    req.headers['x-witness-node'] !== nodeId ||
    !Number.isSafeInteger(timestampValue) ||
    Math.abs(Date.now() - timestampValue) > MAX_SKEW_MS ||
    typeof signature !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(signature)
  ) {
    return false;
  }
  const [pathname, search = ''] = req.originalUrl.split('?');
  const expected = Buffer.from(reconcileSignature(secret, req.method, pathname, timestamp, search), 'hex');
  const provided = Buffer.from(signature, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
};

// WITNESS_RECONCILE_AUTH=required rejects unsigned reads. Any other value keeps the endpoint
// open (the original behaviour) so an older witness keeps working until it is redeployed.
export const requireWitnessReconcileAuth = (req, res, next) => {
  if (process.env.WITNESS_RECONCILE_AUTH !== 'required') {
    return next();
  }
  if (!isSignatureValid(req)) {
    return res.status(401).json({ error: 'Unauthorized reconciliation request' });
  }
  return next();
};
