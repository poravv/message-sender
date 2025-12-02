#!/usr/bin/env node
require('dotenv').config();

const logger = require('../src/logger');
const { getRedis } = require('../src/redisClient');

async function deleteKeys(redis, pattern) {
  let cursor = '0';
  let removed = 0;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = nextCursor;
    if (keys && keys.length) {
      await redis.del(keys);
      removed += keys.length;
    }
  } while (cursor !== '0');

  return removed;
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: npm run reset-auth -- <user-id|all>');
    process.exit(1);
  }

  const redis = getRedis();
  if (!redis.status || redis.status === 'end') {
    logger.info('Conectando a Redis para limpiar estado...');
    await redis.connect();
  }

  // Limpiar tanto auth como ownership
  const patterns = target === 'all' 
    ? ['wa:auth:*', 'wa:owner:*'] 
    : [`wa:auth:${target}:*`, `wa:owner:${target}`];
  
  let totalDeleted = 0;
  for (const pattern of patterns) {
    logger.info({ pattern }, 'Eliminando estado en Redis');
    const deleted = await deleteKeys(redis, pattern);
    totalDeleted += deleted;
    logger.info({ pattern, deleted }, 'Entradas eliminadas');
  }

  logger.info({ totalDeleted }, 'Total de entradas eliminadas en Redis');

  try {
    await redis.quit();
  } catch {}

  logger.info('Limpieza completada');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: err?.message }, 'Error limpiando credenciales en Redis');
  process.exit(1);
});
