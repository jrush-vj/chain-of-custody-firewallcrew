import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const config = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'bankingsystem',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
  application_name: 'banking-system-api'
};

if (process.env.DB_SSL === 'true') {
  config.ssl = {
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false'
  };
}

let pool = null;

export const connectDB = async () => {
  try {
    if (pool) {
      return pool;
    }
    pool = new Pool(config);
    
    // Test the connection
    const client = await pool.connect();
    console.log(`Connected to PostgreSQL: ${config.host}:${config.port}/${config.database}`);
    client.release();
    
    return pool;
  } catch (error) {
    console.error('Database connection error:', error.message);
    console.error('\nTroubleshooting tips:');
    console.error('1. Make sure PostgreSQL is running');
    console.error('2. Check Docker container is running: docker-compose ps');
    console.error('3. Verify connection details in .env file');
    console.error('4. Check database exists and user has permissions');
    console.error(`\nCurrent config: host="${config.host}", port=${config.port}, database="${config.database}", user="${config.user}"`);
    throw error;
  }
};

export const getPool = () => {
  if (!pool) {
    throw new Error('Database not connected. Call connectDB() first.');
  }
  return pool;
};

export { pool };

export const closeDB = async () => {
  try {
    if (pool) {
      await pool.end();
      pool = null;
      console.log('Database connection closed');
    }
  } catch (error) {
    console.error('Error closing database:', error);
  }
};

export default pg;
