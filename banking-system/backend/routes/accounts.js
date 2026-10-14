import express from 'express';
import { Account } from '../models/Account.js';
import { authenticateToken } from '../middleware/auth.js';
import { accountValidation } from '../middleware/validation.js';
import { executeWitnessedTransaction } from '../services/witnessedTransactions.js';
import { getPool } from '../config/database.js';

const router = express.Router();

router.use(authenticateToken);

/**
 * @swagger
 * /api/accounts:
 *   get:
 *     summary: Get all accounts for current user
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of accounts
 */
router.get('/', async (req, res, next) => {
  try {
    const accounts = await Account.findByUserId(req.user.id);
    res.json(accounts);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/accounts:
 *   post:
 *     summary: Create a new account
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - account_type
 *             properties:
 *               account_type:
 *                 type: string
 *                 enum: [checking, savings, business]
 *     responses:
 *       201:
 *         description: Account created successfully
 */
router.post('/', accountValidation, async (req, res, next) => {
  try {
    const { account_type } = req.body;
    const account = await Account.create(req.user.id, account_type);
    res.status(201).json(account);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/accounts/{id}:
 *   get:
 *     summary: Get account by ID
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Account details
 *       404:
 *         description: Account not found
 */
router.get('/:id', async (req, res, next) => {
  try {
    const account = await Account.findById(req.params.id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    if (account.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    res.json(account);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/accounts/{id}:
 *   delete:
 *     summary: Delete an account
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Account deleted successfully
 *       404:
 *         description: Account not found
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const account = await Account.findById(req.params.id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    if (account.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { rows: pendingWitnessEvents } = await getPool().query(
      `SELECT 1
       FROM witness_outbox o
       JOIN transactions t ON t.id = o.transaction_id
       WHERE o.status = 'pending'
         AND (t.from_account_id = $1 OR t.to_account_id = $1)
       LIMIT 1`,
      [account.id]
    );
    if (pendingWitnessEvents.length) {
      return res.status(202).json({
        message: 'Account closure is blocked until its pending witness event is confirmed.',
        witness_status: 'pending'
      });
    }

    const accountBalance = parseFloat(account.balance);
    const transferAccountId =
      req.body?.transfer_account_id || req.query?.transfer_account_id || null;

    if (accountBalance > 0) {
      if (!transferAccountId) {
        return res.status(400).json({
          error:
            'Account has a remaining balance. Provide transfer_account_id to move funds before deletion.'
        });
      }

      if (parseInt(transferAccountId) === parseInt(account.id)) {
        return res.status(400).json({ error: 'Cannot transfer funds to the same account' });
      }

      const destinationAccount = await Account.findById(transferAccountId);
      if (!destinationAccount || destinationAccount.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Destination account not found or inaccessible' });
      }

      const transfer = await executeWitnessedTransaction({
        fromAccountId: account.id,
        toAccountId: destinationAccount.id,
        amount: account.balance,
        type: 'transfer',
        ownerUserId: req.user.id,
        options: {
          reference: 'Balance transfer before account closure'
        }
      });
      if (transfer.pendingWitness) {
        return res.status(202).json({
          message: 'Balance transfer completed locally; witness confirmation is pending. Account closure was not completed.',
          witness_status: 'pending',
          witness_event_id: transfer.witnessEventId
        });
      }
    }
    
    const deleted = await Account.delete(req.params.id);
    if (deleted) {
      res.json({
        message: 'Account deleted successfully',
        transferred_amount: accountBalance > 0 ? accountBalance : 0,
        transfer_account_id: transferAccountId || null
      });
    } else {
      res.status(500).json({ error: 'Failed to delete account' });
    }
  } catch (error) {
    next(error);
  }
});

export default router;

