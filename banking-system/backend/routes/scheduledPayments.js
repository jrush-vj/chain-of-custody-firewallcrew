import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { scheduledPaymentValidation } from '../middleware/validation.js';
import { Account } from '../models/Account.js';
import { ScheduledPayment } from '../models/ScheduledPayment.js';

const router = express.Router();

router.use(authenticateToken);

/**
 * @swagger
 * /api/scheduled-payments:
 *   get:
 *     summary: List scheduled orders/bills
 *     tags: [Scheduled Payments]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Scheduled payments
 */
router.get('/', async (req, res, next) => {
  try {
    const payments = await ScheduledPayment.findByUser(req.user.id);
    res.json(payments);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/scheduled-payments:
 *   post:
 *     summary: Create or schedule a future payment
 *     tags: [Scheduled Payments]
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
 *               - payee_name
 *               - payee_iban
 *               - amount
 *               - frequency
 *               - start_date
 *             properties:
 *               account_id:
 *                 type: integer
 *               payee_name:
 *                 type: string
 *               payee_iban:
 *                 type: string
 *               amount:
 *                 type: number
 *               frequency:
 *                 type: string
 *                 enum: [once, weekly, biweekly, monthly, quarterly, yearly]
 *               start_date:
 *                 type: string
 *                 format: date
 *               notes:
 *                 type: string
 *     responses:
 *       201:
 *         description: Scheduled payment created
 */
router.post('/', scheduledPaymentValidation, async (req, res, next) => {
  try {
    const { account_id, payee_name, payee_iban, amount, frequency, start_date, notes } = req.body;

    const account = await Account.findById(account_id);
    if (!account || account.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Account not found or inaccessible' });
    }

    const payment = await ScheduledPayment.create({
      userId: req.user.id,
      accountId: account_id,
      payeeName: payee_name,
      payeeIban: payee_iban,
      amount,
      frequency,
      startDate: start_date,
      notes
    });

    res.status(201).json(payment);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/scheduled-payments/{id}:
 *   delete:
 *     summary: Cancel a scheduled payment
 *     tags: [Scheduled Payments]
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
 *         description: Scheduled payment cancelled
 *       404:
 *         description: Payment not found
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await ScheduledPayment.delete(req.params.id, req.user.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Scheduled payment not found' });
    }
    res.json({ message: 'Scheduled payment cancelled', payment: deleted });
  } catch (error) {
    next(error);
  }
});

export default router;
