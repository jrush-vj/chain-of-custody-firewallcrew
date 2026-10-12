import crypto from 'crypto';
import { getPool } from '../config/database.js';
import {
  decryptAccountNumber,
  encryptAccountNumber,
  hashAccountNumber,
  encryptIban,
  decryptIban,
  hashIban,
  generateIban
} from '../utils/accountNumbers.js';

export class Account {
  static async create(userId, accountType) {
    const pool = getPool();
    const accountNumber = this.generateAccountNumber();
    const encryptedAccountNumber = encryptAccountNumber(accountNumber);
    const hashedAccountNumber = hashAccountNumber(accountNumber);
    const plainIban = generateIban(accountNumber);
    const encryptedIban = encryptIban(plainIban);
    const hashedIban = hashIban(plainIban);
    
    const result = await pool.query(
      `INSERT INTO accounts (user_id, account_number, account_number_hash, iban, iban_hash, balance, account_type, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING id, user_id, account_number, iban, balance, account_type, created_at`,
      [userId, encryptedAccountNumber, hashedAccountNumber, encryptedIban, hashedIban, 0.0, accountType]
    );
    
    return this.deserializeAccount(result.rows[0]);
  }

  static async findByUserId(userId) {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM accounts WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    
    return result.rows.map((row) => this.deserializeAccount(row));
  }

  static async findById(id) {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM accounts WHERE id = $1',
      [id]
    );
    
    return this.deserializeAccount(result.rows[0]);
  }

  static async findByAccountNumber(accountNumber) {
    const pool = getPool();
    const hashed = hashAccountNumber(accountNumber);
    if (!hashed) {
      return null;
    }

    const result = await pool.query(
      'SELECT * FROM accounts WHERE account_number_hash = $1',
      [hashed]
    );
    
    return this.deserializeAccount(result.rows[0]);
  }

  static async findByIban(iban) {
    const pool = getPool();
    const hashed = hashIban(iban);
    if (!hashed) {
      return null;
    }

    const result = await pool.query('SELECT * FROM accounts WHERE iban_hash = $1', [hashed]);
    return this.deserializeAccount(result.rows[0]);
  }

  static async updateBalance(accountId, newBalance) {
    const pool = getPool();
    const result = await pool.query(
      'UPDATE accounts SET balance = $1 WHERE id = $2',
      [newBalance, accountId]
    );
    
    return result.rowCount > 0;
  }

  static async delete(id) {
    const pool = getPool();
    const result = await pool.query(
      'DELETE FROM accounts WHERE id = $1',
      [id]
    );
    
    return result.rowCount > 0;
  }

  static async findAll(limit = 100, offset = 0) {
    const pool = getPool();
    const result = await pool.query(
      `SELECT a.*, u.username, u.email 
       FROM accounts a 
       JOIN users u ON a.user_id = u.id 
       ORDER BY a.id 
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows.map((row) => this.deserializeAccount(row));
  }

  static async count() {
    const pool = getPool();
    const result = await pool.query('SELECT COUNT(*) as total FROM accounts');
    return parseInt(result.rows[0].total);
  }

  static generateAccountNumber() {
    const randomBytes = crypto.randomBytes(6).toString('hex').toUpperCase();
    const timestampFragment = Date.now().toString().slice(-6);
    return `ACC-${timestampFragment}-${randomBytes}`;
  }

  static deserializeAccount(row) {
    if (!row) {
      return row;
    }

    return {
      ...row,
      account_number: decryptAccountNumber(row.account_number),
      iban: row.iban ? decryptIban(row.iban) : null
    };
  }
}
