

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || null;


function buildPoolFromConnectionString(connStr) {
  return new Pool({
    connectionString: connStr,
    // For many serverless environments + Supabase you want to allow the hosted SSL cert:
    ssl: { rejectUnauthorized: false },
    max: Number(process.env.DB_POOL_MAX) || 10,
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS) || 30000
  });
}

// build pool from separate PG* env vars
function buildPoolFromParts() {
  const host = process.env.PGHOST || process.env.DB_HOST || '127.0.0.1';
  const port = process.env.PGPORT ? Number(process.env.PGPORT) : (process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432);
  const user = process.env.PGUSER || process.env.DB_USER || 'postgres';
  const password = process.env.PGPASSWORD || process.env.DB_PASS || '';
  const database = process.env.PGDATABASE || process.env.DB_NAME || 'comftrip';

  const sslEnv = (process.env.DB_SSL || process.env.PGSSLMODE || '').toString().toLowerCase();
  const useSsl = sslEnv === 'true' || sslEnv === 'require' || sslEnv === '1';

  return new Pool({
    host,
    port,
    user,
    password,
    database,
    max: Number(process.env.DB_POOL_MAX) || 10,
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS) || 30000,
    ssl: useSsl ? { rejectUnauthorized: false } : false
  });
}

let pool;
if (connectionString) {
  pool = buildPoolFromConnectionString(connectionString);
} else {
  pool = buildPoolFromParts();
}

// lightweight connection check to surface DNS/auth/SSL errors early in logs.
// This does not throw (so your app can still start); it logs helpful info.
(async () => {
  try {
    // determine a host string to print (without revealing secrets)
    let hostInfo = 'unknown';
    try {
      if (connectionString) {
        const parsed = new URL(connectionString);
        hostInfo = `${parsed.hostname}:${parsed.port || '5432'}`;
      } else {
        hostInfo = `${process.env.PGHOST || process.env.DB_HOST || 'localhost'}:${process.env.PGPORT || process.env.DB_PORT || 5432}`;
      }
    } catch (e) {
      hostInfo = 'unknown';
    }

    // run a short, quick query
    // use a very small timeout via statement_timeout to avoid long hangs if needed (optional)
    const res = await pool.query({ text: 'SELECT now() as now', values: [], rowMode: 'array' });
    if (res && res.rows) {
      console.log(`[db] connected to database host=${hostInfo}`);
    }
  } catch (err) {
    console.error('[db] database connection check failed. Please verify your DATABASE_URL / PG* env vars.');
    if (err && err.code) console.error('[db] error code:', err.code);
    if (err && err.hostname) console.error('[db] hostname:', err.hostname);
    // print only the message - avoid logging credentials
    console.error('[db] full error:', err && err.message ? err.message : err);
    // do not re-throw so server can still start and surface errors on individual queries
  }
})();

module.exports = pool;
