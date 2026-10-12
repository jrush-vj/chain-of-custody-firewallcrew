import { getPool } from '../config/database.js';
import {
  encryptIban,
  decryptIban,
  hashIban,
  decryptAccountNumber
} from '../utils/accountNumbers.js';

const serialize = (row) => {
  if (!row) {
    return row;
  }

  return {
    ...row,
    payee_iban: row.payee_iban ? decryptIban(row.payee_iban) : null
  };
};

export class ScheduledPayment {
  static async create({
    userId,
    accountId,
    payeeName,
    payeeIban,
    amount,
    frequency,
    startDate,
    notes
  }) {
    const pool = getPool();
    const encryptedIban = encryptIban(payeeIban);
    const hashedIban = hashIban(payeeIban);

    const result = await pool.query(
      `INSERT INTO scheduled_payments (
        user_id,
        account_id,
        payee_name,
        payee_iban,
        payee_iban_hash,
        amount,
        frequency,
        start_date,
        next_run,
        notes,
        status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8::date, $9, 'scheduled', NOW(), NOW())
      RETURNING *`,
      [
        userId,
        accountId,
        payeeName,
        encryptedIban,
        hashedIban,
        amount,
        frequency,
        startDate,
        notes || null
      ]
    );

    return serialize(result.rows[0]);
  }

  static async findByUser(userId) {
    const pool = getPool();
    const result = await pool.query(
      `SELECT sp.*, a.account_number
       FROM scheduled_payments sp
       JOIN accounts a ON sp.account_id = a.id
       WHERE sp.user_id = $1
       ORDER BY sp.created_at DESC`,
      [userId]
    );

    return result.rows.map((row) => ({
      ...serialize(row),
      account_number: row.account_number ? decryptAccountNumber(row.account_number) : null
    }));
  }

  static async delete(id, userId) {
    const pool = getPool();
    const result = await pool.query(
      'DELETE FROM scheduled_payments WHERE id = $1 AND user_id = $2 RETURNING *',
      [id, userId]
    );
    return serialize(result.rows[0]);
  }
}
