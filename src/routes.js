const fs = require('fs');
const path = require('path');
const express = require('express');
const { upload } = require('./media');
const qrcode = require('qrcode');
const { cleanupOldFiles, loadNumbersFromCSV, normalizeParaguayanNumber } = require('./utils');
const redisQueue = require('./queueRedis');
const metricsStore = require('./metricsStore');
const { publicDir, retentionHours } = require('./config');
const logger = require('./logger');
const { checkJwt, requireRole } = require('./auth');
const sessionManager = require('./sessionManager');

// Map para rastrear operaciones de refresh-qr en progreso por usuario
const qrRefreshInProgress = new Map();

// Middleware condicional para desarrollo
const conditionalAuth = (req, res, next) => {
  if (process.env.NODE_ENV === 'development') {
    req.auth = {
      sub: 'dev-user-001',
      name: 'Usuario Desarrollo',
      preferred_username: 'dev-user',
      email: 'dev@test.com'
    };
    req.userRoles = { all: ['sender_api'], realmRoles: [], clientRoles: ['sender_api'] };
    return next();
  }

  return checkJwt(req, res, next);
};

const conditionalRole = (role) => (req, res, next) => {
  if (process.env.NODE_ENV === 'development') {
    return next();
  }

  // En producción, verificar múltiples roles posibles
  const allowedRoles = ['sender_api', 'sender']; // Aceptar cualquiera de los dos
  const { all } = req.userRoles || {};

  const hasValidRole = allowedRoles.some(r => all?.includes(r));

  if (!hasValidRole) {
    logger.info({
      sub: req.auth?.sub,
      requestedRole: role,
      allowedRoles,
      userRoles: all
    }, 'Forbidden: missing required role');
    return res.status(403).json({ error: 'Forbidden: missing role' });
  }

  return next();
};

function buildRoutes() {
  const router = express.Router();

  // Estado de la sesión del usuario autenticado
  router.get('/connection-status', conditionalAuth, async (req, res) => {
    try {
      logger.info('Connection status request', {
        userId: req.auth?.sub,
        userName: req.auth?.name || req.auth?.preferred_username,
        userAgent: req.headers['user-agent'],
        ip: req.ip
      });

      const whatsappManager = await sessionManager.getSessionByToken(req);
      const s = whatsappManager.getState();
      const health = whatsappManager.getConnectionHealth ? whatsappManager.getConnectionHealth() : {};

      const conn = s.connectionState;
      const stateText = s.isReady
        ? 'connected'
        : (health.isInCooldown ? 'cooldown'
          : (conn === 'qr_ready' ? 'qr_ready'
            : (health.isConnecting || conn === 'connecting' ? 'connecting'
              : (conn === 'unauthorized' ? 'unauthorized' : 'disconnected'))));

      const resp = {
        status: s.connectionState,
        state: stateText,
        isReady: s.isReady,
        lastActivity: s.lastActivity,
        lastActivityAgo: Math.round((Date.now() - s.lastActivity) / 1000),
        hasQR: !!s.qrCode,
        connectionState: s.connectionState,
        userId: req.auth?.sub,
        userName: req.auth?.name || req.auth?.preferred_username,
        // Información de rate limiting y conflictos
        rateLimit: {
          messageCount: health.messageCount || 0,
          maxMessagesPerMinute: health.maxMessagesPerMinute || 15,
          canSendMessages: health.canSendMessages !== false,
          isInCooldown: health.isInCooldown || false
        },
        conflicts: {
          count: health.conflictCount || 0,
          lastConflictTime: health.lastConflictTime || null,
          isInConflictCooldown: health.isInCooldown || false
        },
        connection: {
          isConnecting: health.isConnecting || false,
          lastDisconnectReason: health.lastDisconnectReason || null
        }
      };

      if (s.userInfo) {
        resp.userInfo = {
          phoneNumber: s.userInfo.phoneNumber,
          pushname: s.userInfo.pushname
        };
      }

      logger.info('Connection status response', {
        userId: req.auth?.sub,
        status: resp.status,
        isReady: resp.isReady,
        hasQR: resp.hasQR
      });

      res.json(resp);
    } catch (error) {
      logger.error({
        err: error?.message,
        userId: req.auth?.sub,
        stack: error?.stack
      }, 'Error en /connection-status');
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/send-messages', conditionalAuth, conditionalRole('sender_api'), upload.fields([
    { name: 'csvFile', maxCount: 1 },
    { name: 'images', maxCount: 10 },
    { name: 'singleImage', maxCount: 1 },
    { name: 'audioFile', maxCount: 1 }
  ]), async (req, res) => {
    try {
      const whatsappManager = await sessionManager.getSessionByToken(req);

      if (!whatsappManager.isReady) {
        return res.status(400).json({
          error: 'Tu sesión de WhatsApp no está lista. Escaneá el QR primero.',
          needsQR: true
        });
      }

      const userId = req.auth?.sub || 'default';
      const { recipientSource, contactIds, groupName, templates: templatesJson, message, campaignName } = req.body;
      
      let numbers = [];
      let source = recipientSource || 'csv';
      let importSummary = null;
      let duplicates = 0;
      let invalidCount = 0;

      // Obtener destinatarios según la fuente
      if (source === 'contacts' && contactIds) {
        // Enviar a contactos seleccionados
        const ids = typeof contactIds === 'string' ? JSON.parse(contactIds) : contactIds;
        if (!Array.isArray(ids) || ids.length === 0) {
          return res.status(400).json({ error: 'Debes seleccionar al menos un contacto' });
        }
        const contacts = await metricsStore.getContactsByIds(userId, ids);
        if (contacts.length === 0) {
          return res.status(400).json({ error: 'No se encontraron los contactos seleccionados' });
        }
        numbers = contacts.map(c => ({
          number: c.phone,
          contactId: c.id,
          variables: {
            nombre: c.nombre || '',
            sustantivo: c.sustantivo || '',
            grupo: c.grupo || ''
          }
        }));
      } else if (source === 'group' && groupName) {
        // Enviar a un grupo completo
        const contacts = await metricsStore.getContactsByGroup(userId, groupName);
        if (contacts.length === 0) {
          return res.status(400).json({ error: `No se encontraron contactos en el grupo "${groupName}"` });
        }
        numbers = contacts.map(c => ({
          number: c.phone,
          contactId: c.id,
          variables: {
            nombre: c.nombre || '',
            sustantivo: c.sustantivo || '',
            grupo: c.grupo || ''
          }
        }));
      } else {
        // Fuente CSV (comportamiento original)
        if (!req.files || !req.files['csvFile']) {
          return res.status(400).json({ error: 'Archivo CSV/TXT no proporcionado' });
        }
        
        const csvFilePath = req.files['csvFile'][0].path;
        const parsed = await loadNumbersFromCSV(csvFilePath);
        invalidCount = parsed?.invalidCount || 0;
        duplicates = parsed?.duplicates || 0;
        
        if ((parsed?.numbers || []).length === 0) {
          return res.status(400).json({ error: 'No se encontraron números válidos' });
        }
        
        if (invalidCount > 0) {
          try { if (redisQueue && typeof redisQueue.cancelCampaign === 'function') await redisQueue.cancelCampaign(userId); } catch { }
          try { if (redisQueue && typeof redisQueue.clearList === 'function') await redisQueue.clearList(userId); } catch { }
          // Limpiar archivo
          if (fs.existsSync(csvFilePath)) fs.unlinkSync(csvFilePath);
          return res.status(400).json({
            error: 'Se detectaron filas inválidas en el CSV. Envío cancelado.',
            invalidCount,
            duplicates,
            details: 'Formatos aceptados: 595XXXXXXXXX, 9XXXXXXXX, +595XXXXXXXXX, 09XXXXXXXX'
          });
        }
        
        if (duplicates > 0) {
          logger.info({ duplicates, unique: parsed.numbers.length }, 'Duplicados eliminados del CSV');
        }
        
        // Importar contactos y enriquecer
        const imported = await metricsStore.importContactsFromEntries(userId, parsed.numbers, 'csv');
        numbers = imported.entries || [];
        importSummary = imported.summary || null;
        
        // Limpiar archivo CSV
        if (fs.existsSync(csvFilePath)) fs.unlinkSync(csvFilePath);
      }

      if (numbers.length === 0) {
        return res.status(400).json({ error: 'No se encontraron destinatarios válidos' });
      }

      let images = req.files['images'];
      let singleImage = req.files['singleImage'] ? req.files['singleImage'][0] : null;
      let audioFile = req.files['audioFile'] ? req.files['audioFile'][0] : null;

      // Extract templates from request body
      let templates = [];

      try {
        if (templatesJson) {
          templates = JSON.parse(templatesJson);
        } else if (message) {
          templates = [message];
        } else {
          for (let i = 1; i <= 5; i++) {
            const field = req.body?.[`message${i}`];
            if (typeof field === 'string' && field.trim()) {
              templates.push(field.trim());
            }
          }
        }
      } catch (e) {
        logger.error({ error: e.message }, 'Error parsing templates JSON');
        return res.status(400).json({ error: 'Formato de templates inválido' });
      }

      if (Array.isArray(templates)) {
        templates = templates
          .map((tpl) => (typeof tpl === 'string' ? tpl.trim() : tpl))
          .filter((tpl) => typeof tpl === 'string' && tpl.length > 0);
      }

      if (!templates || !Array.isArray(templates) || templates.length === 0) {
        return res.status(400).json({ error: 'Debes proporcionar al menos un template de mensaje' });
      }

      if (templates.length > 5) {
        return res.status(400).json({ error: 'Máximo 5 templates permitidos' });
      }

      for (let i = 0; i < templates.length; i++) {
        if (typeof templates[i] !== 'string' || templates[i].trim().length === 0) {
          return res.status(400).json({ error: `Template ${i + 1} está vacío o es inválido` });
        }
      }

      logger.info({
        userId,
        templateCount: templates.length,
        numbersCount: numbers.length,
        source
      }, 'Procesando envío con templates múltiples');

      // Crear campaña persistente
      const campaign = await metricsStore.createCampaign(userId, {
        name: campaignName || `Campaña ${new Date().toLocaleString()}`,
        totalRecipients: numbers.length,
        templateCount: templates.length,
      });
      await metricsStore.initCampaignRecipients(userId, campaign.id, numbers);

      // Si S3 está habilitado, subir imágenes y referenciarlas por s3Key
      try {
        const s3 = require('./storage/s3');
        if (s3.isEnabled()) {
          const userId = req.auth?.sub || 'default';
          const uploaded = [];
          if (Array.isArray(images)) {
            for (const img of images) {
              const key = s3.buildKey(userId, img.originalname || 'image');
              await s3.putObjectFromPath(key, img.path, img.mimetype);
              uploaded.push({ s3Key: key, mimetype: img.mimetype, originalname: img.originalname });
              try { if (img.path) require('fs').unlinkSync(img.path); } catch { }
            }
            images = uploaded;
          }
          if (singleImage) {
            const key = s3.buildKey(userId, singleImage.originalname || 'image');
            await s3.putObjectFromPath(key, singleImage.path, singleImage.mimetype);
            try { if (singleImage.path) require('fs').unlinkSync(singleImage.path); } catch { }
            singleImage = { s3Key: key, mimetype: singleImage.mimetype, originalname: singleImage.originalname };
          }
          if (audioFile) {
            const key = s3.buildKey(userId, audioFile.originalname || 'audio');
            await s3.putObjectFromPath(key, audioFile.path, audioFile.mimetype);
            try { if (audioFile.path) require('fs').unlinkSync(audioFile.path); } catch { }
            audioFile = { s3Key: key, mimetype: audioFile.mimetype, originalname: audioFile.originalname };
          }
        }
      } catch (e) {
        logger.error({ error: e.message, stack: e.stack }, 'Error al cargar archivos a S3');
        // Si el error es de credenciales o permisos, devolver error claro al usuario
        if (e.message && (e.message.includes('Access Key') || e.message.includes('credentials') || e.message.includes('forbidden'))) {
          throw new Error(`Error de almacenamiento: ${e.message}. Verifica las credenciales de MinIO.`);
        }
        logger.warn(`Carga a S3 omitida o fallida: ${e.message}`);
      }

      const useRedisQueue = (process.env.MESSAGE_QUEUE_BACKEND || 'redis').toLowerCase() === 'redis';
      if (useRedisQueue) {
        await redisQueue.enqueueCampaign(userId, numbers, templates, images, singleImage, audioFile, { campaignId: campaign.id });
        // Primer heartbeat tras encolar (para detectar refresh)
        if (typeof redisQueue.touchHeartbeat === 'function') {
          try { await redisQueue.touchHeartbeat(userId); } catch { }
        }
      } else {
        whatsappManager.updateActivity();
        await whatsappManager.messageQueue.add(numbers, templates[0], images, singleImage, audioFile);
      }

      res.json({
        status: 'success',
        message: 'Procesando mensajes',
        totalNumbers: numbers.length,
        templateCount: templates.length,
        campaignId: campaign.id,
        importSummary,
        duplicatesRemoved: duplicates,
        invalidNumbers: invalidCount,
        userId: req.auth?.sub,
        initialStats: useRedisQueue ? { total: numbers.length, sent: 0, errors: 0, messages: [], completed: false } : whatsappManager.messageQueue.getStats()
      });
    } catch (error) {
      logger.error({ err: error?.message }, 'Error en /send-messages');
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/message-status', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const useRedisQueue = (process.env.MESSAGE_QUEUE_BACKEND || 'redis').toLowerCase() === 'redis';
      if (useRedisQueue) {
        const userId = req.auth?.sub || 'default';
        if (typeof redisQueue.touchHeartbeat === 'function') {
          try { await redisQueue.touchHeartbeat(userId); } catch { }
        }
        const getStatus = redisQueue.getStatusDetailed || redisQueue.getStatus;
        const stats = await getStatus(userId);
        return res.json(stats);
      } else {
        const whatsappManager = await sessionManager.getSessionByToken(req);
        if (!whatsappManager.messageQueue) {
          return res.json({ total: 0, sent: 0, errors: 0, messages: [], completed: true });
        }
        return res.json(whatsappManager.messageQueue.getStats());
      }
    } catch (error) {
      logger.error({ err: error?.message }, 'Error en /message-status');
      res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // Contactos (alta manual + CRUD)
  // ---------------------------
  router.get('/contacts', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.sub || 'default';
      const { search = '', group = '', page = 1, pageSize = 25 } = req.query || {};
      const data = await metricsStore.listContacts(userId, { search, group, page, pageSize });
      return res.json(data);
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.sub }, 'Error en GET /contacts');
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/contacts', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.sub || 'default';
      const { phone, nombre, sustantivo, grupo } = req.body || {};
      const normalized = normalizeParaguayanNumber(phone);
      if (!normalized) {
        return res.status(400).json({ error: 'Número inválido. Formatos aceptados: 595XXXXXXXXX, 9XXXXXXXX, +595XXXXXXXXX, 09XXXXXXXX' });
      }

      const result = await metricsStore.upsertContact(userId, {
        phone: normalized,
        nombre: nombre || null,
        sustantivo: sustantivo || null,
        grupo: grupo || null,
      }, 'manual');
      return res.json({ success: true, created: result.created, contact: result.contact });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.sub }, 'Error en POST /contacts');
      return res.status(500).json({ error: error.message });
    }
  });

  router.put('/contacts/:contactId', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.sub || 'default';
      const { contactId } = req.params;
      const patch = { ...req.body };
      if (patch.phone !== undefined) {
        const normalized = normalizeParaguayanNumber(patch.phone);
        if (!normalized) {
          return res.status(400).json({ error: 'Número inválido. Formatos aceptados: 595XXXXXXXXX, 9XXXXXXXX, +595XXXXXXXXX, 09XXXXXXXX' });
        }
        patch.phone = normalized;
      }

      const updated = await metricsStore.updateContact(userId, contactId, patch);
      if (!updated) return res.status(404).json({ error: 'Contacto no encontrado' });
      return res.json({ success: true, contact: updated });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.sub }, 'Error en PUT /contacts/:contactId');
      return res.status(500).json({ error: error.message });
    }
  });

  router.delete('/contacts/:contactId', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.sub || 'default';
      const { contactId } = req.params;
      const deleted = await metricsStore.deleteContact(userId, contactId);
      if (!deleted) return res.status(404).json({ error: 'Contacto no encontrado' });
      return res.json({ success: true });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.sub }, 'Error en DELETE /contacts/:contactId');
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // Importar contactos desde CSV
  // ---------------------------
  router.post('/contacts/import', conditionalAuth, conditionalRole('sender_api'), upload.single('csvFile'), async (req, res) => {
    try {
      const userId = req.auth?.sub || 'default';
      
      if (!req.file) {
        return res.status(400).json({ error: 'Archivo CSV no proporcionado' });
      }

      const csvFilePath = req.file.path;
      const { loadNumbersFromCSV } = require('./utils');
      
      const parsed = await loadNumbersFromCSV(csvFilePath);
      
      if (parsed.invalidRows && parsed.invalidRows.length > 0) {
        fs.unlinkSync(csvFilePath);
        return res.status(400).json({
          error: 'Se detectaron filas inválidas en el CSV.',
          invalidRows: parsed.invalidRows.slice(0, 10)
        });
      }

      const result = await metricsStore.importContactsFromEntries(userId, parsed.entries || [], 'csv');

      // Limpiar archivo temporal
      if (fs.existsSync(csvFilePath)) {
        fs.unlinkSync(csvFilePath);
      }

      logger.info({ userId, imported: result.summary }, 'Contactos importados desde CSV');
      return res.json({
        success: true,
        imported: result.summary.inserted,
        updated: result.summary.updated,
        total: result.summary.total
      });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.sub }, 'Error en POST /contacts/import');
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // Obtener grupos de contactos
  // ---------------------------
  router.get('/contacts/groups', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.sub || 'default';
      const groups = await metricsStore.getContactGroups(userId);
      return res.json({ groups });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.sub }, 'Error en GET /contacts/groups');
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/contacts/:contactId', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.sub || 'default';
      const { contactId } = req.params;
      const contact = await metricsStore.getContactById(userId, contactId);
      if (!contact) return res.status(404).json({ error: 'Contacto no encontrado' });
      return res.json(contact);
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.sub }, 'Error en GET /contacts/:contactId');
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // Dashboard analytics
  // ---------------------------
  router.get('/dashboard/summary', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.sub || 'default';
      const { from, to } = req.query || {};
      const data = await metricsStore.dashboardSummary(userId, from, to);
      return res.json(data);
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.sub }, 'Error en GET /dashboard/summary');
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/dashboard/timeline', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.sub || 'default';
      const { from, to, bucket = 'day' } = req.query || {};
      const data = await metricsStore.dashboardTimeline(userId, from, to, bucket);
      return res.json({ bucket, rows: data });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.sub }, 'Error en GET /dashboard/timeline');
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/dashboard/by-group', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.sub || 'default';
      const { from, to } = req.query || {};
      const rows = await metricsStore.dashboardByGroup(userId, from, to);
      return res.json({ rows });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.sub }, 'Error en GET /dashboard/by-group');
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/dashboard/by-contact', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.sub || 'default';
      const { from, to, limit = 20 } = req.query || {};
      const rows = await metricsStore.dashboardByContact(userId, from, to, Number(limit));
      return res.json({ rows });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.sub }, 'Error en GET /dashboard/by-contact');
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/dashboard/current-month', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.sub || 'default';
      const data = await metricsStore.dashboardCurrentMonth(userId);
      return res.json(data);
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.sub }, 'Error en GET /dashboard/current-month');
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/dashboard/monthly', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.sub || 'default';
      const { months = 12 } = req.query || {};
      const rows = await metricsStore.dashboardMonthly(userId, Number(months));
      return res.json({ rows });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.sub }, 'Error en GET /dashboard/monthly');
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/campaigns/:id', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.sub || 'default';
      const detail = await metricsStore.getCampaignDetail(userId, req.params.id);
      if (!detail) return res.status(404).json({ error: 'Campaña no encontrada' });
      return res.json(detail);
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.sub }, 'Error en GET /campaigns/:id');
      return res.status(500).json({ error: error.message });
    }
  });

  // Cancelar campaña en curso o en espera (por usuario)
  router.post('/cancel-campaign', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const useRedisQueue = (process.env.MESSAGE_QUEUE_BACKEND || 'redis').toLowerCase() === 'redis';
      if (!useRedisQueue) {
        return res.status(400).json({ success: false, error: 'Cancelación soportada sólo con backend Redis' });
      }
      const userId = req.auth?.sub || 'default';
      const result = await redisQueue.cancelCampaign(userId);
      const status = await redisQueue.getStatus(userId);
      return res.json({ success: true, canceled: true, removedWaitingJobs: result.removed, status });
    } catch (error) {
      logger.error({ err: error?.message }, 'Error en /cancel-campaign');
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Heartbeat endpoint para mantener campaña activa
  router.post('/heartbeat', conditionalAuth, async (req, res) => {
    try {
      const userId = req.auth?.sub || 'default';
      await redisQueue.touchHeartbeat(userId);
      logger.debug({ userId }, 'Heartbeat recibido');
      return res.json({ success: true, timestamp: Date.now() });
    } catch (error) {
      logger.error({ err: error?.message }, 'Error en /heartbeat');
      res.status(500).json({ success: false, error: error.message });
    }
  });

  async function serveQrForUser(userId, res, manager = null) {
    const qrFileName = `qr-${userId}.png`;
    const qrPath = path.join(publicDir, qrFileName);

    // Prefer in-memory QR (más fresco)
    const qrManager = manager || sessionManager.sessions?.get?.(userId);
    if (qrManager?.qrCode) {
      const buf = await qrcode.toBuffer(qrManager.qrCode, {
        color: { dark: '#128C7E', light: '#FFFFFF' },
        width: 300,
        margin: 1,
      });
      res.set('Content-Type', 'image/png');
      return res.send(buf);
    }

    if (fs.existsSync(qrPath)) {
      return res.sendFile(qrPath);
    }

    if ((process.env.SESSION_STORE || 'file').toLowerCase() === 'redis') {
      const { getUserQr } = require('./stores/redisAuthState');
      const qrText = await getUserQr(userId);
      if (qrText) {
        const buf = await qrcode.toBuffer(qrText, {
          color: { dark: '#128C7E', light: '#FFFFFF' },
          width: 300,
          margin: 1,
        });
        res.set('Content-Type', 'image/png');
        return res.send(buf);
      }
    }

    return null;
  }

  router.get('/qr', conditionalAuth, async (req, res) => {
    try {
      const userId = req.auth?.sub;
      if (!userId) {
        return res.status(401).json({ error: 'Usuario no autenticado' });
      }

      const whatsappManager = await sessionManager.getSessionByToken(req);

      if (whatsappManager.isReady) {
        return res.status(400).json({ error: 'Ya estás conectado a WhatsApp' });
      }

      // 1. Si ya hay QR disponible, servirlo inmediatamente
      const quickServe = await serveQrForUser(userId, res, whatsappManager);
      if (quickServe) return;

      // 2. Si no hay socket, inicializar
      if (!whatsappManager.sock) {
        await sessionManager.initializeSession(userId);
      }

      // 3. Esperar hasta 8s para que Baileys genere QR (sesiones frescas tardan 3-5s)
      for (let i = 0; i < 16; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (whatsappManager.isReady) {
          return res.status(400).json({ error: 'Ya estás conectado a WhatsApp' });
        }
        const served = await serveQrForUser(userId, res, whatsappManager);
        if (served) return;
      }

      // 4. Sin QR tras 8s → auth stale en Redis. Baileys intenta reconectar con
      //    credenciales viejas en vez de generar QR. Lanzar refreshQR en background
      //    para limpiar auth y regenerar. El frontend reintenta en 5s y lo encontrará.
      if (!qrRefreshInProgress.has(userId)) {
        qrRefreshInProgress.set(userId, Date.now());
        logger.info({ userId, state: whatsappManager.connectionState, hasSock: !!whatsappManager.sock },
          'QR no disponible tras 8s, lanzando refreshQR en background');
        whatsappManager.refreshQR()
          .catch(e => logger.error({ err: e?.message, userId }, 'Error en auto-refreshQR'))
          .finally(() => qrRefreshInProgress.delete(userId));
      }

      return res.status(404).json({
        error: 'QR no disponible. Generando nuevo QR, reintente en unos segundos.',
        userId: userId
      });
    } catch (error) {
      logger.error({ err: error?.message }, 'Error en /qr');
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/qr-:userId.png', conditionalAuth, async (req, res) => {
    try {
      const requestedId = req.params.userId;
      const authUser = req.auth?.sub;

      if (!authUser) {
        return res.status(401).json({ error: 'Usuario no autenticado' });
      }

      if (requestedId !== authUser) {
        logger.warn({ authUser, requestedId }, 'Intento de acceso a QR de otro usuario');
        return res.status(403).json({ error: 'Forbidden' });
      }

      const manager = await sessionManager.getSession(requestedId);
      const served = await serveQrForUser(requestedId, res, manager);
      if (served) {
        return;
      }

      return res.status(404).json({
        error: 'QR no disponible para este usuario. Solicita un nuevo QR.',
        userId: requestedId
      });
    } catch (error) {
      logger.error({ err: error?.message }, 'Error en /qr-<userId>.png');
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/refresh-qr', conditionalAuth, async (req, res) => {
    try {
      const userId = req.auth?.sub;
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Usuario no autenticado'
        });
      }

      // Verificar si ya hay una operación de refresh en progreso para este usuario
      if (qrRefreshInProgress.has(userId)) {
        logger.warn({ userId }, 'Refresh QR ya en progreso para usuario, ignorando solicitud duplicada');
        return res.status(429).json({
          success: false,
          message: 'Ya hay una operación de refresh en progreso. Por favor espera.',
          retryAfter: 3
        });
      }

      // Marcar como en progreso
      qrRefreshInProgress.set(userId, Date.now());

      // Limpiar el marcador después de 30 segundos como medida de seguridad
      setTimeout(() => {
        qrRefreshInProgress.delete(userId);
      }, 30000);

      const whatsappManager = await sessionManager.getSessionByToken(req);

      if (whatsappManager.isReady) {
        qrRefreshInProgress.delete(userId); // Limpiar inmediatamente si ya está conectado
        return res.status(400).json({
          success: false,
          message: 'No se puede actualizar el QR si ya estás conectado'
        });
      }

      // Activa la compuerta para captura de QR
      whatsappManager.requestQrCapture();

      // Si ya hay un QR en memoria, lo escribimos para este usuario específico
      const wrote = await whatsappManager.captureQrToDisk(userId);

      if (wrote) {
        qrRefreshInProgress.delete(userId); // Limpiar al completar exitosamente
        return res.json({
          success: true,
          message: 'QR actualizado',
          qrUrl: '/qr'
        });
      }

      // Plan B: regenerar QR si no hay uno en memoria
      const ok = await whatsappManager.refreshQR();
      if (ok) {
        qrRefreshInProgress.delete(userId); // Limpiar al completar exitosamente
        return res.json({
          success: true,
          message: 'Solicitando nuevo código QR...',
          qrUrl: '/qr'
        });
      }

      qrRefreshInProgress.delete(userId); // Limpiar si falla
      return res.status(400).json({
        success: false,
        message: 'No se pudo refrescar el QR en este momento'
      });
    } catch (e) {
      // Asegurar limpieza en caso de error
      const userId = req.auth?.sub;
      if (userId) {
        qrRefreshInProgress.delete(userId);
      }

      logger.error({ err: e?.message, userId }, 'Error en refresh-qr');
      res.status(500).json({ success: false, message: e.message || 'Error al refrescar QR' });
    }
  });

  router.post('/cleanup', (req, res) => {
    cleanupOldFiles(retentionHours);
    res.json({ ok: true });
  });

  // ===== RUTAS ADMINISTRATIVAS PARA MULTI-SESIÓN =====

  // Listar todas las sesiones activas (solo para admins)
  router.get('/admin/sessions', conditionalAuth, conditionalRole('admin'), (req, res) => {
    try {
      const stats = sessionManager.getStats();
      res.json(stats);
    } catch (error) {
      logger.error({ err: error?.message }, 'Error en /admin/sessions');
      res.status(500).json({ error: error.message });
    }
  });

  // Cerrar sesión específica (solo para admins)
  router.post('/admin/sessions/:userId/close', conditionalAuth, conditionalRole('admin'), async (req, res) => {
    try {
      const { userId } = req.params;
      await sessionManager.closeSession(userId);
      res.json({ success: true, message: `Sesión de usuario ${userId} cerrada` });
    } catch (error) {
      logger.error({ err: error?.message }, 'Error cerrando sesión');
      res.status(500).json({ error: error.message });
    }
  });

  // Limpiar sesiones inactivas (solo para admins)
  router.post('/admin/cleanup-sessions', conditionalAuth, conditionalRole('admin'), (req, res) => {
    try {
      const { maxInactiveHours = 24 } = req.body;
      sessionManager.cleanupInactiveSessions(maxInactiveHours);
      res.json({ success: true, message: 'Limpieza de sesiones inactivas completada' });
    } catch (error) {
      logger.error({ err: error?.message }, 'Error en limpieza de sesiones');
      res.status(500).json({ error: error.message });
    }
  });

  // Limpieza de cola BullMQ (solo admin)
  router.post('/admin/queue/clean', conditionalAuth, conditionalRole('admin'), async (req, res) => {
    try {
      const { type = 'completed', graceSec = 3600, limit = 1000, obliterate = false } = req.body || {};
      if (obliterate) {
        const r = await redisQueue.obliterateQueue(true);
        return res.json({ success: r.ok, result: r });
      }
      const result = await redisQueue.cleanQueue(type, Number(graceSec), Number(limit));
      res.json({ success: true, result });
    } catch (error) {
      logger.error({ err: error?.message }, 'Error en /admin/queue/clean');
      res.status(500).json({ error: error.message });
    }
  });

  // Estado de mi propia sesión (detallado)
  router.get('/my-session', conditionalAuth, async (req, res) => {
    try {
      const whatsappManager = await sessionManager.getSessionByToken(req);
      const state = whatsappManager.getState();

      res.json({
        ...state,
        userId: req.auth?.sub,
        userName: req.auth?.name || req.auth?.preferred_username,
        authPath: whatsappManager.authPath
      });
    } catch (error) {
      logger.error({ err: error?.message }, 'Error en /my-session');
      res.status(500).json({ error: error.message });
    }
  });

  // Endpoint para logout robusto de WhatsApp
  router.post('/logout-whatsapp', conditionalAuth, async (req, res) => {
    try {
      const userId = req.auth.sub;
      console.log(`🚪 [${userId}] Solicitud de logout robusto de WhatsApp recibida`);

      const manager = await sessionManager.getSession(userId);
      if (!manager) {
        console.log(`⚠️ [${userId}] No hay sesión activa para logout`);
        return res.json({
          success: true,
          message: 'No hay sesión activa',
          state: 'no_session'
        });
      }

      // Verificar si el manager tiene el método robustLogout
      if (typeof manager.robustLogout !== 'function') {
        console.log(`⚠️ [${userId}] Manager no tiene método robustLogout, usando logout normal`);
        const result = await manager.logout();
        return res.json({
          success: result.success || result,
          message: result.message || 'Logout de WhatsApp completado',
          timestamp: new Date().toISOString(),
          fallback: true
        });
      }

      // Usar logout robusto
      const result = await manager.robustLogout();

      const response = {
        success: result.success,
        timestamp: new Date().toISOString(),
        attempts: result.attempts.length,
        finalState: result.finalState,
        details: result
      };

      if (result.success) {
        console.log(`✅ [${userId}] Logout robusto de WhatsApp exitoso`);
        response.message = 'Logout de WhatsApp completado exitosamente';
        response.recommendation = result.finalState.fullyDisconnected ?
          'Dispositivo completamente desvinculado' :
          'Logout completado, puede tardar unos minutos en reflejarse en WhatsApp';
      } else {
        console.log(`⚠️ [${userId}] Logout robusto con problemas:`, result);
        response.message = 'Logout completado con advertencias';
        response.recommendation = 'Se recomienda verificar manualmente la desvinculación en WhatsApp';
      }

      res.json(response);

    } catch (error) {
      console.error('❌ Error en logout robusto de WhatsApp:', error);
      res.status(500).json({
        success: false,
        error: 'Error interno del servidor',
        timestamp: new Date().toISOString()
      });
    }
  });

  // Endpoint para verificar estado de logout
  router.get('/logout-status/:userId?', conditionalAuth, async (req, res) => {
    try {
      const userId = req.params.userId || req.auth.sub;

      // Verificar autorización si se consulta otro usuario
      if (userId !== req.auth.sub && !req.auth.roles?.includes('admin')) {
        return res.status(403).json({ error: 'No autorizado para consultar otro usuario' });
      }

      const manager = await sessionManager.getSession(userId);
      if (!manager) {
        return res.json({
          userId,
          connected: false,
          state: 'no_session',
          message: 'No hay sesión activa'
        });
      }

      const state = await manager.verifyLogoutState();

      res.json({
        userId,
        connected: manager.isReady,
        state: state.fullyDisconnected ? 'disconnected' : 'partially_connected',
        details: state,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Error verificando estado de logout:', error);
      res.status(500).json({
        error: 'Error interno del servidor',
        timestamp: new Date().toISOString()
      });
    }
  });

  // Endpoint temporal para resetear cooldown (útil para debugging)
  router.post('/reset-cooldown', checkJwt, async (req, res) => {
    try {
      const userId = req.user.sub;
      console.log(`🔄 [${userId}] Solicitud de reset de cooldown recibida`);

      const manager = await sessionManager.getSession(userId);
      if (!manager) {
        return res.json({
          success: false,
          message: 'No hay sesión activa'
        });
      }

      // Resetear cooldown
      if (typeof manager.resetCooldown === 'function') {
        manager.resetCooldown();
        console.log(`✅ [${userId}] Cooldown reseteado exitosamente`);

        res.json({
          success: true,
          message: 'Cooldown reseteado exitosamente',
          timestamp: new Date().toISOString()
        });
      } else {
        res.json({
          success: false,
          message: 'Manager no tiene método resetCooldown',
          timestamp: new Date().toISOString()
        });
      }

    } catch (error) {
      console.error('❌ Error reseteando cooldown:', error);
      res.status(500).json({
        success: false,
        error: 'Error interno del servidor',
        timestamp: new Date().toISOString()
      });
    }
  });

  // Endpoint para limpiar sesión de Redis (resolver conflictos)
  router.post('/auth/clear-redis', conditionalAuth, async (req, res) => {
    try {
      const whatsappManager = await sessionManager.getSessionByToken(req);

      logger.info({ userId: req.auth?.sub }, 'Solicitud de limpieza de Redis recibida');

      // Llamar al método de limpieza
      const cleared = await whatsappManager._clearRedisAuth();

      if (cleared) {
        logger.info({ userId: req.auth?.sub }, 'Redis limpiado exitosamente');
        res.json({
          success: true,
          message: 'Sesión de Redis limpiada exitosamente. Puede reintentar la conexión.',
          timestamp: new Date().toISOString()
        });
      } else {
        logger.warn({ userId: req.auth?.sub }, 'No se encontraron claves para limpiar');
        res.json({
          success: true,
          message: 'No se encontraron datos antiguos en Redis',
          timestamp: new Date().toISOString()
        });
      }

    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.sub }, 'Error limpiando Redis');
      res.status(500).json({
        success: false,
        error: 'Error limpiando sesión de Redis',
        details: error?.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Limpiar caché de métricas y contactos del usuario en Redis
  router.delete('/cache/user', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.sub;
      logger.info({ userId }, 'Solicitud de limpieza de caché de usuario');

      const result = await metricsStore.clearUserCache(userId);

      logger.info({ userId, deletedKeys: result.deletedKeys }, 'Caché de usuario limpiado');
      res.json({
        success: true,
        message: `Caché limpiado: ${result.deletedKeys} claves eliminadas`,
        deletedKeys: result.deletedKeys,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.sub }, 'Error limpiando caché de usuario');
      res.status(500).json({
        success: false,
        error: 'Error limpiando caché',
        details: error?.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}

module.exports = { buildRoutes };
