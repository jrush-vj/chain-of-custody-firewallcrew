const batchSize = 100;

const getEndpoint = () => {
  const value =
    process.env.BANK_RECONCILE_URL ||
    'https://bank.jrushvj.dev/api/transactions/witness-reconcile';
  const endpoint = new URL(value);
  if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname)) {
    throw new Error('Bank reconciliation endpoint must use HTTPS');
  }
  return endpoint;
};

const fetchJson = async (url) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Bank reconciliation endpoint returned HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
};

export const reconcileBankTransactions = async (store, fetchImpl = fetch) => {
  const endpoint = getEndpoint();
  const witnessed = store.committedEvents();
  const observed = new Map();

  for (let offset = 0; offset < witnessed.length; offset += batchSize) {
    const batch = witnessed.slice(offset, offset + batchSize);
    const url = new URL(endpoint);
    url.searchParams.set(
      'transaction_ids',
      batch.map((event) => event.transaction_id).join(',')
    );
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      throw new Error(`Bank reconciliation endpoint returned HTTP ${response.status}`);
    }
    const body = await response.json();
    if (!body || !Array.isArray(body.transactions)) {
      throw new Error('Bank reconciliation endpoint returned an invalid response');
    }
    for (const transaction of body.transactions) {
      if (
        !Number.isSafeInteger(Number(transaction.transaction_id)) ||
        !Number.isSafeInteger(Number(transaction.amount_minor)) ||
        typeof transaction.type !== 'string' ||
        typeof transaction.event_id !== 'string'
      ) {
        throw new Error('Bank reconciliation response contains an invalid transaction record');
      }
      const transactionId = Number(transaction.transaction_id);
      if (observed.has(transactionId)) {
        throw new Error('Bank reconciliation response contains a duplicate transaction');
      }
      observed.set(transactionId, transaction);
    }
  }

  const mismatches = [];
  for (const event of witnessed) {
    const actual = observed.get(event.transaction_id);
    if (!actual) {
      mismatches.push({
        transaction_id: event.transaction_id,
        issue: 'missing',
        witnessed_type: event.type,
        witnessed_amount_minor: event.amount_minor,
        witnessed_event_id: event.event_id
      });
      continue;
    }

    const differences = [];
    if (actual.type !== event.type) differences.push('type');
    if (Number(actual.amount_minor) !== event.amount_minor) differences.push('amount');
    if (actual.event_id !== event.event_id) differences.push('event_id');
    if (differences.length) {
      mismatches.push({
        transaction_id: event.transaction_id,
        issue: `changed_${differences.join('_')}`,
        fields: differences,
        witnessed_type: event.type,
        bank_type: actual.type,
        witnessed_amount_minor: event.amount_minor,
        bank_amount_minor: Number(actual.amount_minor),
        witnessed_event_id: event.event_id,
        bank_event_id: actual.event_id
      });
    }
  }

  store.setReconciliation({
    state: mismatches.length ? 'mismatch' : 'ok',
    checked_transactions: witnessed.length,
    mismatches
  });

  // New mismatches and recoveries become challenge entries on the auditor graph. Heartbeats come
  // from ct105's monitor, not from this pass, so tampering never changes the heartbeat rhythm.
  const current = new Set();
  for (const mismatch of mismatches) {
    const key = `${mismatch.transaction_id}:${mismatch.issue}`;
    current.add(key);
    if (!store.reportedMismatches.has(key)) {
      store.reportedMismatches.add(key);
      store.recordChallenge(mismatch.transaction_id, 'mismatch', `differs from the bank: ${mismatch.issue.replaceAll('_', ' ')}`);
    }
  }
  for (const key of [...store.reportedMismatches]) {
    if (!current.has(key)) {
      store.reportedMismatches.delete(key);
      store.recordChallenge(Number(key.split(':')[0]), 'ok', 'matches the bank again');
    }
  }
  return store.status().bank_reconciliation;
};

export const startBankReconciliation = (store, intervalMs = 10_000) => {
  let running = false;
  const run = async () => {
    if (running || store.integrityError) return;
    running = true;
    try {
      await reconcileBankTransactions(store);
    } catch (error) {
      console.error('Bank transaction reconciliation failed:', error.message);
      store.setReconciliationUnavailable(error.message);
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
};

// ---------- challenges: the crest and trough on the auditor's heartbeat graph ----------

// Asks the bank about one witnessed record and records the answer on the graph. Returns 'ok',
// 'mismatch', 'missing' (the bank answered but has no confirmed row for it) or 'none' (no answer).
export const challengeRecord = async (store, event, fetchImpl = fetch, { recordMissing = true } = {}) => {
  let actual;
  try {
    const url = new URL(getEndpoint());
    url.searchParams.set('transaction_ids', String(event.transaction_id));
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body || !Array.isArray(body.transactions)) throw new Error('invalid response');
    actual = body.transactions.find((item) => Number(item.transaction_id) === event.transaction_id);
  } catch {
    store.recordChallenge(event.transaction_id, 'none');
    return 'none';
  }
  if (!actual) {
    if (recordMissing) store.recordChallenge(event.transaction_id, 'mismatch', 'differs from the bank: missing');
    return 'missing';
  }
  const differences = [];
  if (actual.type !== event.type) differences.push('type');
  if (Number(actual.amount_minor) !== event.amount_minor) differences.push('amount');
  if (actual.event_id !== event.event_id) differences.push('event id');
  if (differences.length) {
    store.recordChallenge(event.transaction_id, 'mismatch', `differs from the bank: changed ${differences.join(' and ')}`);
    return 'mismatch';
  }
  store.recordChallenge(event.transaction_id, 'ok', 'matches the bank');
  return 'ok';
};

// One scheduler step. Records that were just witnessed are challenged straight away, so the graph
// reacts to new traffic. One random record is challenged every randomEveryMs even when nothing is
// happening, so a crest and trough is always present at that rhythm (a record the bank cannot
// answer for shows as a crest with no trough).
export const runChallengeStep = async (store, {
  fetchImpl = fetch,
  nowMs = Date.now(),
  randomEveryMs = Number(process.env.WITNESS_CHALLENGE_S || 30) * 1000,
  freshLimit = 3,
  settleMs = 30_000,
  random = Math.random
} = {}) => {
  if (store.integrityError) return;
  const records = store.committedRecords();
  if (!store.challengeBaselineSet) {
    // Whatever was witnessed before this process started counts as already challenged, so a restart
    // does not flood the graph.
    for (const { event } of records) store.challengedEventIds.add(event.event_id);
    store.challengeBaselineSet = true;
  }

  const fresh = records.filter(({ event }) => !store.challengedEventIds.has(event.event_id)).slice(0, freshLimit);
  for (const { event, committed_at: committedAt } of fresh) {
    // The bank confirms a record a moment after the witness commits it; give it settleMs before
    // calling a missing row a mismatch.
    const settled = nowMs - Date.parse(committedAt) > settleMs;
    const result = await challengeRecord(store, event, fetchImpl, { recordMissing: settled });
    if (result !== 'missing' || settled) store.challengedEventIds.add(event.event_id);
  }

  if (records.length && nowMs - store.lastRandomChallengeAt >= randomEveryMs) {
    store.lastRandomChallengeAt = nowMs;
    const { event } = records[Math.floor(random() * records.length)];
    await challengeRecord(store, event, fetchImpl);
  }
};

export const startChallenges = (store, intervalMs = 5_000) => {
  let running = false;
  const step = async () => {
    if (running) return;
    running = true;
    try {
      await runChallengeStep(store);
    } catch (error) {
      console.error('Challenge step failed:', error.message);
    } finally {
      running = false;
    }
  };
  void step();
  const timer = setInterval(step, intervalMs);
  timer.unref();
  return timer;
};
