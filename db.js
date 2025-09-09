// db.js
const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || null;

const poolConfig = connectionString
  ? {
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000
    }
  : {
      host: process.env.PGHOST || process.env.DB_HOST || '127.0.0.1',
      port: process.env.PGPORT ? Number(process.env.PGPORT) : Number(process.env.DB_PORT || 5432),
      user: process.env.PGUSER || process.env.DB_USER || 'postgres',
      password: process.env.PGPASSWORD || process.env.DB_PASS || '',
      database: process.env.PGDATABASE || process.env.DB_NAME || 'comftrip',
      max: 10,
      idleTimeoutMillis: 30000,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
    };

const pool = new Pool(poolConfig);

module.exports = pool;
