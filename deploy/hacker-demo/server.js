#!/usr/bin/env node
/**
 * Hacker demo: buttons that run the existing Layer 1/2/3 attack scripts inside the local lab
 * container (coc-lab, the stand-in for the bank server). LOCAL TESTING ONLY.
 * Start the stack and lab first: bash deploy/local/test-stack.sh up && bash deploy/local/test-stack.sh lab-up
 * Run: node server.js, then open http://localhost:3300
 */

import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PORT = Number(process.env.PORT) || 3300;
const LAB = process.env.COC_LAB || 'coc-lab';
const WITNESS = process.env.WITNESS_URL || 'http://127.0.0.1:8787';
const page = new URL('./index.html', import.meta.url);
// IBM Plex, shared with the witness dashboard (witness/fonts, OFL); only these names are served.
const FONTS = new Set(['mono-latin-400', 'mono-latin-500', 'sans-latin-400', 'sans-latin-500', 'sans-latin-600']
  .map((name) => `/fonts/ibm-plex-${name}-normal.woff2`));

// No shell: fixed argv, the layer is checked to be 1, 2 or 3 before it gets here.
const inLab = (args, timeout) => run('docker',
  ['exec', LAB, 'bash', '/opt/chain-of-custody/deploy/local/lab/run.sh', ...args],
  { timeout, maxBuffer: 10 * 1024 * 1024 });

async function checkStatus() {
  const up = (p) => p.then(() => true, () => false);
  const [lab, witness] = await Promise.all([
    up(run('docker', ['exec', LAB, 'true'], { timeout: 5000 })),
    up(fetch(`${WITNESS}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => { if (!r.ok) throw new Error(); }))
  ]);
  return { lab, witness };
}

async function runAttack(layer) {
  try {
    const { stdout, stderr } = await inLab(['bash', 'deploy/ct105/coc.sh', 'attack', String(layer)], 600000);
    return { success: true, output: (stdout + stderr).slice(-4000) };
  } catch (error) {
    return { success: false, error: ((error.stdout || '') + (error.stderr || '') || error.message).slice(-2000) };
  }
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

const server = http.createServer(async (req, res) => {
  try {
    // DNS rebinding: a hostile page that rebinds its name to 127.0.0.1 still sends its own Host header.
    if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(req.headers.host)) return send(res, 421, { error: 'Bad host' });
    if (req.method === 'GET' && req.url === '/') return send(res, 200, await readFile(page), 'text/html; charset=utf-8');
    if (req.method === 'GET' && FONTS.has(req.url)) {
      return send(res, 200, await readFile(new URL(`../../witness${req.url}`, import.meta.url)), 'font/woff2');
    }
    if (req.method === 'GET' && req.url === '/status') return send(res, 200, await checkStatus());
    if (req.method === 'POST' && req.url === '/attack') {
      // Same-origin only: a page on another site must not be able to fire attacks at localhost.
      if (req.headers['content-type'] !== 'application/json') return send(res, 415, { error: 'JSON only' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1024) return send(res, 413, { error: 'Too large' }); }
      const { layer } = JSON.parse(body);
      if (![1, 2, 3].includes(layer)) return send(res, 400, { success: false, error: 'Invalid layer' });
      return send(res, 200, await runAttack(layer));
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Hacker demo on http://localhost:${PORT} (attacks run in container ${LAB})`);
});
