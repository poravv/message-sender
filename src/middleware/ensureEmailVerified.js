// src/middleware/ensureEmailVerified.js
const logger = require('../logger');

/**
 * Middleware: block users whose email is not verified.
 * Runs after checkJwt (which sets req.auth).
 * Must run BEFORE checkTrial in the middleware chain.
 *
 * Google sign-in users are auto-verified by Google, so we skip the check
 * when the Firebase token's sign_in_provider is 'google.com'.
 *
 * The raw Firebase decoded token (from verifyIdToken) includes:
 *   decoded.firebase.sign_in_provider  → 'password' | 'google.com' | ...
 *   decoded.email_verified             → boolean
 *
 * checkJwt already sets req.auth.email_verified from the token.
 * We also need the provider, so checkJwt must set req.auth.sign_in_provider.
 */
function ensureEmailVerified(req, res, next) {
  try {
    if (!req.auth) {
      return res.status(401).json({ error: 'Unauthenticated' });
    }

    const provider = req.auth.sign_in_provider || 'password';

    // Google users are inherently verified
    if (provider === 'google.com') {
      return next();
    }

    // Check email_verified
    if (req.auth.email_verified === false) {
      logger.info(
        { uid: req.auth.uid, email: req.auth.email },
        'Blocked request: email not verified'
      );
      return res.status(403).json({
        error: 'email_not_verified',
        message: 'Debes verificar tu correo electrónico'
      });
    }

    return next();
  } catch (err) {
    logger.error({ err: err.message, uid: req.auth && req.auth.uid }, 'ensureEmailVerified error');
    return next();
  }
}

module.exports = { ensureEmailVerified };
