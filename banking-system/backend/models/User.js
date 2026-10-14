import { getPool } from '../config/database.js';
import bcrypt from 'bcryptjs';

export class User {
  static async create(username, email, password) {
    const pool = getPool();
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id, username, email, created_at, two_factor_enabled`,
      [username, email, hashedPassword]
    );
    
    return result.rows[0];
  }

  static async findByEmail(email) {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    
    return result.rows[0];
  }

  static async findById(id) {
    const pool = getPool();
    const result = await pool.query(
      'SELECT id, username, email, created_at, two_factor_enabled FROM users WHERE id = $1',
      [id]
    );
    
    return result.rows[0];
  }

  static async findByIdWithSensitive(id) {
    const pool = getPool();
    const result = await pool.query(
      `SELECT id, username, email, created_at, two_factor_enabled, two_factor_secret, two_factor_verified_at
       FROM users WHERE id = $1`,
      [id]
    );

    return result.rows[0];
  }

  static async findAll(limit = 100, offset = 0) {
    const pool = getPool();
    const result = await pool.query(
      'SELECT id, username, email, created_at FROM users ORDER BY id LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    return result.rows;
  }

  static async count() {
    const pool = getPool();
    const result = await pool.query('SELECT COUNT(*) as total FROM users');
    return parseInt(result.rows[0].total);
  }

  static async verifyPassword(password, hash) {
    return await bcrypt.compare(password, hash);
  }

  static async updateTwoFactorSecret(userId, encryptedSecret) {
    const pool = getPool();
    await pool.query(
      `UPDATE users
       SET two_factor_secret = $1,
           two_factor_enabled = FALSE,
           two_factor_verified_at = NULL
       WHERE id = $2`,
      [encryptedSecret, userId]
    );
  }

  static async markTwoFactorVerified(userId) {
    const pool = getPool();
    await pool.query(
      `UPDATE users
       SET two_factor_enabled = TRUE,
           two_factor_verified_at = NOW()
       WHERE id = $1`,
      [userId]
    );
  }

  static async disableTwoFactor(userId) {
    const pool = getPool();
    await pool.query(
      `UPDATE users
       SET two_factor_enabled = FALSE,
           two_factor_secret = NULL,
           two_factor_verified_at = NULL
       WHERE id = $1`,
      [userId]
    );
  }
}
