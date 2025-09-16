// src/auth.js
require('dotenv').config();
const logger = require('./logger');
const { getAuthState } = require('./auth/index');

/* ──────────────────────────────────────────────────────────────────────────
 * Asegurar WebCrypto (necesario para 'jose' en Node 18 dentro de Docker)
 * ────────────────────────────────────────────────────────────────────────── */
try {
  if (!globalThis.crypto) {
    const { webcrypto } = require('node:crypto');
    globalThis.crypto = webcrypto;
  }
} catch (e) {
  // Último recurso (no debería hacer falta)
  (async () => {
    try {
      const { webcrypto } = await import('node:crypto');
      if (!globalThis.crypto) globalThis.crypto = webcrypto;
    } catch (err) {
      logger.error({ err: err?.message }, 'No se pudo inicializar WebCrypto');
    }
  })();
}

/* ──────────────────────────────────────────────────────────────────────────
 * Carga dinámica de 'jose' (ESM) y JWKS remoto con caché
 * ────────────────────────────────────────────────────────────────────────── */
let _joseMod = null;   // cache del módulo jose
let _jwks = null;      // cache del RemoteJWKSet

async function jose() {
  if (!_joseMod) {
    _joseMod = await import('jose').catch((err) => {
      logger.error({ err: err?.message }, 'Error importando jose');
      throw err;
    });
  }
  return _joseMod;
}

async function getJWKS(jwksUri) {
  if (!_jwks) {
    const { createRemoteJWKSet } = await jose();
    _jwks = createRemoteJWKSet(new URL(jwksUri)); // incluye caché y rate-limit
  }
  return _jwks;
}

/* ──────────────────────────────────────────────────────────────────────────
 * ENV y endpoints OIDC
 * ────────────────────────────────────────────────────────────────────────── */
const {
  KEYCLOAK_URL,      // p.ej.: https://kc.mindtechpy.net
  KEYCLOAK_REALM,    // p.ej.: message-sender
  KEYCLOAK_AUDIENCE, // p.ej.: message-sender-api (clientId de tu API)
  KEYCLOAK_ISSUER,   // opcional (override)
  KEYCLOAK_JWKS_URI  // opcional (override)
} = process.env;

if (!KEYCLOAK_URL || !KEYCLOAK_REALM || !KEYCLOAK_AUDIENCE) {
  throw new Error('Faltan variables de entorno: KEYCLOAK_URL, KEYCLOAK_REALM, KEYCLOAK_AUDIENCE');
}

const ISSUER = KEYCLOAK_ISSUER || `${KEYCLOAK_URL.replace(/\/+$/, '')}/realms/${KEYCLOAK_REALM}`;
const JWKS_URI = KEYCLOAK_JWKS_URI || `${ISSUER}/protocol/openid-connect/certs`;

/* ──────────────────────────────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────────────────────────────── */
function getBearerToken(req) {
  const header = req.headers['authorization'] || req.headers['Authorization'];
  if (!header) return null;
  const [type, token] = header.split(' ');
  if (type !== 'Bearer' || !token) return null;
  return token;
}

function extractRoles(payload, clientId) {
  const realmRoles  = payload?.realm_access?.roles || [];
  const clientRoles = payload?.resource_access?.[clientId]?.roles || [];
  return {
    realmRoles:  Array.isArray(realmRoles)  ? realmRoles  : [],
    clientRoles: Array.isArray(clientRoles) ? clientRoles : [],
    all: Array.from(new Set([...(realmRoles || []), ...(clientRoles || [])])),
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Middlewares
 * ────────────────────────────────────────────────────────────────────────── */
async function checkJwt(req, res, next) {
  try {
    const token = getBearerToken(req);
    
    if (!token) {
      logger.warn('Missing Bearer token in request', {
        url: req.url,
        method: req.method,
        headers: Object.keys(req.headers),
        authHeader: req.headers['authorization'] ? 'present' : 'missing'
      });
      return res.status(401).json({ error: 'Missing Bearer token' });
    }

    logger.info('Verificando JWT token', {
      url: req.url,
      tokenLength: token.length,
      issuer: ISSUER,
      audience: KEYCLOAK_AUDIENCE
    });

    const { jwtVerify } = await jose();
    const jwks = await getJWKS(JWKS_URI);

    const { payload } = await jwtVerify(token, jwks, {
      issuer: ISSUER,
      audience: KEYCLOAK_AUDIENCE,
      algorithms: ['RS256'],
      clockTolerance: 10, // segundos de tolerancia de reloj
    });

    logger.info('JWT verification successful', {
      userId: payload.sub,
      userName: payload.name || payload.preferred_username,
      email: payload.email,
      audience: payload.aud,
      expires: new Date(payload.exp * 1000).toISOString()
    });

    req.token = token;
    req.auth = payload;
    req.userRoles = extractRoles(payload, KEYCLOAK_AUDIENCE);
    return next();
  } catch (err) {
    logger.warn({ 
      err: err?.message,
      url: req.url,
      issuer: ISSUER,
      audience: KEYCLOAK_AUDIENCE,
      jwksUri: JWKS_URI
    }, 'JWT verification failed');
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(role, opts = {}) {
  const where = opts.in || 'either'; // 'realm' | 'client' | 'either'
  return (req, res, next) => {
    try {
      if (!req.auth || !req.userRoles) {
        return res.status(401).json({ error: 'Unauthenticated' });
      }
      const { realmRoles, clientRoles, all } = req.userRoles;

      const has =
        (where === 'realm'  && realmRoles.includes(role)) ||
        (where === 'client' && clientRoles.includes(role)) ||
        (where === 'either' && all.includes(role));

      if (!has) {
        logger.info({ sub: req.auth?.sub, role, where, realmRoles, clientRoles }, 'Forbidden: missing role');
        return res.status(403).json({ error: 'Forbidden: missing role' });
      }
      return next();
    } catch (err) {
      logger.error({ err: err?.message }, 'Error in requireRole');
      return res.status(500).json({ error: 'Authorization middleware error' });
    }
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Exports
 * ────────────────────────────────────────────────────────────────────────── */
module.exports = {
  checkJwt,
  requireRole,
  extractRoles,
  ISSUER,
  JWKS_URI,
  getAuthState,
};
