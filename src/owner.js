const os = require('os');
const { getRedis } = require('./redisClient');

function getPodId() {
  return process.env.POD_ID || os.hostname();
}

function ownerKey(userId) {
  return `wa:owner:${userId}`;
}

function getOwnerTtl() {
  const ttl = Number(process.env.REDIS_OWNER_TTL_SECONDS || 60);
  return Math.max(15, ttl);
}

async function getOwner(userId) {
  const r = getRedis();
  try {
    return await r.get(ownerKey(userId));
  } catch {
    return null;
  }
}

async function acquireOwner(userId, ttlSec = getOwnerTtl()) {
  const r = getRedis();
  const podId = getPodId();
  const ok = await r.set(ownerKey(userId), podId, 'NX', 'EX', ttlSec);
  return ok === 'OK';
}

async function renewOwner(userId, ttlSec = getOwnerTtl()) {
  const r = getRedis();
  const podId = getPodId();
  const lua = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end`;
  try {
    const res = await r.eval(lua, 1, ownerKey(userId), podId, String(ttlSec));
    return res === 1;
  } catch {
    return false;
  }
}

async function releaseOwner(userId) {
  const r = getRedis();
  const podId = getPodId();
  const lua = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
  try {
    await r.eval(lua, 1, ownerKey(userId), podId);
  } catch {}
}

async function isOwner(userId) {
  const current = await getOwner(userId);
  return current === getPodId();
}

async function tryEnsureOwnership(userId, ttlSec = getOwnerTtl()) {
  if (await isOwner(userId)) return true;
  const current = await getOwner(userId);
  if (!current) {
    return await acquireOwner(userId, ttlSec);
  }
  return false;
}

module.exports = {
  getPodId,
  ownerKey,
  getOwner,
  acquireOwner,
  renewOwner,
  releaseOwner,
  isOwner,
  tryEnsureOwnership,
  getOwnerTtl,
};

