import { randomUUID } from 'node:crypto';
import { getPool } from '../config/database.js';
import { Transaction } from '../models/Transaction.js';
import { sendWitnessRequest } from './witnessClient.js';

const createHttpError = (status, message) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const toMinorUnits = (amount) => {
  const value = String(amount).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw createHttpError(400, 'Amount must be a positive number with at most two decimal places');
  }
  const [whole, fraction = ''] = value.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw createHttpError(400, 'Amount is outside the supported range');
  }
  return minor;
};

const balanceToMinorUnits = (balance) => {
  const value = String(balance);
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) {
    throw new Error('Database returned a balance with unsupported precision');
  }
  const minor = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'));
  return match[1] === '-' ? -minor : minor;
};

const toDecimalString = (minor) => {
  const absolute = minor < 0n ? -minor : minor;
  const sign = minor < 0n ? '-' : '';
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
};

export const executeWitnessedTransaction = async ({
  fromAccountId = null,
  toAccountId = null,
  amount,
  type,
  ownerUserId = null,
  options = {}
}) => {
  const amountMinor = toMinorUnits(amount);
  const amountValue = toDecimalString(amountMinor);
  const accountIds = [...new Set([fromAccountId, toAccountId].filter((id) => id !== null).map(Number))]
    .sort((left, right) => left - right);
  if (!accountIds.length || (fromAccountId !== null && Number(fromAccountId) === Number(toAccountId))) {
    throw createHttpError(400, 'Transaction accounts are invalid');
  }

  const pool = getPool();
  const client = await pool.connect();
  const eventId = randomUUID();
  let transaction;
  let fromBalance = null;
  let toBalance = null;
  let prepareAttempted = false;
  let commitStarted = false;

  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, user_id, balance FROM accounts WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE',
      [accountIds]
    );
    const accounts = new Map(rows.map((row) => [Number(row.id), row]));
    for (const accountId of accountIds) {
      const account = accounts.get(accountId);
      if (!account) {
        throw createHttpError(404, 'Account not found');
      }
      if (ownerUserId !== null && Number(account.user_id) !== Number(ownerUserId)) {
        throw createHttpError(403, 'Access denied to account');
      }
    }

    const fromAccount = fromAccountId === null ? null : accounts.get(Number(fromAccountId));
    const toAccount = toAccountId === null ? null : accounts.get(Number(toAccountId));
    if (fromAccount && balanceToMinorUnits(fromAccount.balance) < amountMinor) {
      throw createHttpError(400, 'Insufficient funds');
    }

    fromBalance = fromAccount ? balanceToMinorUnits(fromAccount.balance) : null;
    toBalance = toAccount ? balanceToMinorUnits(toAccount.balance) : null;
    if (fromAccount) {
      fromBalance -= amountMinor;
      await client.query('UPDATE accounts SET balance = $1::numeric WHERE id = $2', [
        toDecimalString(fromBalance),
        fromAccount.id
      ]);
    }
    if (toAccount) {
      toBalance += amountMinor;
      await client.query('UPDATE accounts SET balance = $1::numeric WHERE id = $2', [
        toDecimalString(toBalance),
        toAccount.id
      ]);
    }

    transaction = await Transaction.createWithClient(
      client,
      fromAccount?.id ?? null,
      toAccount?.id ?? null,
      amountValue,
      type,
      'completed',
      options
    );
    const event = {
      event_id: eventId,
      transaction_id: Number(transaction.id),
      type,
      amount_minor: Number(amountMinor),
      occurred_at: new Date(transaction.timestamp).toISOString()
    };
    await client.query(
      `INSERT INTO witness_outbox (event_id, transaction_id, event, status)
       VALUES ($1, $2, $3::jsonb, 'pending')`,
      [eventId, transaction.id, JSON.stringify(event)]
    );

    prepareAttempted = true;
    await sendWitnessRequest('/v1/prepare', { event });

    commitStarted = true;
    await client.query('COMMIT');
  } catch (error) {
    if (!commitStarted) {
      await client.query('ROLLBACK').catch((rollbackError) => {
        console.error('Failed to roll back transaction after witness failure:', rollbackError.message);
      });
      if (prepareAttempted) {
        try {
          await sendWitnessRequest('/v1/abort', { event_id: eventId });
        } catch (abortError) {
          console.error(`Witness abort failed for event ${eventId}:`, abortError.message);
        }
      }
      throw error;
    }

    const outcomeError = createHttpError(
      202,
      'Database commit outcome is uncertain; check transaction history before retrying'
    );
    outcomeError.witnessEventId = eventId;
    outcomeError.witnessStatus = 'uncertain';
    outcomeError.cause = error;
    throw outcomeError;
  } finally {
    client.release();
  }

  let witnessReceipt = null;
  let pendingWitness = false;
  try {
    witnessReceipt = await sendWitnessRequest('/v1/commit', { event_id: eventId });
    await pool.query(
      "UPDATE witness_outbox SET status = 'confirmed', last_error = NULL, updated_at = NOW() WHERE event_id = $1",
      [eventId]
    ).catch((updateError) => {
      console.error(`Witness confirmed but local outbox update failed for event ${eventId}:`, updateError.message);
    });
  } catch (error) {
    pendingWitness = true;
    console.error(`Witness commit pending for event ${eventId}:`, error.message);
    await pool.query(
      "UPDATE witness_outbox SET last_error = $2, updated_at = NOW() WHERE event_id = $1",
      [eventId, error.message]
    ).catch((updateError) => {
      console.error(`Failed to retain witness retry state for event ${eventId}:`, updateError.message);
    });
  }

  return {
    transaction,
    fromBalance: fromBalance === null ? null : toDecimalString(fromBalance),
    toBalance: toBalance === null ? null : toDecimalString(toBalance),
    pendingWitness,
    witnessEventId: eventId,
    witnessReceipt
  };
};

let retryTimer;
let retryRunning = false;

export const startWitnessOutboxRetry = () => {
  if (retryTimer) {
    return;
  }
  retryTimer = setInterval(async () => {
    if (retryRunning) {
      return;
    }
    retryRunning = true;
    try {
      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT event_id
         FROM witness_outbox
         WHERE status = 'pending'
         ORDER BY created_at
         LIMIT 10`
      );
      for (const row of rows) {
        try {
          await sendWitnessRequest('/v1/commit', { event_id: row.event_id });
          await pool.query(
            "UPDATE witness_outbox SET status = 'confirmed', last_error = NULL, updated_at = NOW() WHERE event_id = $1",
            [row.event_id]
          );
        } catch (error) {
          await pool.query(
            'UPDATE witness_outbox SET last_error = $2, updated_at = NOW() WHERE event_id = $1',
            [row.event_id, error.message]
          );
          console.error(`Witness outbox retry failed for event ${row.event_id}:`, error.message);
        }
      }
    } catch (error) {
      console.error('Witness outbox scan failed:', error.message);
    } finally {
      retryRunning = false;
    }
  }, 10_000);
  retryTimer.unref();
};
