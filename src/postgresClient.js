/**
 * PostgreSQL Client - Connection Pool Manager
 */
const { Pool } = require('pg');
const logger = require('./logger');

let pool = null;

function getPool() {
  if (pool) return pool;

  const config = {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'sender',
    password: process.env.POSTGRES_PASSWORD || 'changeme',
    database: process.env.POSTGRES_DB || 'sender_db',
    max: parseInt(process.env.POSTGRES_POOL_SIZE || '10', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };

  pool = new Pool(config);

  pool.on('error', (err) => {
    logger.error({ err }, 'PostgreSQL pool error');
  });

  pool.on('connect', () => {
    logger.debug('PostgreSQL client connected');
  });

  return pool;
}

// Connection-level errors that warrant a retry with a fresh pool
const RETRYABLE_ERRORS = [
  'Connection terminated',
  'Connection is closed',
  'connection is closed',
  'Client has encountered a connection error',
  'terminating connection due to administrator command',
  'server closed the connection unexpectedly',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
];

function isRetryableError(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  const code = String(err.code || '');
  return RETRYABLE_ERRORS.some(e => msg.includes(e)) ||
         code === '57P01' || // admin shutdown
         code === '57P03' || // cannot connect now
         code === 'ECONNREFUSED' ||
         code === 'ECONNRESET';
}

async function query(text, params) {
  const start = Date.now();
  const p = getPool();
  try {
    const result = await p.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn({ duration, query: text.slice(0, 100) }, 'Slow PostgreSQL query');
    }
    return result;
  } catch (err) {
    if (isRetryableError(err)) {
      logger.warn({ err: err.message, query: text.slice(0, 100) }, 'PostgreSQL connection error, retrying with fresh pool');
      // Destroy the stale pool and create a fresh one
      try { await pool.end(); } catch { /* ignore */ }
      pool = null;
      // Retry once with fresh pool
      const freshPool = getPool();
      const result = await freshPool.query(text, params);
      const duration = Date.now() - start;
      logger.info({ duration, query: text.slice(0, 100) }, 'PostgreSQL retry succeeded');
      return result;
    }
    logger.error({ err, query: text.slice(0, 200) }, 'PostgreSQL query error');
    throw err;
  }
}

async function getClient() {
  return getPool().connect();
}

async function transaction(callback) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function healthCheck() {
  try {
    const result = await query('SELECT NOW() as now');
    return { healthy: true, timestamp: result.rows[0].now };
  } catch (err) {
    return { healthy: false, error: err.message };
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('PostgreSQL pool closed');
  }
}

module.exports = {
  getPool,
  query,
  getClient,
  transaction,
  healthCheck,
  closePool,
};
