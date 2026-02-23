/**
 * PostgreSQL connection pool using pg.
 * Ideal for persistent, long-lived connections on VMs or containers.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');

const pool = new Pool(
    process.env.DATABASE_URL
        ? {
              connectionString: process.env.DATABASE_URL,
              ssl: { rejectUnauthorized: false },
          }
        : {
              host: process.env.DB_HOST,
              database: process.env.DB_NAME,
              user: process.env.DB_USER,
              port: Number(process.env.DB_PORT) || 5432,
              password: process.env.DB_PASSWORD,
              ssl: { rejectUnauthorized: false },
          }
);

pool.on('connect', () => {
    console.log('[db] New client connected to PostgreSQL');
});

pool.on('error', (err) => {
    console.error('[db] Unexpected error on idle PostgreSQL client', err);
});

/**
 * Run a parameterised query.
 * @param {string} text  - SQL statement
 * @param {any[]}  [params] - Bound parameters
 */
async function query(text, params) {
    const start = Date.now();
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log(`[db] query executed in ${duration}ms | rows: ${res.rowCount}`);
    return res;
}

/**
 * Acquire a client from the pool for multi-statement transactions.
 * Remember to call client.release() when done.
 */
async function getClient() {
    return pool.connect();
}

module.exports = { pool, query, getClient };
