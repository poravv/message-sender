const { proto, initAuthCreds } = require('@whiskeysockets/baileys');
const { getRedis } = require('../redisClient');
const logger = require('../logger');

function getTTL() {
  const ttl = Number(process.env.REDIS_TTL_SECONDS || 60 * 60 * 12); // 12h por defecto
  return ttl > 0 ? ttl : 60 * 60 * 24 * 30;
}

function getQRTTL() {
  const ttl = Number(process.env.REDIS_QR_TTL_SECONDS || 180); // 3m
  return ttl > 0 ? ttl : 180;
}

function baseKey(userId) {
  return `wa:auth:${userId}`;
}

function credsKey(userId) {
  return `${baseKey(userId)}:creds`;
}

function keyItem(userId, type, id) {
  return `${baseKey(userId)}:keys:${type}:${id}`;
}

function qrKey(userId) {
  return `${baseKey(userId)}:qr`;
}

async function useRedisAuthState(userId) {
  const redis = getRedis();
  const ttl = getTTL();

  const replacer = (_key, value) => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return { type: 'Buffer', data: Array.from(value) };
    }
    return value;
  };

  const reviver = (type) => (_key, value) => {
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
      return Buffer.from(value.data);
    }
    return value;
  };

  function serialize(value) {
    return JSON.stringify(value, replacer);
  }

  function deserialize(raw, type) {
    if (!raw) return raw;
    let parsed;
    try {
      parsed = JSON.parse(raw, reviver(type));
    } catch {
      return raw;
    }
    if (type === 'app-state-sync-key' && parsed) {
      return proto.Message.AppStateSyncKeyData.fromObject(parsed);
    }
    return parsed;
  }

  // Ensure connection
  if (!redis.status || redis.status === 'end') {
    await redis.connect();
  }

  // Load creds or init
  let creds;
  try {
    const data = await redis.get(credsKey(userId));
    creds = data ? JSON.parse(data, reviver()) : null;
  } catch (e) {
    logger.warn({ err: e?.message }, 'Redis: error loading creds');
  }

  if (!creds) {
    creds = initAuthCreds();
    logger.info({ userId }, 'Redis: iniciando nuevas credenciales');
  }

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const pipeline = redis.pipeline();
        const keys = ids.map((id) => keyItem(userId, type, id));
        keys.forEach((k) => pipeline.get(k));
        const res = await pipeline.exec();
        const out = {};
        ids.forEach((id, idx) => {
          const [err, val] = res[idx] || [];
          if (!err && val) {
            out[id] = deserialize(val, type);
          } else {
            out[id] = undefined;
          }
        });
        return out;
      },
      set: async (data) => {
        const pipeline = redis.pipeline();
        const expireAt = ttl;
        for (const category in data) {
          for (const id in data[category]) {
            const value = data[category][id];
            const k = keyItem(userId, category, id);
            if (value) {
              pipeline.set(k, serialize(value));
              pipeline.expire(k, expireAt);
            } else {
              pipeline.del(k);
            }
          }
        }
        // touch main creds key to extend TTL if exists
        pipeline.expire(credsKey(userId), expireAt);
        await pipeline.exec();
      },
    },
  };

  async function saveCreds() {
    try {
      await redis.set(credsKey(userId), JSON.stringify(state.creds, replacer));
      await redis.expire(credsKey(userId), ttl);
    } catch (e) {
      logger.error({ err: e?.message }, 'Redis: error saving creds');
    }
  }

  async function clear() {
    const pattern = `${baseKey(userId)}:*`;
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys && keys.length) {
        await redis.del(keys);
      }
    } while (cursor !== '0');
  }

  return { state, saveCreds, clear };
}

async function setUserQr(userId, qrText) {
  const redis = getRedis();
  const ttl = getQRTTL();
  try {
    await redis.set(qrKey(userId), qrText, 'EX', ttl);
  } catch (e) {
    // non-fatal
  }
}

async function getUserQr(userId) {
  const redis = getRedis();
  try {
    return await redis.get(qrKey(userId));
  } catch {
    return null;
  }
}

async function deleteUserQr(userId) {
  const redis = getRedis();
  try {
    await redis.del(qrKey(userId));
  } catch {
    /* noop */
  }
}

module.exports = {
  useRedisAuthState,
  setUserQr,
  getUserQr,
  deleteUserQr,
};
