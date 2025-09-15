const { useMultiFileAuthState } = require('@whiskeysockets/baileys');

async function getAuthState(userId, authDir) {
  const store = (process.env.SESSION_STORE || 'file').toLowerCase();

  if (store === 'redis') {
    const { useRedisAuthState } = require('../stores/redisAuthState');
    return useRedisAuthState(userId);
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const clear = async () => { /* file cleanup handled in manager */ };
  return { state, saveCreds, clear };
}

module.exports = { getAuthState };
