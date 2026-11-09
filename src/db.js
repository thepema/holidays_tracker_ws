import dotenv from 'dotenv';
import pg from 'pg';

// ENV_FILE can point to the existing secret file (for example /opt/.env).
dotenv.config({ path: process.env.ENV_FILE || '.env' });

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionTimeoutMillis: 5000,
});

export default pool;
