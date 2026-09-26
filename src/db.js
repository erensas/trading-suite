// PostgreSQL pool for trade_db (Unix socket, peer auth in production).
// Limits: at most `max` connections, 5 s to get one, and every statement is cancelled by
// the server after statementTimeoutMs, so a slow query cannot hold a connection forever.
const { Pool } = require('pg');

const UNDEFINED_TABLE = '42P01';
const UNIQUE_VIOLATION = '23505';

function createPool(cfg, log) {
  const pool = new Pool({
    ...(cfg.connectionString
      ? { connectionString: cfg.connectionString }
      : { database: cfg.database, user: cfg.user, host: cfg.host, password: cfg.password, port: cfg.port }),
    max: cfg.max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: cfg.statementTimeoutMs,
    query_timeout: cfg.statementTimeoutMs + 2000,
    idle_in_transaction_session_timeout: 30000,
    application_name: 'trading-suite',
  });
  pool.on('error', (err) => log.error({ err }, 'postgres pool error'));
  return pool;
}

// Runs fn(client) in a transaction.
async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Swallows "table does not exist" (a migration not applied yet) and returns fallback.
async function ifInstalled(promise, fallback) {
  try {
    return await promise;
  } catch (e) {
    if (e.code === UNDEFINED_TABLE) return fallback;
    throw e;
  }
}

module.exports = { createPool, withTransaction, ifInstalled, UNDEFINED_TABLE, UNIQUE_VIOLATION };
