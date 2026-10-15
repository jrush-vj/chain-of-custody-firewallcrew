export const BANK_RANDOM_CHECK_INTERVAL_MS = 30_000;
export const BANK_CALL_WINDOW_MS = 15 * 60 * 1000;
export const BANK_CALL_BUDGET = 60;
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

const retryDelayMs = (response, nowMs) => {
  const retryAfter = response.headers?.get?.('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs);
  }
  const reset = Number(response.headers?.get?.('ratelimit-reset'));
  return Number.isFinite(reset) && reset >= 0 ? reset * 1000 : 60_000;
};

const eventByTransactionId = (store) =>
  new Map(store.committedEvents().map((event) => [event.transaction_id, event]));

const createFinding = (event, actual, differences, passAt, previousHealthy, health) => {
  const evidence = {
    previous_healthy: previousHealthy
      ? {
          transaction_id: previousHealthy.transaction_id,
          type: previousHealthy.type,
          amount_minor: previousHealthy.amount_minor,
          event_id: previousHealthy.event_id,
          verified_at: new Date(passAt).toISOString()
        }
      : null,
    matched_before: health.lastMatchedAt ? new Date(health.lastMatchedAt).toISOString() : null,
    first_seen_at: health.firstSeenAt ? new Date(health.firstSeenAt).toISOString() : null
  };
  if (!actual) {
    return {
      transaction_id: event.transaction_id,
      issue: 'missing',
      witnessed_type: event.type,
      witnessed_amount_minor: event.amount_minor,
      witnessed_event_id: event.event_id,
      ...evidence
    };
  }
  return {
    transaction_id: event.transaction_id,
    issue: `changed_${differences.join('_')}`,
    fields: differences,
    witnessed_type: event.type,
    bank_type: actual.type,
    witnessed_amount_minor: event.amount_minor,
    bank_amount_minor: Number(actual.amount_minor),
    witnessed_event_id: event.event_id,
    bank_event_id: actual.event_id,
    ...evidence
  };
};

const checkResultFor = (event, actual) => {
  if (!actual) return { state: 'missing', finding: null };
  const differences = [];
  if (actual.type !== event.type) differences.push('type');
  if (Number(actual.amount_minor) !== event.amount_minor) differences.push('amount');
  if (actual.event_id !== event.event_id) differences.push('event_id');
  return differences.length
    ? { state: 'mismatch', finding: null, differences }
    : { state: 'ok', finding: null, differences: [] };
};

const recordChallengeResult = (store, event, result) => {
  if (result.state === 'ok') {
    store.recordChallenge(event.transaction_id, 'ok', 'matches the bank');
  } else if (result.state === 'mismatch') {
    const issue = result.finding?.issue || `changed_${result.differences.join('_')}`;
    store.recordChallenge(event.transaction_id, 'mismatch', `differs from the bank: ${issue.replaceAll('_', ' ')}`);
  } else if (result.state === 'missing') {
    if (result.recordMissing !== false) {
      store.recordChallenge(event.transaction_id, 'mismatch', 'differs from the bank: missing');
    } else {
      store.recordChallenge(event.transaction_id, 'none', 'record still settling');
    }
  } else if (result.state === 'rate_limited') {
    store.recordChallenge(event.transaction_id, 'none', 'rate limited by the bank');
  } else {
    store.recordChallenge(event.transaction_id, 'none');
  }
};

// Check only the requested transaction ids. Each HTTP request is capped at 100 ids and shares
// a 60-call rolling budget with every other bank check.
export const checkBankRows = async (store, ids, fetchImpl = fetch, { recordMissing = true, now = Date.now } = {}) => {
  const events = eventByTransactionId(store);
  const requested = [...new Set(ids)].filter((id) => events.has(id)).sort((a, b) => a - b);
  const results = new Map();
  if (requested.length === 0 || store.integrityError) return results;

  for (let offset = 0; offset < requested.length; offset += batchSize) {
    const batchIds = requested.slice(offset, offset + batchSize);
    const batchEvents = batchIds.map((id) => events.get(id));
    const nowMs = now();
    if (!store.canCallBank(nowMs)) {
      store.recordBankBudgetLimit(nowMs);
      for (const event of batchEvents) {
        const result = { state: 'rate_limited' };
        results.set(event.transaction_id, result);
        recordChallengeResult(store, event, result);
      }
      store.setReconciliation();
      continue;
    }

    store.recordBankCall(nowMs);
    try {
      const url = new URL(getEndpoint());
      url.searchParams.set('transaction_ids', batchIds.join(','));
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      if (response.status === 429) {
        const error = 'Bank reconciliation endpoint returned HTTP 429';
        store.recordBankCallResult({
          ok: false,
          error,
          retryAfterMs: retryDelayMs(response, now())
        }, now());
        for (const event of batchEvents) {
          const result = { state: 'rate_limited' };
          results.set(event.transaction_id, result);
          recordChallengeResult(store, event, result);
        }
        continue;
      }
      if (!response.ok) {
        throw new Error(`Bank reconciliation endpoint returned HTTP ${response.status}`);
      }
      const body = await response.json();
      if (!body || !Array.isArray(body.transactions)) {
        throw new Error('Bank reconciliation endpoint returned an invalid response');
      }
      const observed = new Map();
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

      const checkedAt = now();
      store.recordBankCallResult({ ok: true }, checkedAt);
      let previousHealthy = null;
      for (const event of batchEvents) {
        const actual = observed.get(event.transaction_id);
        const compared = checkResultFor(event, actual);
        const health = store.recordHealth.get(event.transaction_id) || { lastMatchedAt: null, firstSeenAt: null };
        if (compared.state === 'ok') {
          health.lastMatchedAt = checkedAt;
          health.firstSeenAt = null;
          store.bankPassedIds.add(event.transaction_id);
          store.bankFindings.delete(event.transaction_id);
          previousHealthy = event;
        } else if (compared.state === 'mismatch' || (compared.state === 'missing' && recordMissing)) {
          if (health.firstSeenAt === null) health.firstSeenAt = checkedAt;
          store.bankPassedIds.delete(event.transaction_id);
          compared.finding = createFinding(event, actual, compared.differences || [], checkedAt, previousHealthy, health);
          store.bankFindings.set(event.transaction_id, compared.finding);
        } else if (compared.state === 'missing') {
          store.bankPassedIds.delete(event.transaction_id);
        }
        if (compared.state === 'missing') compared.recordMissing = recordMissing;
        store.recordHealth.set(event.transaction_id, health);
        results.set(event.transaction_id, compared);
        recordChallengeResult(store, event, compared);
      }
      store.setReconciliation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.recordBankCallResult({ ok: false, error: message }, now());
      for (const event of batchEvents) {
        const result = { state: 'unavailable', error: message };
        results.set(event.transaction_id, result);
        recordChallengeResult(store, event, result);
      }
    }
  }
  return results;
};

// Check one record against the bank. Kept as a small API for callers/tests that need a single result.
export const challengeRecord = async (store, event, fetchImpl = fetch, options = {}) => {
  const results = await checkBankRows(store, [event.transaction_id], fetchImpl, options);
  const state = results.get(event.transaction_id)?.state || 'unavailable';
  return state === 'unavailable' ? 'none' : state;
};

// One scheduler step. It checks settled fresh records once and one random settled record every
// 30 seconds. Unsettled records are never asked of the bank.
export const runChallengeStep = async (store, {
  fetchImpl = fetch,
  nowMs = Date.now(),
  randomEveryMs = BANK_RANDOM_CHECK_INTERVAL_MS,
  freshLimit = 3,
  settleMs = 30_000,
  random = Math.random
} = {}) => {
  if (store.integrityError) return;
  const records = store.committedRecords();
  if (!store.challengeBaselineSet) {
    for (const { event } of records) store.challengedEventIds.add(event.event_id);
    store.challengeBaselineSet = true;
  }

  const settled = records.filter(({ committed_at: committedAt }) => nowMs - Date.parse(committedAt) >= settleMs);
  const fresh = settled
    .filter(({ event }) => !store.challengedEventIds.has(event.event_id))
    .slice(0, freshLimit);
  if (fresh.length) {
    const results = await checkBankRows(
      store,
      fresh.map(({ event }) => event.transaction_id),
      fetchImpl,
      { recordMissing: true, now: () => nowMs }
    );
    for (const { event } of fresh) {
      const result = results.get(event.transaction_id);
      if (result && !['unavailable', 'rate_limited'].includes(result.state)) {
        store.challengedEventIds.add(event.event_id);
      }
    }
  }

  if (settled.length && nowMs - store.lastRandomChallengeAt >= randomEveryMs) {
    store.lastRandomChallengeAt = nowMs;
    const { event, committed_at: committedAt } = settled[Math.floor(random() * settled.length)];
    const recordMissing = nowMs - Date.parse(committedAt) >= settleMs;
    await checkBankRows(store, [event.transaction_id], fetchImpl, { recordMissing, now: () => nowMs });
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
