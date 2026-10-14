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
      store.recordActivity('challenge_mismatch', `transaction #${mismatch.transaction_id}: ${mismatch.issue.replaceAll('_', ' ')}`);
    }
  }
  for (const key of [...store.reportedMismatches]) {
    if (!current.has(key)) {
      store.reportedMismatches.delete(key);
      store.recordActivity('challenge_ok', `transaction #${key.split(':')[0]} matches the bank again`);
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
