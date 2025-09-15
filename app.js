require('dotenv').config();
const logger = require('./src/logger');

// Configurar NODE_ENV para desarrollo si no está establecido
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'development';
  logger.info('NODE_ENV configurado como development');
}

const express = require('express');
const path = require('path');

const { retentionHours } = require('./src/config');
const { cleanupOldFiles } = require('./src/utils');
const { buildRoutes } = require('./src/routes');
const sessionManager = require('./src/sessionManager');
const { getRedis } = require('./src/redisClient');

const app = express();
const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';

// Si hay proxy/ingress con TLS, ayuda a detectar https correcto en req
app.set('trust proxy', 1);

// Archivos estáticos SIN auth (deja que el front haga login con Keycloak)
//app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public')));

// JSON parser
app.use(express.json());

// Rutas de API (buildRoutes ahora maneja las sesiones automáticamente)
app.use('/', buildRoutes());

// Raíz -> index.html (sin auth)
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health endpoints for Kubernetes
app.get('/health', async (_req, res) => {
  try {
    // simple liveness
    res.json({ status: 'ok', time: new Date().toISOString() });
  } catch {
    res.status(500).json({ status: 'error' });
  }
});

app.get('/ready', async (_req, res) => {
  try {
    const store = (process.env.SESSION_STORE || 'file').toLowerCase();
    if (store === 'redis') {
      const redis = getRedis();
      const status = redis?.status;
      // Consideramos ok mientras el cliente esté en estados transitorios comunes
      const acceptable = new Set(['ready', 'connecting', 'reconnecting', 'wait']);
      if (!acceptable.has(String(status))) {
        return res.status(503).json({ ready: false, store, redisStatus: status });
      }
    }
    res.json({ ready: true });
  } catch (e) {
    res.status(503).json({ ready: false, error: e?.message });
  }
});

// 404 opcional para otras rutas
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

// Start
app.listen(port, host, async () => {
  logger.info({ url: `http://${host}:${port}` }, 'Servidor multi-sesión escuchando');
  logger.info({ retentionHours }, 'Configuración de retención');

  cleanupOldFiles(retentionHours);
  setInterval(() => {
    logger.info('Limpieza automática programada...');
    cleanupOldFiles(retentionHours);
  }, 6 * 3600 * 1000);

  // Programar limpieza de sesiones inactivas cada 4 horas
  setInterval(() => {
    logger.info('Limpieza de sesiones inactivas...');
    sessionManager.cleanupInactiveSessions(24); // 24 horas
  }, 4 * 3600 * 1000);

  logger.info('Sistema multi-sesión WhatsApp inicializado correctamente');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('Recibido SIGTERM, cerrando servidor...');
  setTimeout(() => process.exit(0), 500);
});
process.on('SIGINT', () => {
  logger.info('Recibido SIGINT, cerrando servidor...');
  setTimeout(() => process.exit(0), 500);
});
