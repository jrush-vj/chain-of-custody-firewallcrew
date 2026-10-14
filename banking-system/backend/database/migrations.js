import { getPool } from '../config/database.js';
import {
  encryptAccountNumber,
  hashAccountNumber,
  decryptAccountNumber,
  isEncryptedAccountNumber,
  generateIban,
  encryptIban,
  decryptIban,
  hashIban,
  isEncryptedIban
} from '../utils/accountNumbers.js';

export const createTables = async () => {
  const pool = getPool();
  
  try {
    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        email VARCHAR(100) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        two_factor_secret TEXT NULL,
        two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        two_factor_verified_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS IX_users_email ON users (email)
    `);

    await pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS two_factor_secret TEXT
    `);
    await pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await pool.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS two_factor_verified_at TIMESTAMP NULL
    `);

    // Create accounts table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        account_number TEXT NOT NULL,
        account_number_hash VARCHAR(128) UNIQUE,
        iban TEXT NOT NULL,
        iban_hash VARCHAR(128) UNIQUE,
        balance DECIMAL(18,2) NOT NULL DEFAULT 0.00,
        account_type VARCHAR(20) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS IX_accounts_user_id ON accounts (user_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS IX_accounts_account_number ON accounts (account_number)
    `);

    await pool.query(`
      ALTER TABLE accounts
        ALTER COLUMN account_number TYPE TEXT
    `);
    await pool.query(`
      ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS account_number_hash VARCHAR(128)
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS IX_accounts_account_number_hash
        ON accounts (account_number_hash)
    `);
    await pool.query(`
      ALTER TABLE accounts
        DROP CONSTRAINT IF EXISTS accounts_account_number_key
    `);
    await pool.query(`
      ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS iban TEXT
    `);
    await pool.query(`
      ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS iban_hash VARCHAR(128)
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS IX_accounts_iban_hash ON accounts (iban_hash)
    `);

    // Create transactions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        from_account_id INTEGER NULL,
        to_account_id INTEGER NULL,
        amount DECIMAL(18,2) NOT NULL,
        type VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'completed',
        timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
        external_from_name VARCHAR(150) NULL,
        external_from_iban TEXT NULL,
        external_to_name VARCHAR(150) NULL,
        external_to_iban TEXT NULL,
        reference TEXT NULL,
        FOREIGN KEY (from_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
        FOREIGN KEY (to_account_id) REFERENCES accounts(id) ON DELETE SET NULL
      )
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS IX_transactions_from_account ON transactions (from_account_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS IX_transactions_to_account ON transactions (to_account_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS IX_transactions_timestamp ON transactions (timestamp)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS IX_transactions_type ON transactions (type)
    `);

    await pool.query(`
      ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS external_from_name VARCHAR(150)
    `);
    await pool.query(`
      ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS external_from_iban TEXT
    `);
    await pool.query(`
      ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS external_to_name VARCHAR(150)
    `);
    await pool.query(`
      ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS external_to_iban TEXT
    `);
    await pool.query(`
      ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS reference TEXT
    `);

    // Scheduled payments for recurring bills/orders
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scheduled_payments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        payee_name VARCHAR(150) NOT NULL,
        payee_iban TEXT NOT NULL,
        payee_iban_hash VARCHAR(128),
        amount DECIMAL(18,2) NOT NULL,
        frequency VARCHAR(50) NOT NULL,
        start_date DATE NOT NULL,
        next_run TIMESTAMP NULL,
        notes TEXT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS IX_scheduled_payments_user ON scheduled_payments (user_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS IX_scheduled_payments_account ON scheduled_payments (account_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS IX_scheduled_payments_status ON scheduled_payments (status)
    `);

    console.log('Database tables created successfully');

    await migrateLegacyAccountNumbers(pool);
  } catch (error) {
    console.error('Error creating tables:', error);
    throw error;
  }
};

const migrateLegacyAccountNumbers = async (pool) => {
  const { rows } = await pool.query(
    'SELECT id, account_number, account_number_hash, iban, iban_hash FROM accounts WHERE account_number IS NOT NULL'
  );

  for (const account of rows) {
    const plainAccountNumber = decryptAccountNumber(account.account_number);
    if (!plainAccountNumber) {
      continue;
    }

    const encryptedAccountValue = isEncryptedAccountNumber(account.account_number)
      ? account.account_number
      : encryptAccountNumber(plainAccountNumber);

    const hashedAccountValue = hashAccountNumber(plainAccountNumber);

    let plainIban = account.iban ? decryptIban(account.iban) : null;
    if (!plainIban) {
      plainIban = generateIban(plainAccountNumber);
    }

    const encryptedIbanValue = account.iban && isEncryptedIban(account.iban)
      ? account.iban
      : encryptIban(plainIban);
    const hashedIbanValue = hashIban(plainIban);

    const needsUpdate =
      account.account_number !== encryptedAccountValue ||
      account.account_number_hash !== hashedAccountValue ||
      account.iban !== encryptedIbanValue ||
      account.iban_hash !== hashedIbanValue;

    if (needsUpdate) {
      await pool.query(
        'UPDATE accounts SET account_number = $1, account_number_hash = $2, iban = $3, iban_hash = $4 WHERE id = $5',
        [encryptedAccountValue, hashedAccountValue, encryptedIbanValue, hashedIbanValue, account.id]
      );
    }
  }
};

export const dropTables = async () => {
  const pool = getPool();
  
  try {
    await pool.query('DROP TABLE IF EXISTS scheduled_payments CASCADE');
    await pool.query('DROP TABLE IF EXISTS transactions CASCADE');
    await pool.query('DROP TABLE IF EXISTS accounts CASCADE');
    await pool.query('DROP TABLE IF EXISTS users CASCADE');
    console.log('Database tables dropped successfully');
  } catch (error) {
    console.error('Error dropping tables:', error);
    throw error;
  }
};
