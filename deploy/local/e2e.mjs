// LOCAL TESTING ONLY. Component checks for the stack started by deploy/local/test-stack.sh.
// Node 18+, no dependencies. Exits non-zero if any check fails.
//
//   node deploy/local/e2e.mjs [path/to/banking-system/.env]
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const envPath = process.argv[2] || new URL('../../banking-system/.env', import.meta.url);
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()])
);
const SITE = process.env.SITE_URL || 'http://127.0.0.1:3001';
const API = process.env.BACKEND_URL || 'http://127.0.0.1:8081';
const WITNESS = process.env.WITNESS_LOCAL_URL || 'http://127.0.0.1:8787';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`);
};
const section = (title) => console.log(`\n== ${title}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// RFC 6238 TOTP, so the test needs no npm packages.
const totp = (secretB32) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretB32.replace(/[\s=]/g, '').toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
};

class Client {
  constructor(base, extraHeaders = {}) {
    this.base = base;
    this.jar = {};
    this.extra = extraHeaders;
  }
  async call(method, path, body, headers = {}) {
    const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await fetch(this.base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(cookie && { cookie }),
        ...this.extra,
        ...headers
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    });
    for (const set of response.headers.getSetCookie()) {
      const [pair] = set.split(';');
      const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
      if (value) this.jar[name] = value;
      else delete this.jar[name];
    }
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: response.status, headers: response.headers, body: json, text };
  }
}

const psql = (sql) =>
  execFileSync('docker', ['exec', 'banking-postgres', 'psql', '-U', env.DB_USER, '-d', env.DB_NAME || 'bankingsystem', '-tA', '-c', sql], {
    encoding: 'utf8'
  }).trim();

const witnessMismatchIds = async () => {
  const response = await fetch(`${WITNESS}/mismatches`);
  const body = await response.json();
  return body.mismatches.map((m) => Number(m.seq));
};

const waitFor = async (predicate, timeoutMs, stepMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
};

// ---------------------------------------------------------------------------------------------
section('Frontend (nginx)');
{
  const site = new Client(SITE);
  const home = await site.call('GET', '/');
  check('serves the SPA', home.status === 200 && home.text.includes('<div id="root">'), home.status);
  const csp = home.headers.get('content-security-policy') || '';
  check('Content-Security-Policy forbids inline scripts', csp.includes("script-src 'self'") && !csp.includes("script-src 'self' 'unsafe-inline'"));
  check('no inline <script> in index.html', !/<script>(?!<\/script>)/.test(home.text));
  check('X-Frame-Options DENY', home.headers.get('x-frame-options') === 'DENY');
  check('X-Content-Type-Options nosniff', home.headers.get('x-content-type-options') === 'nosniff');
  check('index.html not cached', (home.headers.get('cache-control') || '').includes('no-cache'));
  check('nginx version hidden', !/\d/.test(home.headers.get('server') || ''), home.headers.get('server'));
  const deep = await site.call('GET', '/transactions/some/deep/link');
  check('deep links fall back to index.html', deep.status === 200 && deep.text.includes('<div id="root">'));
  const asset = home.text.match(/src="(\/static\/js\/[^"]+)"/)?.[1];
  const assetResponse = asset ? await site.call('GET', asset) : null;
  check('hashed assets cached immutably', (assetResponse?.headers.get('cache-control') || '').includes('immutable'));
  const proxied = await site.call('GET', '/api/auth/me');
  check('/api is proxied to the backend', proxied.status === 401 && proxied.body?.error, proxied.status);
}

// ---------------------------------------------------------------------------------------------
section('Rate limiting is per visitor (CF-Connecting-IP)');
{
  const attackerIp = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  const attacker = new Client(SITE, { 'cf-connecting-ip': attackerIp });
  let last;
  for (let i = 0; i < 6; i += 1) {
    last = await attacker.call('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'Wrong-pass1!' });
  }
  check('6th failed login from one visitor is throttled', last.status === 429, last.status);
  const bystander = new Client(SITE, { 'cf-connecting-ip': '198.51.100.7' });
  const other = await bystander.call('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'Wrong-pass1!' });
  check('another visitor is not affected', other.status === 401, other.status);
}

// ---------------------------------------------------------------------------------------------
section('Backend auth (through nginx)');
const user = new Client(SITE, { 'cf-connecting-ip': '192.0.2.10' });
const stamp = Date.now().toString().slice(-7);
const email = `local${stamp}@test.dev`;
const password = 'Str0ng!Passw0rd';
let accounts = [];
{
  let r = await user.call('POST', '/api/auth/register', { username: `local${stamp}`, email, password });
  check('register', r.status === 201, r.status);
  const secret = r.body?.twoFactor?.manualCode;
  const pending = user.jar.banking_pending_2fa;
  r = await new Client(SITE).call('GET', '/api/accounts', undefined, { authorization: `Bearer ${pending}` });
  check('2FA bypass blocked (pending token as Bearer)', r.status === 401, r.status);
  r = await user.call('POST', '/api/auth/two-factor/regenerate');
  check('setup-intent challenge can regenerate', r.status === 200, r.status);
  const newSecret = r.body?.twoFactor?.manualCode || secret;
  r = await user.call('POST', '/api/auth/two-factor/verify', { code: '000000' });
  check('wrong OTP rejected', r.status === 400, r.status);
  r = await user.call('POST', '/api/auth/two-factor/verify', { code: totp(newSecret) });
  check('correct OTP signs in', r.status === 200, r.status);
  const me = await user.call('GET', '/api/auth/me');
  check('session cookie works', me.status === 200 && me.body?.email === email);

  const relogin = new Client(SITE, { 'cf-connecting-ip': '192.0.2.11' });
  r = await relogin.call('POST', '/api/auth/login', { email, password });
  check('login asks for OTP', r.status === 200 && r.body?.twoFactor?.status === 'verify');
  r = await relogin.call('POST', '/api/auth/two-factor/regenerate');
  check('login-intent challenge cannot regenerate the secret', r.status === 400, r.status);
}

// ---------------------------------------------------------------------------------------------
section('Banking + witness two-phase commit');
{
  let r = await user.call('POST', '/api/accounts', { account_type: 'checking' });
  const a1 = r.body;
  r = await user.call('POST', '/api/accounts', { account_type: 'savings' });
  const a2 = r.body;
  accounts = [a1, a2];
  check('create two accounts', a1?.id && a2?.id && a1.iban);
  r = await user.call('POST', '/api/transactions/deposit', { account_id: a1.id, amount: '500.10' });
  check('deposit witnessed', r.status === 201 && r.body.witness_status === 'confirmed', `${r.status} ${r.body?.witness_status}`);
  r = await user.call('POST', '/api/transactions/transfer', { from_account_id: a1.id, to_account_id: a2.id, amount: '120.05' });
  check('transfer witnessed', r.status === 201 && r.body.witness_status === 'confirmed', `${r.status} ${r.body?.witness_status}`);
  r = await user.call('POST', '/api/transactions/external/outgoing', {
    from_account_id: a2.id, recipient_name: 'Test Payee', recipient_iban: 'DE89370400440532013000', amount: '20', reference: 'local test'
  });
  check('external payment witnessed', r.status === 201 && r.body.witness_status === 'confirmed', `${r.status} ${r.body?.witness_status}`);
  r = await user.call('POST', '/api/transactions/withdraw', { account_id: a2.id, amount: '10000' });
  check('overdraft refused', r.status === 400 && /Insufficient/.test(r.body?.error), r.status);
  r = await user.call('POST', '/api/transactions/deposit', { account_id: a1.id, amount: '1.005' });
  check('sub-cent amount refused', r.status === 400, r.status);
  const list = await user.call('GET', '/api/transactions?limit=500&page=x');
  check('pagination clamped', list.body?.pagination?.limit === 100 && list.body?.pagination?.page === 1);
  check('history carries witness_status', list.body?.transactions?.length === 3 && list.body.transactions.every((t) => t.witness_status === 'confirmed'));
  r = await user.call('GET', '/api/transactions?type=nonsense');
  check('invalid type filter -> 400', r.status === 400, r.status);
  const balances = (await user.call('GET', '/api/accounts')).body.map((a) => `${a.account_type}:${a.balance}`).sort();
  check('balances exact to the cent', JSON.stringify(balances) === JSON.stringify(['checking:380.05', 'savings:100.05']), balances.join(' '));

  const stranger = new Client(SITE, { 'cf-connecting-ip': '192.0.2.12' });
  r = await stranger.call('GET', `/api/accounts/${a1.id}`);
  check('accounts require auth', r.status === 401, r.status);
}

// ---------------------------------------------------------------------------------------------
section('Backend hardening');
{
  let r = await new Client(API).call('GET', '/api-docs/');
  check('Swagger hidden in production', r.status === 404, r.status);
  r = await new Client(API).call('GET', '/send-payment');
  check('tokenless payment portal hidden in production', r.status === 404, r.status);
  r = await new Client(API).call('GET', '/api/auth/me', undefined, { origin: 'https://evil.example' });
  check('foreign origin gets no CORS grant', !r.headers.get('access-control-allow-origin'));
  r = await new Client(API).call('POST', '/api/auth/login', '{not json');
  check('malformed JSON -> 400', r.status === 400, r.status);
  r = await new Client(API).call('POST', '/api/transactions/external/incoming', { iban: 'X', sender_name: 'Y', amount: 1 }, { 'x-api-key': 'wrong' });
  check('external API key enforced', r.status === 401, r.status);
  r = await new Client(API).call('GET', '/health');
  check('health endpoint', r.status === 200 && r.body?.status === 'ok');
}

// ---------------------------------------------------------------------------------------------
section('Witness (Layer 2 reconciliation)');
{
  const health = await fetch(`${WITNESS}/health`);
  check('witness healthy', health.status === 200, health.status);
  const page = await (await fetch(`${WITNESS}/`)).text();
  check('auditor dashboard served', page.includes('Witness'));

  const ids = (await user.call('GET', '/api/transactions')).body.transactions.map((t) => t.id);
  const path = '/api/transactions/witness-reconcile';
  const search = `transaction_ids=${encodeURIComponent(ids.join(','))}`;
  let r = await new Client(SITE).call('GET', `${path}?${search}`);
  const enforced = env.WITNESS_RECONCILE_AUTH === 'required';
  check(enforced ? 'unsigned reconcile rejected' : 'unsigned reconcile allowed (auth not enforced)', enforced ? r.status === 401 : r.status === 200, r.status);
  const ts = String(Date.now());
  const sig = createHmac('sha256', env.WITNESS_HMAC_SECRET).update(`bank-reconcile\nGET\n${path}\n${ts}\n${search}`).digest('hex');
  r = await new Client(SITE).call('GET', `${path}?${search}`, undefined, {
    'x-witness-node': env.WITNESS_NODE_ID, 'x-witness-timestamp': ts, 'x-witness-signature': sig
  });
  check('signed reconcile accepted', r.status === 200 && r.body.transactions.length === ids.length, r.status);

  console.log('  …waiting for the witness to settle and check the new records (up to 90 s)');
  const green = await waitFor(async () => {
    const status = await (await fetch(`${WITNESS}/status`)).json();
    return status.checks?.B === 'green' && status.bank_reconciliation.checked_transactions >= 1;
  }, 90_000);
  const status = await (await fetch(`${WITNESS}/status`)).json();
  check('Layer 2 check B green', green, `B=${status.checks?.B} checked=${status.bank_reconciliation?.checked_transactions} err=${status.bank_reconciliation?.last_error}`);

  const target = ids[ids.length - 1];
  // When the ct105 monitor is running (test-stack.sh lab-up) the witness also keeps its own copy of each
  // row, taken once and never overwritten. Tamper only after that copy exists, or the copy itself is
  // taken from the tampered row.
  const monitorOn = (await (await fetch(`${WITNESS}/status`)).json()).connection === 'connected';
  if (monitorOn) {
    console.log('  …monitor connected; waiting for the witness to hold a copy of every row (up to 120 s)');
    // bank_rows on /status comes from the last heartbeat, so compare with the database itself.
    const dbRows = Number(psql('SELECT count(*) FROM transactions'));
    const copied = await waitFor(async () => {
      const records = (await (await fetch(`${WITNESS}/status`)).json()).records || {};
      return records.bank_rows >= dbRows && records.witness_copies >= dbRows;
    }, 120_000);
    check('witness holds row copies before the tamper test', copied);
  }
  const original = psql(`SELECT amount FROM transactions WHERE id = ${target}`);
  psql(`UPDATE transactions SET amount = amount + 1 WHERE id = ${target}`);
  console.log(`  …tampered transaction #${target} (${original} -> +1); waiting for the witness (up to 120 s)`);
  const caught = await waitFor(async () => (await witnessMismatchIds()).includes(target), 120_000);
  check(`witness flags tampered #${target}`, caught);
  psql(`UPDATE transactions SET amount = ${original} WHERE id = ${target}`);
  const cleared = await waitFor(async () => !(await witnessMismatchIds()).includes(target), 120_000);
  check(`witness clears #${target} after restore`, cleared);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
