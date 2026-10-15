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
<<<<<<< HEAD

const router = express.Router();

=======
import { executeWitnessedTransaction } from '../services/witnessedTransactions.js';
import { getPool } from '../config/database.js';

const router = express.Router();

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

>>>>>>> firewallcrew-publish
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
<<<<<<< HEAD
=======
 *       202:
 *         description: Payment recorded locally; witness confirmation is pending
>>>>>>> firewallcrew-publish
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

<<<<<<< HEAD
      const newBalance = parseFloat(account.balance) + parseFloat(amount);
      await Account.updateBalance(account.id, newBalance);

      const transaction = await Transaction.create(
        null,
        account.id,
        amount,
        'external_incoming',
        'completed',
        {
=======
      const result = await executeWitnessedTransaction({
        toAccountId: account.id,
        amount,
        type: 'external_incoming',
        options: {
>>>>>>> firewallcrew-publish
          external_from_name: sender_name,
          external_from_iban: iban,
          reference
        }
<<<<<<< HEAD
      );

      res.status(201).json({
        message: 'Incoming payment recorded',
        transaction,
        new_balance: newBalance
=======
      });
      return sendTransactionResult(res, result, 'Incoming payment recorded', {
        new_balance: result.toBalance
>>>>>>> firewallcrew-publish
      });
    } catch (error) {
      next(error);
    }
  }
);

<<<<<<< HEAD
=======
router.get('/witness-reconcile', async (req, res, next) => {
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

>>>>>>> firewallcrew-publish
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
    const { type, startDate, endDate, page = 1, limit = 20 } = req.query;
    const filters = {
      type,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      offset: (parseInt(page) - 1) * parseInt(limit),
      limit: parseInt(limit)
    };

    const transactions = await Transaction.findByUserId(req.user.id, filters);
    const total = await Transaction.countByUserId(req.user.id, filters);

    res.json({
      transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
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
<<<<<<< HEAD
=======
 *       202:
 *         description: Deposit recorded locally; witness confirmation is pending
>>>>>>> firewallcrew-publish
 */
router.post('/deposit', depositWithdrawValidation, async (req, res, next) => {
  try {
    const { account_id, amount } = req.body;

    if (!account_id) {
      return res.status(400).json({ error: 'Account ID is required' });
    }

<<<<<<< HEAD
    const account = await Account.findById(parseInt(account_id));
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    if (parseInt(account.user_id) !== parseInt(req.user.id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const newBalance = parseFloat(account.balance) + parseFloat(amount);
    await Account.updateBalance(account_id, newBalance);

    const transaction = await Transaction.create(null, account_id, amount, 'deposit', 'completed', {
      external_from_name: 'CASH IN'
    });

    res.status(201).json({
      message: 'Deposit successful',
      transaction,
      new_balance: newBalance
=======
    const result = await executeWitnessedTransaction({
      toAccountId: account_id,
      amount,
      type: 'deposit',
      ownerUserId: req.user.id,
      options: { external_from_name: 'CASH IN' }
    });
    return sendTransactionResult(res, result, 'Deposit successful', {
      new_balance: result.toBalance
>>>>>>> firewallcrew-publish
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
<<<<<<< HEAD
=======
 *       202:
 *         description: Withdrawal recorded locally; witness confirmation is pending
>>>>>>> firewallcrew-publish
 *       400:
 *         description: Insufficient funds
 */
router.post('/withdraw', depositWithdrawValidation, async (req, res, next) => {
  try {
    const { account_id, amount } = req.body;

    if (!account_id) {
      return res.status(400).json({ error: 'Account ID is required' });
    }

<<<<<<< HEAD
    const account = await Account.findById(parseInt(account_id));
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    if (parseInt(account.user_id) !== parseInt(req.user.id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const currentBalance = parseFloat(account.balance);
    const withdrawalAmount = parseFloat(amount);

    if (currentBalance < withdrawalAmount) {
      return res.status(400).json({ error: 'Insufficient funds' });
    }

    const newBalance = currentBalance - withdrawalAmount;
    await Account.updateBalance(account_id, newBalance);

    const transaction = await Transaction.create(account_id, null, amount, 'withdrawal', 'completed', {
      external_to_name: 'CASH OUT'
    });

    res.status(201).json({
      message: 'Withdrawal successful',
      transaction,
      new_balance: newBalance
=======
    const result = await executeWitnessedTransaction({
      fromAccountId: account_id,
      amount,
      type: 'withdrawal',
      ownerUserId: req.user.id,
      options: { external_to_name: 'CASH OUT' }
    });
    return sendTransactionResult(res, result, 'Withdrawal successful', {
      new_balance: result.fromBalance
>>>>>>> firewallcrew-publish
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
<<<<<<< HEAD
=======
 *       202:
 *         description: Payment recorded locally; witness confirmation is pending
>>>>>>> firewallcrew-publish
 */
router.post('/external/outgoing', externalOutgoingValidation, async (req, res, next) => {
  try {
    const { from_account_id, recipient_name, recipient_iban, amount, reference } = req.body;

<<<<<<< HEAD
    const account = await Account.findById(from_account_id);
    if (!account || account.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Source account not found or inaccessible' });
    }

    const paymentAmount = parseFloat(amount);
    if (paymentAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }

    if (parseFloat(account.balance) < paymentAmount) {
      return res.status(400).json({ error: 'Insufficient funds' });
    }

    const newBalance = parseFloat(account.balance) - paymentAmount;
    await Account.updateBalance(account.id, newBalance);

    const transaction = await Transaction.create(
      account.id,
      null,
      paymentAmount,
      'external_outgoing',
      'completed',
      {
=======
    const result = await executeWitnessedTransaction({
      fromAccountId: from_account_id,
      amount,
      type: 'external_outgoing',
      ownerUserId: req.user.id,
      options: {
>>>>>>> firewallcrew-publish
        external_to_name: recipient_name,
        external_to_iban: recipient_iban,
        reference
      }
<<<<<<< HEAD
    );

    res.status(201).json({
      message: 'Payment sent successfully',
      transaction,
      new_balance: newBalance
=======
    });
    return sendTransactionResult(res, result, 'Payment sent successfully', {
      new_balance: result.fromBalance
>>>>>>> firewallcrew-publish
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
<<<<<<< HEAD
=======
 *       202:
 *         description: Transfer recorded locally; witness confirmation is pending
>>>>>>> firewallcrew-publish
 *       400:
 *         description: Insufficient funds or invalid accounts
 */
router.post('/transfer', transferValidation, async (req, res, next) => {
  try {
    const { from_account_id, to_account_id, amount } = req.body;

<<<<<<< HEAD
    if (from_account_id === to_account_id) {
      return res.status(400).json({ error: 'Cannot transfer to the same account' });
    }

    const fromAccount = await Account.findById(from_account_id);
    const toAccount = await Account.findById(to_account_id);

    if (!fromAccount || !toAccount) {
      return res.status(404).json({ error: 'One or both accounts not found' });
    }

    if (fromAccount.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied to source account' });
    }

    const currentBalance = parseFloat(fromAccount.balance);
    const transferAmount = parseFloat(amount);

    if (currentBalance < transferAmount) {
      return res.status(400).json({ error: 'Insufficient funds' });
    }

    const fromNewBalance = currentBalance - transferAmount;
    const toNewBalance = parseFloat(toAccount.balance) + transferAmount;

    await Account.updateBalance(from_account_id, fromNewBalance);
    await Account.updateBalance(to_account_id, toNewBalance);

    const transaction = await Transaction.create(from_account_id, to_account_id, amount, 'transfer');

    res.status(201).json({
      message: 'Transfer successful',
      transaction,
      from_account_balance: fromNewBalance,
      to_account_balance: toNewBalance
=======
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
>>>>>>> firewallcrew-publish
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
