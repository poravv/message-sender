require('dotenv').config();
const express = require('express');
const { retentionHours } = require('./src/config');
const { cleanupOldFiles } = require('./src/utils');
const { WhatsAppManager } = require('./src/manager');
const { buildRoutes } = require('./src/routes');
const logger = require('./src/logger');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

const whatsappManager = new WhatsAppManager();
app.use('/', buildRoutes(whatsappManager));

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