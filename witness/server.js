import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WitnessStore } from './store.js';
import { startBankReconciliation } from './reconcile.js';

const port = Number(process.env.WITNESS_PORT || 8787);
const bindHost = process.env.WITNESS_BIND_HOST || '127.0.0.1';
const nodeId = process.env.WITNESS_NODE_ID || '';
const hmacSecret = process.env.WITNESS_HMAC_SECRET || '';
const dataPath = process.env.WITNESS_DATA_PATH || '/var/lib/banking-witness/ledger.jsonl';
const maxBodyBytes = 16 * 1024;
const html = readFileSync(new URL('./auditor.html', import.meta.url), 'utf8');

const readBody = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(JSON.stringify(payload));
};

const validateEvent = (event) => {
  const expectedFields = ['event_id', 'transaction_id', 'type', 'amount_minor', 'occurred_at'];
  if (
    !event ||
    Object.keys(event).some((field) => !expectedFields.includes(field)) ||
    expectedFields.some((field) => !Object.hasOwn(event, field)) ||
    typeof event.event_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.event_id) ||
    !Number.isSafeInteger(event.transaction_id) ||
    event.transaction_id <= 0 ||
    !['deposit', 'withdrawal', 'transfer', 'external_incoming', 'external_outgoing'].includes(event.type) ||
    !Number.isSafeInteger(event.amount_minor) ||
    event.amount_minor <= 0 ||
    typeof event.occurred_at !== 'string' ||
    Number.isNaN(Date.parse(event.occurred_at))
  ) {
    const error = new Error('Invalid transaction evidence event');
    error.statusCode = 400;
    throw error;
  }
};

const authorize = (request, pathname, body) => {
  if (!hmacSecret || !nodeId) {
    throw new Error('Witness authentication is not configured');
  }
  const timestamp = request.headers['x-witness-timestamp'];
  const suppliedNodeId = request.headers['x-witness-node'];
  const suppliedSignature = request.headers['x-witness-signature'];
  const timestampValue = Number(timestamp);
  if (
    suppliedNodeId !== nodeId ||
    !Number.isSafeInteger(timestampValue) ||
    Math.abs(Date.now() - timestampValue) > 60_000 ||
    typeof suppliedSignature !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(suppliedSignature)
  ) {
    const error = new Error('Unauthorized witness request');
    error.statusCode = 401;
    throw error;
  }
  const expected = createHmac('sha256', hmacSecret)
    .update(`${request.method}\n${pathname}\n${timestamp}\n${body}`)
    .digest();
  const provided = Buffer.from(suppliedSignature, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    const error = new Error('Unauthorized witness request');
    error.statusCode = 401;
    throw error;
  }
};

export const createWitnessServer = (store) =>
  createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    try {
      if (request.method === 'GET' && pathname === '/health') {
        return sendJson(response, store.status().healthy ? 200 : 503, {
          status: store.status().healthy ? 'ok' : 'error',
          ...store.status()
        });
      }
      if (request.method === 'GET' && pathname === '/v1/status') {
        return sendJson(response, 200, store.status());
      }
      if (request.method === 'GET' && pathname === '/v1/events') {
        return sendJson(response, 200, store.recentEvents());
      }
      if (request.method === 'GET' && pathname === '/') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
          'x-content-type-options': 'nosniff'
        });
        response.end(html);
        return;
      }
      if (
        request.method !== 'POST' ||
        !['/v1/prepare', '/v1/commit', '/v1/abort'].includes(pathname)
      ) {
        return sendJson(response, 404, { error: 'Not found' });
      }

      const body = await readBody(request);
      authorize(request, pathname, body);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        const error = new Error('Invalid JSON body');
        error.statusCode = 400;
        throw error;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        const error = new Error('Request body must be a JSON object');
        error.statusCode = 400;
        throw error;
      }

      let result;
      if (pathname === '/v1/prepare') {
        validateEvent(payload.event);
        const event = {
          event_id: payload.event.event_id,
          transaction_id: payload.event.transaction_id,
          type: payload.event.type,
          amount_minor: payload.event.amount_minor,
          occurred_at: payload.event.occurred_at
        };
        result = await store.prepare(event);
      } else {
        if (!payload || typeof payload.event_id !== 'string') {
          const error = new Error('event_id is required');
          error.statusCode = 400;
          throw error;
        }
        result = await store.transition(payload.event_id, pathname === '/v1/commit' ? 'commit' : 'abort');
      }
      return sendJson(response, 200, result);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) {
        console.error('Witness request failed:', error.message);
      }
      return sendJson(response, statusCode, { error: statusCode >= 500 ? 'Witness request failed' : error.message });
    }
  });

const start = async () => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('WITNESS_PORT must be a valid TCP port');
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(nodeId) || hmacSecret.length < 32) {
    throw new Error('Configure a valid WITNESS_NODE_ID and a WITNESS_HMAC_SECRET of at least 32 characters');
  }
  const store = new WitnessStore(dataPath);
  try {
    await store.initialize();
  } catch (error) {
    console.error('Witness ledger integrity validation failed; entering read-only alert mode:', error.message);
  }
  const server = createWitnessServer(store);
  startBankReconciliation(store);
  server.listen(port, bindHost, () => {
    console.log(`Witness listening on ${bindHost}:${port}; ledger ${dataPath}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((error) => {
    console.error('Witness failed to start:', error);
    process.exit(1);
  });
}
