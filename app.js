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
const { WhatsAppManager } = require('./src/manager');
const { buildRoutes } = require('./src/routes');

const app = express();
const port = process.env.PORT || 3010;

// Si hay proxy/ingress con TLS, ayuda a detectar https correcto en req
app.set('trust proxy', 1);

// Archivos estáticos SIN auth (deja que el front haga login con Keycloak)
//app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'public')));

// JSON parser
app.use(express.json());

// WhatsApp manager
const whatsappManager = new WhatsAppManager();

// Rutas de API (dentro de buildRoutes ya protegés lo sensible con checkJwt/requireRole)
app.use('/', buildRoutes(whatsappManager));

// Raíz -> index.html (sin auth)
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 opcional para otras rutas
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

// Start
app.listen(port, async () => {
  logger.info({ url: `http://localhost:${port}` }, 'Servidor escuchando');
  logger.info({ retentionHours }, 'Configuración de retención');

  cleanupOldFiles(retentionHours);
  setInterval(() => {
    logger.info('Limpieza automática programada...');
    cleanupOldFiles(retentionHours);
  }, 6 * 3600 * 1000);

  try {
    await whatsappManager.initialize();
  } catch (e) {
    logger.error({ err: e?.message }, 'Error inicializando WhatsApp');
  }
});