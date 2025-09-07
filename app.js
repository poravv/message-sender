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

const app = express();
const port = process.env.PORT || 3009;

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

// 404 opcional para otras rutas
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

// Start
app.listen(port, async () => {
  logger.info({ url: `http://localhost:${port}` }, 'Servidor multi-sesión escuchando');
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