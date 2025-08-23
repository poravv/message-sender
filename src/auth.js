// src/auth.js
require('dotenv').config();
const logger = require('./logger');

// ======== ENV ========
const {
  KEYCLOAK_URL,              // p.ej.: https://kc.mindtechpy.net
  KEYCLOAK_REALM,            // p.ej.: message-sender
  KEYCLOAK_AUDIENCE,         // p.ej.: message-sender-api (clientId API)
  KEYCLOAK_ISSUER,           // opcional
  KEYCLOAK_JWKS_URI          // opcional
} = process.env;

if (!KEYCLOAK_URL || !KEYCLOAK_REALM || !KEYCLOAK_AUDIENCE) {
  throw new Error('Faltan variables de entorno: KEYCLOAK_URL, KEYCLOAK_REALM, KEYCLOAK_AUDIENCE');
}

const ISSUER = KEYCLOAK_ISSUER || `${KEYCLOAK_URL.replace(/\/+$/, '')}/realms/${KEYCLOAK_REALM}`;
const JWKS_URI = KEYCLOAK_JWKS_URI || `${ISSUER}/protocol/openid-connect/certs`;

// ======== jose (ESM) carga perezosa y cache ========
let _joseMod = null;     // módulo jose
let _jwksGetter = null;  // resultado de createRemoteJWKSet(new URL(JWKS_URI))

async function jose() {
  if (!_joseMod) _joseMod = await import('jose'); // ESM dynamic import compatible con CJS
  return _joseMod;
}
async function getJWKS() {
  if (!_jwksGetter) {
    const { createRemoteJWKSet } = await jose();
    _jwksGetter = createRemoteJWKSet(new URL(JWKS_URI)); // incluye caché y rate limit interno
  }
  return _jwksGetter;
}

/**
 * Extrae Bearer token del header Authorization
 */
function getBearerToken(req) {
  const header = req.headers['authorization'] || req.headers['Authorization'];
  if (!header) return null;
  const [type, token] = header.split(' ');
  if (type !== 'Bearer' || !token) return null;
  return token;
}

/**
 * Normaliza roles de token Keycloak
 * - realm_access.roles: roles a nivel realm
 * - resource_access[clientId].roles: roles a nivel cliente
 */
function extractRoles(payload, clientId) {
  const realmRoles = payload?.realm_access?.roles || [];
  const clientRoles = payload?.resource_access?.[clientId]?.roles || [];
  return {
    realmRoles: Array.isArray(realmRoles) ? realmRoles : [],
    clientRoles: Array.isArray(clientRoles) ? clientRoles : [],
    all: Array.from(new Set([...(realmRoles || []), ...(clientRoles || [])]))
  };
}

/**
 * Middleware: verifica JWT (firma, issuer, audience, exp)
 * Adjunta req.auth y req.userRoles
 */
async function checkJwt(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: 'Missing Bearer token' });

    const { jwtVerify } = await jose();
    const JWKS = await getJWKS();

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: KEYCLOAK_AUDIENCE,
      algorithms: ['RS256']
    });

    req.token = token;
    req.auth = payload;
    req.userRoles = extractRoles(payload, KEYCLOAK_AUDIENCE);
    return next();
  } catch (err) {
    logger.warn({ err: err?.message }, 'JWT verification failed');
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Middleware de autorización por rol
 */
function requireRole(role, opts = {}) {
  const where = opts.in || 'either'; // realm | client | either
  return (req, res, next) => {
    try {
      if (!req.auth || !req.userRoles) {
        return res.status(401).json({ error: 'Unauthenticated' });
      }
      const { realmRoles, clientRoles, all } = req.userRoles;

      const has =
        (where === 'realm' && realmRoles.includes(role)) ||
        (where === 'client' && clientRoles.includes(role)) ||
        (where === 'either' && all.includes(role));

      if (!has) {
        logger.info(
          { sub: req.auth?.sub, role, where, realmRoles, clientRoles },
          'Forbidden: missing role'
        );
        return res.status(403).json({ error: 'Forbidden: missing role' });
      }
      return next();
    } catch (err) {
      logger.error({ err: err?.message }, 'Error in requireRole');
      return res.status(500).json({ error: 'Authorization middleware error' });
    }
  };
}

module.exports = {
  checkJwt,
  requireRole,
  extractRoles,
  ISSUER,
  JWKS_URI
};