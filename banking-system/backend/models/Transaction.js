import { getPool } from '../config/database.js';
import { decryptAccountNumber } from '../utils/accountNumbers.js';

export class Transaction {
  static async create(
    fromAccountId,
    toAccountId,
    amount,
    type,
    status = 'completed',
    options = {}
  ) {
    const pool = getPool();

    if (type === 'deposit' && !options.external_from_name) {
      options.external_from_name = 'CASH IN';
    }
    if (type === 'withdrawal' && !options.external_to_name) {
      options.external_to_name = 'CASH OUT';
    }
    
    const result = await pool.query(
      `INSERT INTO transactions (
        from_account_id,
        to_account_id,
        amount,
        type,
        status,
        timestamp,
        external_from_name,
        external_from_iban,
        external_to_name,
        external_to_iban,
        reference
      )
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        fromAccountId,
        toAccountId,
        amount,
        type,
        status,
        options.external_from_name || null,
        options.external_from_iban || null,
        options.external_to_name || null,
        options.external_to_iban || null,
        options.reference || null
      ]
    );
    
    return mapTransactionRow(result.rows[0]);
  }

  static async findByAccountId(accountId, filters = {}) {
    const pool = getPool();
    let query = `
      SELECT t.*, 
        fa.account_number as from_account_number,
        ta.account_number as to_account_number
      FROM transactions t
      LEFT JOIN accounts fa ON t.from_account_id = fa.id
      LEFT JOIN accounts ta ON t.to_account_id = ta.id
      WHERE (t.from_account_id = $1 OR t.to_account_id = $1)
    `;
    
    const params = [accountId];
    let paramIndex = 2;
    
    if (filters.type) {
      query += ` AND t.type = $${paramIndex}`;
      params.push(filters.type);
      paramIndex++;
    }
    
    if (filters.startDate) {
      query += ` AND t.timestamp >= $${paramIndex}`;
      params.push(filters.startDate);
      paramIndex++;
    }
    
    if (filters.endDate) {
      query += ` AND t.timestamp <= $${paramIndex}`;
      params.push(filters.endDate);
      paramIndex++;
    }
    
    query += ' ORDER BY t.timestamp DESC';
    
    if (filters.limit) {
      query += ` LIMIT $${paramIndex}`;
      params.push(filters.limit);
      paramIndex++;
      if (filters.offset) {
        query += ` OFFSET $${paramIndex}`;
        params.push(filters.offset);
      }
    }
    
    const result = await pool.query(query, params);
    return result.rows.map(mapTransactionRow);
  }

  static async findByUserId(userId, filters = {}) {
    const pool = getPool();
    let query = `
      SELECT t.*, 
        fa.account_number as from_account_number,
        ta.account_number as to_account_number
      FROM transactions t
      LEFT JOIN accounts fa ON t.from_account_id = fa.id
      LEFT JOIN accounts ta ON t.to_account_id = ta.id
      WHERE (fa.user_id = $1 OR ta.user_id = $1)
    `;
    
    const params = [userId];
    let paramIndex = 2;
    
    if (filters.type) {
      query += ` AND t.type = $${paramIndex}`;
      params.push(filters.type);
      paramIndex++;
    }
    
    if (filters.startDate) {
      query += ` AND t.timestamp >= $${paramIndex}`;
      params.push(filters.startDate);
      paramIndex++;
    }
    
    if (filters.endDate) {
      query += ` AND t.timestamp <= $${paramIndex}`;
      params.push(filters.endDate);
      paramIndex++;
    }
    
    query += ' ORDER BY t.timestamp DESC';
    
    if (filters.limit) {
      query += ` LIMIT $${paramIndex}`;
      params.push(filters.limit);
      paramIndex++;
      if (filters.offset) {
        query += ` OFFSET $${paramIndex}`;
        params.push(filters.offset);
      }
    }
    
    const result = await pool.query(query, params);
    return result.rows.map(mapTransactionRow);
  }

  static async countByUserId(userId, filters = {}) {
    const pool = getPool();
    let query = `
      SELECT COUNT(*) as total
      FROM transactions t
      LEFT JOIN accounts fa ON t.from_account_id = fa.id
      LEFT JOIN accounts ta ON t.to_account_id = ta.id
      WHERE (fa.user_id = $1 OR ta.user_id = $1)
    `;
    
    const params = [userId];
    let paramIndex = 2;
    
    if (filters.type) {
      query += ` AND t.type = $${paramIndex}`;
      params.push(filters.type);
      paramIndex++;
    }
    
    if (filters.startDate) {
      query += ` AND t.timestamp >= $${paramIndex}`;
      params.push(filters.startDate);
      paramIndex++;
    }
    
    if (filters.endDate) {
      query += ` AND t.timestamp <= $${paramIndex}`;
      params.push(filters.endDate);
      paramIndex++;
    }
    
    const result = await pool.query(query, params);
    return parseInt(result.rows[0].total);
  }

  static async findAll(limit = 100, offset = 0) {
    const pool = getPool();
    const result = await pool.query(
      `SELECT t.*, 
        fa.account_number as from_account_number,
        ta.account_number as to_account_number,
        u1.username as from_user,
        u2.username as to_user
       FROM transactions t
       LEFT JOIN accounts fa ON t.from_account_id = fa.id
       LEFT JOIN accounts ta ON t.to_account_id = ta.id
       LEFT JOIN users u1 ON fa.user_id = u1.id
       LEFT JOIN users u2 ON ta.user_id = u2.id
       ORDER BY t.timestamp DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows.map(mapTransactionRow);
  }

  static async count() {
    const pool = getPool();
    const result = await pool.query('SELECT COUNT(*) as total FROM transactions');
    return parseInt(result.rows[0].total);
  }
}

const mapTransactionRow = (row) => {
  if (!row) {
    return row;
  }

  const fromAccount = row.from_account_number
    ? decryptAccountNumber(row.from_account_number)
    : null;
  const toAccount = row.to_account_number ? decryptAccountNumber(row.to_account_number) : null;

  const fromDisplay =
    fromAccount ||
    row.external_from_name ||
    (row.type === 'deposit' ? 'CASH IN' : null) ||
    (row.type === 'external_incoming' ? row.external_from_name : null);

  const toDisplay =
    toAccount ||
    row.external_to_name ||
    (row.type === 'withdrawal' ? 'CASH OUT' : null) ||
    (row.type === 'external_outgoing' ? row.external_to_name : null);

  return {
    ...row,
    from_account_number: fromAccount,
    to_account_number: toAccount,
    from_display: fromDisplay,
    to_display: toDisplay
  };
};
