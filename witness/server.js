import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WitnessStore } from './store.js';

const port = Number(process.env.WITNESS_PORT || 8787);
const bindHost = process.env.WITNESS_BIND_HOST || '127.0.0.1';
const nodeId = process.env.WITNESS_NODE_ID || '';
const hmacSecret = process.env.WITNESS_HMAC_SECRET || '';
const dataPath = process.env.WITNESS_DATA_PATH || '/var/lib/banking-witness/ledger.jsonl';
const maxBodyBytes = 16 * 1024;

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Banking Witness</title>
  <style>
    body{font:16px system-ui,sans-serif;background:#0b1020;color:#e8edf8;margin:0;padding:2rem}
    main{max-width:1100px;margin:auto}h1{margin-bottom:.25rem}
    .muted{color:#9eabc4}.card{background:#151d32;border:1px solid #2c3854;border-radius:12px;padding:1rem;margin:1rem 0}
    .status{font-weight:700}.ok{color:#5ee0a0}.bad{color:#ff7885}
    table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.7rem;border-bottom:1px solid #2c3854}
    code{word-break:break-all}
  </style>
</head>
<body><main>
  <h1>Banking Witness</h1>
  <div class="muted">Independent transaction evidence receiver</div>
  <section class="card" id="status">Loading witness status…</section>
  <section class="card"><h2>Recent events</h2><div id="events">Loading…</div></section>
  <script>
    const escapeText = (value) => String(value ?? '');
    async function refresh() {
      const [statusResponse, eventsResponse] = await Promise.all([
        fetch('/v1/status', {cache:'no-store'}),
        fetch('/v1/events', {cache:'no-store'})
      ]);
      if (!statusResponse.ok || !eventsResponse.ok) throw new Error('Witness status request failed');
      const status = await statusResponse.json();
      const events = await eventsResponse.json();
      const statusNode = document.getElementById('status');
      statusNode.replaceChildren();
      const heading = document.createElement('div');
      heading.className = 'status ' + (status.healthy ? 'ok' : 'bad');
      heading.textContent = status.healthy ? 'Ledger integrity: OK' : 'LEDGER INTEGRITY FAILURE';
      statusNode.append(heading);
      const summary = document.createElement('p');
      summary.textContent = 'Records: ' + status.record_count + ' · Latest sequence: ' + status.latest_seq + ' · Prepared events: ' + status.prepared_count;
      statusNode.append(summary);
      const hash = document.createElement('code');
      hash.textContent = status.latest_hash;
      statusNode.append(hash);

      const container = document.getElementById('events');
      container.replaceChildren();
      if (!events.length) {
        container.textContent = 'No transaction events received yet.';
        return;
      }
      const table = document.createElement('table');
      const header = document.createElement('tr');
      for (const label of ['Seq', 'Transaction', 'Type', 'Amount', 'State', 'Recorded']) {
        const cell = document.createElement('th');
        cell.textContent = label;
        header.append(cell);
      }
      table.append(header);
      for (const event of events) {
        const row = document.createElement('tr');
        for (const value of [
          event.prepare_seq,
          event.transaction_id,
          event.type,
          (event.amount_minor / 100).toFixed(2),
          event.state,
          event.updated_at
        ]) {
          const cell = document.createElement('td');
          cell.textContent = escapeText(value);
          row.append(cell);
        }
        table.append(row);
      }
      container.append(table);
    }
    refresh().catch((error) => {
      document.getElementById('status').textContent = 'Unable to load witness status: ' + error.message;
    });
    setInterval(() => refresh().catch(() => {}), 3000);
  </script>
</main></body></html>`;

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
        return sendJson(response, 200, { status: 'ok' });
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
  await store.initialize();
  const server = createWitnessServer(store);
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
