const Redis = require('ioredis');
const logger = require('./logger');

let client = null;

function buildRedisOptions() {
  const {
    REDIS_URL,
    REDIS_HOST = '127.0.0.1',
    REDIS_PORT = '6379',
    REDIS_PASSWORD,
    REDIS_DB,
    REDIS_TLS,
    REDIS_TLS_REJECT_UNAUTHORIZED,
  } = process.env;

  if (REDIS_URL) {
    // Prefer URL if provided (supports rediss:// and query params)
    return REDIS_URL;
  }

  const port = Number(REDIS_PORT) || 6379;
  const opts = {
    host: REDIS_HOST,
    port,
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  };

  if (REDIS_PASSWORD) opts.password = REDIS_PASSWORD;
  if (REDIS_DB) opts.db = Number(REDIS_DB);
  if (String(REDIS_TLS).toLowerCase() === 'true') {
    const rejectUnauthorized = String(REDIS_TLS_REJECT_UNAUTHORIZED || 'true').toLowerCase() === 'true';
    opts.tls = { rejectUnauthorized };
  }

  return opts;
}

function getRedis() {
  if (!client) {
    const options = buildRedisOptions();
    client = new Redis(options);

    client.on('connect', () => logger.info('Redis: connecting...'));
    client.on('ready', () => logger.info('Redis: ready'));
    client.on('error', (err) => logger.error({ err: err?.message }, 'Redis error'));
    client.on('end', () => logger.warn('Redis: connection closed'));
  }
  return client;
}

module.exports = { getRedis };
