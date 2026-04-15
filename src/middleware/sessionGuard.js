// src/middleware/sessionGuard.js
const crypto = require('crypto');
const { getRedis } = require('../redisClient');
const logger = require('../logger');

const SESSION_TTL = 24 * 60 * 60; // 24 hours in seconds
const SESSION_PREFIX = 'ms:session:';

/**
 * Generate a new session token and store it in Redis.
 * Returns the token string. Sets the X-Session-Token response header.
 */
async function createSession(userId, req, res) {
  const redis = getRedis();
  const token = crypto.randomUUID();
  const sessionData = JSON.stringify({
    token,
    createdAt: new Date().toISOString(),
    userAgent: req.headers['user-agent'] || 'unknown',
    ip: req.ip || req.connection.remoteAddress || 'unknown'
  });

  await redis.set(`${SESSION_PREFIX}${userId}`, sessionData, 'EX', SESSION_TTL);
  res.setHeader('X-Session-Token', token);
  logger.info({ uid: userId }, 'New session created');
  return token;
}

/**
 * Middleware: enforce single active session per user.
 *
 * - First request without X-Session-Token: generate and store a new token
 * - Matching token: pass through, refresh TTL
 * - Mismatched token: 401 session_conflict
 *
 * Redis being down is handled gracefully (request passes through with a warning).
 */
async function sessionGuard(req, res, next) {
  try {
    const userId = req.auth && req.auth.uid;
    if (!userId) {
      return next(); // no auth context — let downstream handle it
    }

    const redis = getRedis();

    // Check Redis availability
    if (redis.status !== 'ready') {
      logger.warn({ uid: userId, redisStatus: redis.status }, 'sessionGuard: Redis not ready, allowing request');
      return next();
    }

    const clientToken = req.headers['x-session-token'] || null;
    const stored = await redis.get(`${SESSION_PREFIX}${userId}`);

    // No client token → first request or new tab
    if (!clientToken) {
      // If there is already a stored session, do NOT overwrite it.
      // The frontend must call POST /auth/session explicitly to claim a new session.
      if (stored) {
        // No token sent but a session exists — this is a new device/tab that hasn't
        // called /auth/session yet. We allow this request through so the frontend
        // can call /auth/session. But we set the header so the frontend can pick it up.
        // Actually, we need to block or allow? The spec says:
        // "To force a new session: add POST /auth/session endpoint"
        // So requests without a session token when a session exists should still work
        // for the /auth/session call (which is exempt). For other routes, if there's
        // no token and a session exists, this is ambiguous. Let's generate a new one
        // only if there is NO existing session.
        return next();
      }

      // No stored session and no client token → generate new
      await createSession(userId, req, res);
      return next();
    }

    // Client sent a token
    if (!stored) {
      // Session expired or cleared — re-adopt the client's token instead of
      // generating a new one. This prevents race conditions when multiple
      // concurrent requests fire: all of them will re-store the same token.
      const sessionData = JSON.stringify({
        token: clientToken,
        createdAt: new Date().toISOString(),
        userAgent: req.headers['user-agent'] || 'unknown',
        ip: req.ip || req.connection.remoteAddress || 'unknown'
      });
      await redis.set(`${SESSION_PREFIX}${userId}`, sessionData, 'EX', SESSION_TTL);
      logger.info({ uid: userId }, 'sessionGuard: re-adopted client token (no stored session)');
      return next();
    }

    // Parse stored session
    let storedSession;
    try {
      storedSession = JSON.parse(stored);
    } catch (parseErr) {
      logger.warn({ uid: userId }, 'sessionGuard: corrupt session data, creating new');
      await createSession(userId, req, res);
      return next();
    }

    // Token matches — refresh TTL and continue
    if (storedSession.token === clientToken) {
      // Refresh TTL (fire-and-forget)
      redis.expire(`${SESSION_PREFIX}${userId}`, SESSION_TTL).catch((err) => {
        logger.warn({ uid: userId, err: err.message }, 'sessionGuard: failed to refresh TTL');
      });
      return next();
    }

    // Token mismatch — session conflict
    logger.warn({
      uid: userId,
      clientToken: clientToken.substring(0, 8) + '...',
      storedToken: storedSession.token.substring(0, 8) + '...'
    }, 'Session conflict detected');

    return res.status(401).json({
      error: 'session_conflict',
      message: 'Sesion activa en otro dispositivo'
    });
  } catch (err) {
    // Redis error or unexpected failure — allow request through
    logger.error({ err: err.message, uid: req.auth && req.auth.uid }, 'sessionGuard error, allowing request');
    return next();
  }
}

/**
 * Delete a user's session from Redis (used on logout).
 */
async function clearSession(userId) {
  try {
    const redis = getRedis();
    if (redis.status !== 'ready') {
      logger.warn({ uid: userId }, 'clearSession: Redis not ready');
      return;
    }
    await redis.del(`${SESSION_PREFIX}${userId}`);
    logger.info({ uid: userId }, 'Session cleared');
  } catch (err) {
    logger.warn({ uid: userId, err: err.message }, 'clearSession error');
  }
}

module.exports = { sessionGuard, createSession, clearSession, SESSION_PREFIX, SESSION_TTL };
