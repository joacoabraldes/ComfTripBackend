// test-pg.js
const { Pool } = require('pg');

const connectionString = 'postgresql://postgres:ComfTripPass123@db.zcpdiaszgdagixmceedz.supabase.co:5432/postgres';

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
    const r = await pool.query('SELECT NOW()');
    console.log('OK', r.rows);
    await pool.end();
  } catch (err) {
    console.error('ERR', err);
    process.exit(1);
  }
})();
