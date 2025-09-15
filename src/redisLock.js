const { randomUUID } = require('crypto');
const { getRedis } = require('./redisClient');
const logger = require('./logger');

async function acquireLock(key, ttlSeconds = 30, options = {}) {
  const redis = getRedis();
  const token = randomUUID();
  const start = Date.now();
  const timeoutMs = options.timeoutMs || 15000;
  const retryDelayMs = options.retryDelayMs || 200;

  while (Date.now() - start < timeoutMs) {
    const ok = await redis.set(key, token, 'NX', 'EX', ttlSeconds);
    if (ok === 'OK') {
      const unlock = async () => {
        try {
          const lua = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
          await redis.eval(lua, 1, key, token);
        } catch (e) {
          logger.warn({ err: e?.message }, 'Redis unlock error');
        }
      };
      return { token, unlock };
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }

  throw new Error('Timeout acquiring Redis lock');
}

async function withUserLock(userId, task, ttlSeconds = 30, options = {}) {
  const lockKey = `wa:lock:connect:${userId}`;
  const { unlock } = await acquireLock(lockKey, ttlSeconds, options);
  try {
    return await task();
  } finally {
    await unlock();
  }
}

module.exports = { acquireLock, withUserLock };

