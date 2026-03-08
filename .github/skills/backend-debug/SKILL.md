---
name: backend-debug
description: 'Debugging backend Node.js/Express. Usar cuando: diagnosticar errores de API, debugging de autenticación JWT/Keycloak, problemas de conexión a PostgreSQL/Redis, memory leaks, performance issues, o cualquier troubleshooting del servidor Express.'
---

# Backend Debugging

## Cuándo Usar

- Diagnosticar errores en endpoints de la API
- Debugging de autenticación JWT con Keycloak
- Problemas de conexión a bases de datos
- Memory leaks y performance issues
- Errores de middleware
- Problemas con uploads de archivos

## Arquitectura del Backend

```
app.js                    # Entry point, startup
├── routes.js             # Express Router
│   ├── /health           # Health check
│   ├── /connection-status # Estado WhatsApp
│   ├── /connect          # Iniciar conexión WA
│   ├── /send-message     # Envío individual
│   ├── /send-bulk        # Envío masivo
│   ├── /upload           # Upload archivos
│   └── /contacts         # CRUD contactos
├── auth.js               # JWT Middleware
├── manager.js            # WhatsAppManager
├── sessionManager.js     # Multi-sesión
└── queueRedis.js         # BullMQ
```

## Logging con Pino

```javascript
// logger.js - Configuración central
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty' }
    : undefined,
});

// ✅ Uso correcto
logger.info({ userId, action: 'connect' }, 'User connecting');
logger.error({ err, userId }, 'Connection failed');
logger.debug({ payload }, 'Request payload');

// ❌ Nunca usar
console.log('User connecting:', userId);
```

## Autenticación JWT

### Bypass en Desarrollo
```javascript
// routes.js
const conditionalAuth = (req, res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    // Mock user en desarrollo
    req.auth = {
      sub: 'dev-user-001',
      name: 'Usuario Desarrollo',
      email: 'dev@test.com'
    };
    return next();
  }
  return checkJwt(req, res, next);
};
```

### Verificar Token
```javascript
// auth.js
const { expressjwt: jwt } = require('express-jwt');
const jwksRsa = require('jwks-rsa');

const checkJwt = jwt({
  secret: jwksRsa.expressJwtSecret({
    cache: true,
    rateLimit: true,
    jwksUri: `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/certs`
  }),
  audience: process.env.KEYCLOAK_AUDIENCE,
  issuer: `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM}`,
  algorithms: ['RS256']
});
```

### Debug de Token
```bash
# Decodificar JWT (sin verificar firma)
echo $TOKEN | cut -d'.' -f2 | base64 -d | jq .

# Verificar issuer y audience
curl -s "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/.well-known/openid-configuration" | jq .
```

## Conexiones de Base de Datos

### PostgreSQL
```javascript
// postgresClient.js
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  port: process.env.POSTGRES_PORT,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  max: 10,
  idleTimeoutMillis: 30000,
});

// Debug de conexión
pool.on('error', (err) => {
  logger.error({ err }, 'PostgreSQL pool error');
});

pool.on('connect', () => {
  logger.debug('New PostgreSQL client connected');
});
```

### Redis
```javascript
// redisClient.js
const redis = getRedis();

// Verificar estado
if (!redis || redis.status === 'end') {
  throw new Error('Redis not connected');
}

// Debug de conexión
redis.on('error', (err) => logger.error({ err }, 'Redis error'));
redis.on('connect', () => logger.info('Redis connected'));
redis.on('ready', () => logger.info('Redis ready'));
```

## Debugging de Errores Comunes

### Error: "UnauthorizedError: jwt expired"
```javascript
// Token expirado, frontend debe refrescar
// Verificar tiempo de expiración en token
const decoded = jwt.decode(token);
console.log('Expira:', new Date(decoded.exp * 1000));
```

### Error: "ECONNREFUSED" a Redis/PostgreSQL
```bash
# Verificar que servicios estén corriendo
docker-compose ps

# Verificar conectividad
nc -zv localhost 6379   # Redis
nc -zv localhost 5432   # PostgreSQL

# Verificar env vars
printenv | grep -E 'REDIS|POSTGRES'
```

### Error: "PayloadTooLargeError"
```javascript
// app.js - Aumentar límite de body
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
```

### Error: "ENOMEM" o Memory Leak
```bash
# Ver uso de memoria del proceso
node --expose-gc -e "console.log(process.memoryUsage())"

# En Kubernetes
kubectl top pod -n sender

# Heapdump para análisis
NODE_OPTIONS="--heapsnapshot-signal=SIGUSR2" node app.js
kill -SIGUSR2 <pid>
```

## Debugging con Scripts

```bash
# Ver estado de la cola
node scripts/check-queue.js

# Ver logs de un job específico
node scripts/job-logs.js <jobId>

# Limpiar ownership de sesión
node scripts/clear-ownership.js <userId>

# Reset auth de Baileys
npm run reset-auth
```

## Request/Response Debugging

```javascript
// Middleware de logging para debug
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    logger.info({
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: Date.now() - start,
      userId: req.auth?.sub,
    }, 'Request completed');
  });
  
  next();
});
```

## Health Check

```javascript
// routes.js
router.get('/health', async (req, res) => {
  const checks = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    redis: false,
    postgres: false,
  };
  
  try {
    const redis = getRedis();
    await redis.ping();
    checks.redis = true;
  } catch (e) {
    checks.redis = false;
  }
  
  try {
    await pool.query('SELECT 1');
    checks.postgres = true;
  } catch (e) {
    checks.postgres = false;
  }
  
  const allOk = checks.redis && checks.postgres;
  res.status(allOk ? 200 : 503).json(checks);
});
```

## Archivos del Proyecto

- [app.js](../../app.js) - Entry point
- [routes.js](../../src/routes.js) - Endpoints
- [auth.js](../../src/auth.js) - JWT middleware
- [logger.js](../../src/logger.js) - Configuración Pino
- [config.js](../../src/config.js) - Variables de entorno
- [postgresClient.js](../../src/postgresClient.js) - Pool PostgreSQL
- [redisClient.js](../../src/redisClient.js) - Cliente Redis
