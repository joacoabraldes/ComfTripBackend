// db.js
// PostgreSQL pool that supports either a full DATABASE_URL (recommended for Supabase)
// or individual PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT env vars.
// Enables SSL for hosted DBs (Supabase requires SSL).
//
// Usage: const pool = require('./db');
// then use pool.query(...) everywhere like before.

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || null;

function buildPoolFromConnectionString(connStr) {
  // Use ssl with rejectUnauthorized=false for serverless environments (Supabase)
  const pool = new Pool({
    connectionString: connStr,
    max: Number(process.env.DB_POOL_MAX) || 10,
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS) || 30000,
    // When using a hosted postgres (supabase), enable SSL. We set rejectUnauthorized:false
    // because many serverless environments can't verify the cert chain.
    ssl: { rejectUnauthorized: false }
  });
  return pool;
}

function buildPoolFromParts() {
  const host = process.env.PGHOST || process.env.DB_HOST || '127.0.0.1';
  const port = process.env.PGPORT ? Number(process.env.PGPORT) : (process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432);
  const user = process.env.PGUSER || process.env.DB_USER || 'postgres';
  const password = process.env.PGPASSWORD || process.env.DB_PASS || '';
  const database = process.env.PGDATABASE || process.env.DB_NAME || 'comftrip';

  const sslEnv = (process.env.DB_SSL || process.env.PGSSLMODE || '').toLowerCase();
  // treat "true", "require", "1" as SSL enabled
  const useSsl = sslEnv === 'true' || sslEnv === 'require' || sslEnv === '1';

  const pool = new Pool({
    host,
    port,
    user,
    password,
    database,
    max: Number(process.env.DB_POOL_MAX) || 10,
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS) || 30000,
    ssl: useSsl ? { rejectUnauthorized: false } : false
  });

  return pool;
}

let pool;
if (connectionString) {
  pool = buildPoolFromConnectionString(connectionString);
} else {
  pool = buildPoolFromParts();
}

// Optional lightweight connection check to surface DNS/SSL errors early in logs.
// It does a single simple query and will log a helpful message on failure.
(async () => {
  try {
    // Get an informative "host" for logs without printing secrets
    let hostInfo = 'unknown host';
    try {
      if (connectionString) {
        const parsed = new URL(connectionString);
        hostInfo = `${parsed.hostname}:${parsed.port || '5432'}`;
      } else {
        hostInfo = `${process.env.PGHOST || process.env.DB_HOST || 'localhost'}:${process.env.PGPORT || process.env.DB_PORT || 5432}`;
      }
    } catch (e) {
      hostInfo = 'unknown host';
    }

    // run a very short query with a short statement_timeout (works in pg via query)
    const res = await pool.query({ text: 'SELECT now() as now', rowMode: 'array' });
    // success: useful for debugging during startup
    // Note: don't print credentials in logs.
    // (This log helps you know the DB host that was attempted.)
    // In production you may want to remove this log or set NODE_ENV check.
    if (res && res.rows) {
      // don't print the whole row to avoid potential timestamp formatting differences
      console.log(`[db] connected to database host=${hostInfo}`);
    }
  } catch (err) {
    // Common causes:
    // - ENOTFOUND -> DNS problem / wrong host name
    // - authentication error -> wrong user/password
    // - SSL error -> ssl required/disabled mismatch
    console.error('[db] database connection check failed. Please verify your DATABASE_URL / PG* env vars.');
    // show the friendly error and host for easier debugging (no secrets)
    if (err && err.code) {
      console.error('[db] error code:', err.code);
    }
    if (err && err.hostname) {
      console.error('[db] hostname:', err.hostname);
    }
    console.error('[db] full error:', err && err.message ? err.message : err);
    // do not throw here - letting the app try to handle query errors later.
  }
})();

module.exports = pool;
