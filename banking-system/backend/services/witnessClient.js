import { createHmac } from 'node:crypto';

export class WitnessUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'WitnessUnavailableError';
    this.status = 503;
  }
}

// Plain HTTP only to localhost, or to a private-LAN IPv4 literal when WITNESS_ALLOW_LAN_HTTP=1
// (same rule as witness/reconcile.js).
const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d+\.\d+(\.\d+)?$/;
const allowsPlainHttp = (url) =>
  ['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
  (process.env.WITNESS_ALLOW_LAN_HTTP === '1' && PRIVATE_IPV4.test(url.hostname));

export const sendWitnessRequest = async (pathname, payload) => {
  const baseUrl = process.env.WITNESS_URL?.replace(/\/+$/, '');
  const nodeId = process.env.WITNESS_NODE_ID;
  const secret = process.env.WITNESS_HMAC_SECRET;
  if (!baseUrl || !nodeId || !secret || secret.length < 32) {
    throw new WitnessUnavailableError('Transaction witness is not configured');
  }

  let url;
  try {
    url = new URL(pathname, `${baseUrl}/`);
  } catch (error) {
    throw new WitnessUnavailableError('Transaction witness URL is invalid', { cause: error });
  }
  if (url.protocol !== 'https:' && !allowsPlainHttp(url)) {
    throw new WitnessUnavailableError('Transaction witness must use HTTPS');
  }

  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', secret)
    .update(`POST\n${url.pathname}\n${timestamp}\n${body}`)
    .digest('hex');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-witness-node': nodeId,
        'x-witness-timestamp': timestamp,
        'x-witness-signature': signature
      },
      body,
      signal: controller.signal
    });
    const responseBody = await response.json().catch(() => null);
    if (!response.ok) {
      throw new WitnessUnavailableError(
        `Transaction witness rejected the request with HTTP ${response.status}`
      );
    }
    return responseBody;
  } catch (error) {
    if (error instanceof WitnessUnavailableError) {
      throw error;
    }
    throw new WitnessUnavailableError('Transaction witness could not be reached', { cause: error });
  } finally {
    clearTimeout(timeout);
  }
};
