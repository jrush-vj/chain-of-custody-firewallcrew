import express from 'express';
import { Transaction } from '../models/Transaction.js';
import { Account } from '../models/Account.js';
import { authenticateToken } from '../middleware/auth.js';
import {
  transferValidation,
  depositWithdrawValidation,
  externalIncomingValidation,
  externalOutgoingValidation
} from '../middleware/validation.js';
import { requireExternalApiKey } from '../middleware/externalApiKey.js';
import { requireWitnessReconcileAuth } from '../middleware/witnessReconcileAuth.js';
import { executeWitnessedTransaction } from '../services/witnessedTransactions.js';
import { getPool } from '../config/database.js';

const router = express.Router();

const TRANSACTION_TYPES = ['deposit', 'withdrawal', 'transfer', 'external_incoming', 'external_outgoing'];

const sendTransactionResult = (res, result, message, details = {}) =>
  res.status(result.pendingWitness ? 202 : 201).json({
    message: result.pendingWitness
      ? `${message} The transaction is recorded locally; witness confirmation is pending. Do not retry blindly.`
      : message,
    witness_status: result.pendingWitness ? 'pending' : 'confirmed',
    witness_event_id: result.witnessEventId,
    transaction: result.transaction,
    ...details
  });

/**
 * @swagger
 * /api/transactions/external/incoming:
 *   post:
 *     summary: Record an incoming payment from an external IBAN
 *     tags: [Transactions]
 *     security: []
 *     parameters:
 *       - in: header
 *         name: X-External-API-Key
 *         required: true
 *         schema:
 *           type: string
 *         description: API key configured via EXTERNAL_PAYMENTS_API_KEY
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - iban
 *               - sender_name
 *               - amount
 *             properties:
 *               iban:
 *                 type: string
 *               sender_name:
 *                 type: string
 *               amount:
 *                 type: number
 *               reference:
 *                 type: string
 *                 example: Invoice 123
 *     responses:
 *       201:
 *         description: Incoming payment registered
 *       202:
 *         description: Payment recorded locally; witness confirmation is pending
 */
router.post(
  '/external/incoming',
  requireExternalApiKey,
  externalIncomingValidation,
  async (req, res, next) => {
    try {
      const { iban, sender_name, amount, reference } = req.body;
      const account = await Account.findByIban(iban);
      if (!account) {
        return res.status(404).json({ error: 'Destination account not found for provided IBAN' });
      }

      const result = await executeWitnessedTransaction({
        toAccountId: account.id,
        amount,
        type: 'external_incoming',
        options: {
          external_from_name: sender_name,
          external_from_iban: iban,
          reference
        }
      });
      return sendTransactionResult(res, result, 'Incoming payment recorded', {
        new_balance: result.toBalance
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get('/witness-reconcile', requireWitnessReconcileAuth, async (req, res, next) => {
  try {
    const rawIds = req.query.transaction_ids;
    if (typeof rawIds !== 'string') {
      return res.status(400).json({ error: 'transaction_ids is required' });
    }
    const ids = rawIds.split(',').map((value) => Number(value));
    if (
      ids.length < 1 ||
      ids.length > 100 ||
      ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(ids).size !== ids.length
    ) {
      return res.status(400).json({ error: 'transaction_ids must contain 1 to 100 unique positive integers' });
    }

    const { rows } = await getPool().query(
      `SELECT t.id AS transaction_id,
              t.type,
              (t.amount * 100)::bigint AS amount_minor,
              o.event_id
       FROM transactions t
       JOIN witness_outbox o ON o.transaction_id = t.id
       WHERE t.id = ANY($1::int[])
         AND o.status = 'confirmed'`,
      [ids]
    );
    res.set('Cache-Control', 'no-store');
    return res.json({ transactions: rows });
  } catch (error) {
    return next(error);
  }
});

router.use(authenticateToken);

/**
 * @swagger
 * /api/transactions:
 *   get:
 *     summary: Get transaction history with filtering and pagination
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [deposit, withdrawal, transfer, external_incoming, external_outgoing]
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Transaction history
 */
router.get('/', async (req, res, next) => {
  try {
    const { type, startDate, endDate } = req.query;
    // Bounded pagination: an unbounded or non-numeric limit could dump or stall the whole table.
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    if (type !== undefined && !TRANSACTION_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Invalid transaction type filter' });
    }
    const parsedStart = startDate ? new Date(startDate) : null;
    const parsedEnd = endDate ? new Date(endDate) : null;
    if ((parsedStart && Number.isNaN(parsedStart.getTime())) || (parsedEnd && Number.isNaN(parsedEnd.getTime()))) {
      return res.status(400).json({ error: 'startDate and endDate must be valid dates' });
    }
    const filters = {
      type,
      startDate: parsedStart,
      endDate: parsedEnd,
      offset: (page - 1) * limit,
      limit
    };

    const transactions = await Transaction.findByUserId(req.user.id, filters);
    const total = await Transaction.countByUserId(req.user.id, filters);

    res.json({
      transactions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/transactions/deposit:
 *   post:
 *     summary: Deposit money to an account
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - account_id
 *               - amount
 *             properties:
 *               account_id:
 *                 type: integer
 *               amount:
 *                 type: number
 *     responses:
 *       201:
 *         description: Deposit successful
 *       202:
 *         description: Deposit recorded locally; witness confirmation is pending
 */
router.post('/deposit', depositWithdrawValidation, async (req, res, next) => {
  try {
    const { account_id, amount } = req.body;

    if (!account_id) {
      return res.status(400).json({ error: 'Account ID is required' });
    }

    const result = await executeWitnessedTransaction({
      toAccountId: account_id,
      amount,
      type: 'deposit',
      ownerUserId: req.user.id,
      options: { external_from_name: 'CASH IN' }
    });
    return sendTransactionResult(res, result, 'Deposit successful', {
      new_balance: result.toBalance
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/transactions/withdraw:
 *   post:
 *     summary: Withdraw money from an account
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - account_id
 *               - amount
 *             properties:
 *               account_id:
 *                 type: integer
 *               amount:
 *                 type: number
 *     responses:
 *       201:
 *         description: Withdrawal successful
 *       202:
 *         description: Withdrawal recorded locally; witness confirmation is pending
 *       400:
 *         description: Insufficient funds
 */
router.post('/withdraw', depositWithdrawValidation, async (req, res, next) => {
  try {
    const { account_id, amount } = req.body;

    if (!account_id) {
      return res.status(400).json({ error: 'Account ID is required' });
    }

    const result = await executeWitnessedTransaction({
      fromAccountId: account_id,
      amount,
      type: 'withdrawal',
      ownerUserId: req.user.id,
      options: { external_to_name: 'CASH OUT' }
    });
    return sendTransactionResult(res, result, 'Withdrawal successful', {
      new_balance: result.fromBalance
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/transactions/external/outgoing:
 *   post:
 *     summary: Send funds from a user account to an external IBAN
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - from_account_id
 *               - recipient_name
 *               - recipient_iban
 *               - amount
 *             properties:
 *               from_account_id:
 *                 type: integer
 *               recipient_name:
 *                 type: string
 *               recipient_iban:
 *                 type: string
 *               amount:
 *                 type: number
 *               reference:
 *                 type: string
 *                 example: Rent payment
 *     responses:
 *       201:
 *         description: External payment initiated
 *       202:
 *         description: Payment recorded locally; witness confirmation is pending
 */
router.post('/external/outgoing', externalOutgoingValidation, async (req, res, next) => {
  try {
    const { from_account_id, recipient_name, recipient_iban, amount, reference } = req.body;

    const result = await executeWitnessedTransaction({
      fromAccountId: from_account_id,
      amount,
      type: 'external_outgoing',
      ownerUserId: req.user.id,
      options: {
        external_to_name: recipient_name,
        external_to_iban: recipient_iban,
        reference
      }
    });
    return sendTransactionResult(res, result, 'Payment sent successfully', {
      new_balance: result.fromBalance
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/transactions/transfer:
 *   post:
 *     summary: Transfer money between accounts
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - from_account_id
 *               - to_account_id
 *               - amount
 *             properties:
 *               from_account_id:
 *                 type: integer
 *               to_account_id:
 *                 type: integer
 *               amount:
 *                 type: number
 *     responses:
 *       201:
 *         description: Transfer successful
 *       202:
 *         description: Transfer recorded locally; witness confirmation is pending
 *       400:
 *         description: Insufficient funds or invalid accounts
 */
router.post('/transfer', transferValidation, async (req, res, next) => {
  try {
    const { from_account_id, to_account_id, amount } = req.body;

    if (Number(from_account_id) === Number(to_account_id)) {
      return res.status(400).json({ error: 'Cannot transfer to the same account' });
    }

    const result = await executeWitnessedTransaction({
      fromAccountId: from_account_id,
      toAccountId: to_account_id,
      amount,
      type: 'transfer',
      ownerUserId: req.user.id
    });
    return sendTransactionResult(res, result, 'Transfer successful', {
      from_account_balance: result.fromBalance,
      to_account_balance: result.toBalance
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/transactions/balance/{account_id}:
 *   get:
 *     summary: Get account balance
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: account_id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Account balance
 */
router.get('/balance/:account_id', async (req, res, next) => {
  try {
    const account = await Account.findById(req.params.account_id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    if (account.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({
      account_id: account.id,
      account_number: account.account_number,
      balance: account.balance
    });
  } catch (error) {
    next(error);
  }
});

export default router;
