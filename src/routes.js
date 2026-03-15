const fs = require('fs');
const path = require('path');
const express = require('express');
const { upload } = require('./media');
const qrcode = require('qrcode');
const { cleanupOldFiles, loadNumbersFromCSV } = require('./utils');
const { normalizeNumber, getCountryConfigs } = require('./phoneValidator');
const redisQueue = require('./queueRedis');
const metricsStore = require('./metricsStore');
const { publicDir, retentionHours } = require('./config');
const logger = require('./logger');
const { checkJwt } = require('./auth');
const sessionManager = require('./sessionManager');
const { ensureUserProfile, invalidateProfileCache } = require('./middleware/ensureUserProfile');
const { checkTrial } = require('./middleware/checkTrial');
const { sessionGuard, createSession, clearSession } = require('./middleware/sessionGuard');
const { ensureEmailVerified } = require('./middleware/ensureEmailVerified');
const { admin, db, auth } = require('./firebaseAdmin');

// Map para rastrear operaciones de refresh-qr en progreso por usuario
const qrRefreshInProgress = new Map();
// Map separado para cooldown de cleanInitialize en /qr (no bloquea /refresh-qr)
const qrCleanInitCooldown = new Map();

// Middleware condicional para desarrollo
// Chains: checkJwt -> ensureUserProfile -> checkTrial
const conditionalAuth = (req, res, next) => {
  if (process.env.NODE_ENV === 'development') {
    req.auth = {
      uid: 'dev-user-001',
      name: 'Usuario Desarrollo',
      email: 'dev@test.com',
      picture: null,
      email_verified: true,
      sign_in_provider: 'password'
    };
    req.userProfile = {
      uid: 'dev-user-001',
      email: 'dev@test.com',
      displayName: 'Usuario Desarrollo',
      plan: 'active',
      role: 'admin',
      status: 'active',
      country: 'PY',
      trialEndsAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      whatsappPhone: null,
      createdAt: new Date(),
      lastLoginAt: new Date()
    };
    return next();
  }

  // Production chain: checkJwt -> ensureUserProfile -> ensureEmailVerified -> checkTrial -> sessionGuard
  checkJwt(req, res, (err) => {
    if (err) return; // checkJwt already sent response
    ensureUserProfile(req, res, (err2) => {
      if (err2) return;
      ensureEmailVerified(req, res, (err3) => {
        if (err3) return;
        checkTrial(req, res, (err4) => {
          if (err4) return;
          sessionGuard(req, res, next);
        });
      });
    });
  });
};

// Auth-only middleware (no trial check) — for endpoints expired users should access
const conditionalAuthNoTrial = (req, res, next) => {
  if (process.env.NODE_ENV === 'development') {
    req.auth = {
      uid: 'dev-user-001',
      name: 'Usuario Desarrollo',
      email: 'dev@test.com',
      picture: null,
      email_verified: true,
      sign_in_provider: 'password'
    };
    req.userProfile = {
      uid: 'dev-user-001',
      email: 'dev@test.com',
      displayName: 'Usuario Desarrollo',
      plan: 'active',
      role: 'admin',
      status: 'active',
      country: 'PY',
      trialEndsAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      whatsappPhone: null,
      createdAt: new Date(),
      lastLoginAt: new Date()
    };
    return next();
  }

  // Production chain: checkJwt -> ensureUserProfile (no trial check)
  checkJwt(req, res, (err) => {
    if (err) return;
    ensureUserProfile(req, res, next);
  });
};

// conditionalRole — with Firebase Auth there are no Keycloak role arrays.
// In production we simply check that the user is authenticated (checkJwt already ran).
// The parameter is kept for API compatibility so call-sites don't need changes.
const conditionalRole = (_role) => (req, res, next) => {
  if (process.env.NODE_ENV === 'development') {
    return next();
  }

  // Authenticated users pass — Firebase custom-claims based roles can be added later.
  if (!req.auth) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  return next();
};

function buildRoutes() {
  const router = express.Router();

  // ── Public Firebase client config (NO auth — needed before login) ──
  router.get('/config/firebase', (_req, res) => {
    res.json({
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.FIREBASE_APP_ID,
      measurementId: process.env.FIREBASE_MEASUREMENT_ID
    });
  });

  // ── Session management (no sessionGuard — this endpoint CREATES sessions) ──
  router.post('/auth/session', conditionalAuthNoTrial, async (req, res) => {
    try {
      const userId = req.auth.uid;
      const redis = require('./redisClient').getRedis();
      const crypto = require('crypto');

      const token = crypto.randomUUID();
      const sessionData = JSON.stringify({
        token,
        createdAt: new Date().toISOString(),
        userAgent: req.headers['user-agent'] || 'unknown',
        ip: req.ip || req.connection.remoteAddress || 'unknown'
      });

      await redis.set(`ms:session:${userId}`, sessionData, 'EX', 24 * 60 * 60);
      logger.info({ uid: userId }, 'Session created via POST /auth/session');

      res.json({ sessionToken: token });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en POST /auth/session');
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  // ── Session cleanup on logout ──
  router.post('/auth/logout-session', conditionalAuthNoTrial, async (req, res) => {
    try {
      const userId = req.auth.uid;
      await clearSession(userId);
      res.json({ success: true, message: 'Session cleared' });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en POST /auth/logout-session');
      res.status(500).json({ error: 'Failed to clear session' });
    }
  });

  // ── Resend email verification (tracking endpoint) ──
  router.post('/auth/resend-verification', conditionalAuthNoTrial, async (req, res) => {
    try {
      const uid = req.auth.uid;
      const email = req.auth.email;

      // Google users don't need email verification
      if (req.auth.sign_in_provider === 'google.com') {
        return res.json({ success: true, message: 'Google users are already verified' });
      }

      if (req.auth.email_verified) {
        return res.json({ success: true, message: 'Email already verified' });
      }

      // Generate verification link via Firebase Admin SDK
      if (auth) {
        try {
          const link = await auth.generateEmailVerificationLink(email);
          logger.info({ uid, email }, 'Email verification link generated');
        } catch (linkErr) {
          logger.warn({ uid, email, err: linkErr.message }, 'Could not generate verification link via Admin SDK');
        }
      }

      logger.info({ uid, email }, 'Resend verification requested');
      res.json({ success: true, message: 'Verification email requested' });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en POST /auth/resend-verification');
      res.status(500).json({ error: 'Failed to process verification request' });
    }
  });

  // Intervalos de envío disponibles para el usuario
  router.get('/config/intervals', conditionalAuth, (req, res) => {
    const userRole = req.userProfile?.role;
    const userPlan = req.userProfile?.plan;
    const canUseFast = userRole === 'admin' || userPlan === 'pro' || userPlan === 'professional';

    const intervals = [
      { value: 3,  label: 'Rapido (3s)', badge: '\u26A0\uFE0F', color: 'warning', restricted: true,  available: canUseFast },
      { value: 5,  label: 'Normal (5s)', badge: '\u2713',       color: 'success', restricted: false, available: true, default: true },
      { value: 8,  label: 'Seguro (8s)', badge: '\u2713\u2713',       color: 'info',    restricted: false, available: true },
      { value: 12, label: 'Muy seguro (12s)', badge: '\u2713\u2713\u2713',   color: 'info',    restricted: false, available: true },
      { value: 15, label: 'Ultra seguro (15s)', badge: '',       color: 'secondary', restricted: false, available: true },
    ];

    res.json({ intervals, defaultInterval: 5 });
  });

  // Estado de la sesión del usuario autenticado
  router.get('/connection-status', conditionalAuth, async (req, res) => {
    try {
      logger.info('Connection status request', {
        userId: req.auth?.uid,
        userName: req.auth?.name || req.auth?.email,
        userAgent: req.headers['user-agent'],
        ip: req.ip
      });

      const whatsappManager = await sessionManager.getSessionByToken(req);
      const s = whatsappManager.getState();
      const health = whatsappManager.getConnectionHealth ? whatsappManager.getConnectionHealth() : {};

      const conn = s.connectionState;
      const stateText = s.isReady
        ? 'connected'
        : (conn === 'phone_taken' ? 'phone_taken'
          : (health.isInCooldown ? 'cooldown'
            : (conn === 'qr_ready' ? 'qr_ready'
              : (health.isConnecting || conn === 'connecting' ? 'connecting'
                : (conn === 'unauthorized' ? 'unauthorized' : 'disconnected')))));

      const resp = {
        status: s.connectionState,
        state: stateText,
        isReady: s.isReady,
        lastActivity: s.lastActivity,
        lastActivityAgo: Math.round((Date.now() - s.lastActivity) / 1000),
        hasQR: !!s.qrCode,
        connectionState: s.connectionState,
        userId: req.auth?.uid,
        userName: req.auth?.name || req.auth?.email,
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

      // Task 4.4: Include linked phone from Firestore profile
      if (req.userProfile && req.userProfile.whatsappPhone) {
        resp.whatsappPhone = req.userProfile.whatsappPhone;
      }

      // Include phone_taken alert if present
      if (s.securityAlert && s.securityAlert.type === 'phone_taken') {
        resp.phoneTakenError = s.securityAlert.messages[0] || 'Este número ya está asociado a otro usuario';
      }

      logger.info('Connection status response', {
        userId: req.auth?.uid,
        status: resp.status,
        isReady: resp.isReady,
        hasQR: resp.hasQR
      });

      res.json(resp);
    } catch (error) {
      logger.error({
        err: error?.message,
        userId: req.auth?.uid,
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

      // Validate country is configured
      if (!req.userProfile?.country) {
        return res.status(400).json({
          error: 'country_required',
          message: 'Debes configurar tu país antes de enviar mensajes'
        });
      }

      const userId = req.auth?.uid || 'default';
      const { recipientSource, contactIds, groupName, templates: templatesJson, message, campaignName, messageInterval: rawInterval } = req.body;

      // Validate message interval
      const allowedIntervals = redisQueue.ALLOWED_INTERVALS || [3, 5, 8, 12, 15];
      const defaultInterval = redisQueue.DEFAULT_INTERVAL || 5;
      let messageInterval = Number(rawInterval) || defaultInterval;
      if (!allowedIntervals.includes(messageInterval)) {
        messageInterval = defaultInterval;
      }
      // 3s interval restricted to admin or pro plan users
      if (messageInterval === 3) {
        const userRole = req.userProfile?.role;
        const userPlan = req.userProfile?.plan;
        const isAllowed = userRole === 'admin' || userPlan === 'pro' || userPlan === 'professional';
        if (!isAllowed) {
          messageInterval = defaultInterval;
        }
      }
      
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
            tratamiento: c.tratamiento || '',
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
            tratamiento: c.tratamiento || '',
            grupo: c.grupo || ''
          }
        }));
      } else {
        // Fuente CSV (comportamiento original)
        if (!req.files || !req.files['csvFile']) {
          return res.status(400).json({ error: 'Archivo CSV/TXT no proporcionado' });
        }
        
        const csvFilePath = req.files['csvFile'][0].path;
        const userCountry = req.userProfile?.country || 'PY';
        const parsed = await loadNumbersFromCSV(csvFilePath, userCountry);
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
            details: 'Verifique que los números estén en formato válido para su país (con o sin código de país)'
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
          const userId = req.auth?.uid || 'default';
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
        await redisQueue.enqueueCampaign(userId, numbers, templates, images, singleImage, audioFile, { campaignId: campaign.id, messageInterval });
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
        messageInterval,
        importSummary,
        duplicatesRemoved: duplicates,
        invalidNumbers: invalidCount,
        userId: req.auth?.uid,
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
        const userId = req.auth?.uid || 'default';
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
      const userId = req.auth?.uid || 'default';
      const { search = '', group = '', page = 1, pageSize = 25 } = req.query || {};
      const data = await metricsStore.listContacts(userId, { search, group, page, pageSize });
      return res.json(data);
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /contacts');
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/contacts', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      const { phone, nombre, tratamiento, sustantivo, grupo } = req.body || {};
      const userCountry = req.userProfile?.country || 'PY';
      const phoneResult = normalizeNumber(phone, userCountry);
      const normalized = phoneResult.valid ? phoneResult.normalized : null;
      if (!normalized) {
        return res.status(400).json({ error: `Número inválido para ${userCountry}. Verifica el formato e intenta de nuevo.` });
      }

      const result = await metricsStore.upsertContact(userId, {
        phone: normalized,
        nombre: nombre || null,
        tratamiento: tratamiento || sustantivo || null,
        grupo: grupo || null,
      }, 'manual');
      return res.json({ success: true, created: result.created, contact: result.contact });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en POST /contacts');
      return res.status(500).json({ error: error.message });
    }
  });

  router.put('/contacts/:contactId', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      const { contactId } = req.params;
      const patch = { ...req.body };
      if (patch.phone !== undefined) {
        const userCountry = req.userProfile?.country || 'PY';
        const phoneResult = normalizeNumber(patch.phone, userCountry);
        if (!phoneResult.valid) {
          return res.status(400).json({ error: `Número inválido para ${userCountry}. Verifica el formato e intenta de nuevo.` });
        }
        patch.phone = phoneResult.normalized;
      }

      const updated = await metricsStore.updateContact(userId, contactId, patch);
      if (!updated) return res.status(404).json({ error: 'Contacto no encontrado' });
      return res.json({ success: true, contact: updated });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en PUT /contacts/:contactId');
      return res.status(500).json({ error: error.message });
    }
  });

  router.delete('/contacts/:contactId', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      const { contactId } = req.params;
      const deleted = await metricsStore.deleteContact(userId, contactId);
      if (!deleted) return res.status(404).json({ error: 'Contacto no encontrado' });
      return res.json({ success: true });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en DELETE /contacts/:contactId');
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // Importar contactos desde CSV
  // ---------------------------
  router.post('/contacts/import', conditionalAuth, conditionalRole('sender_api'), upload.single('csvFile'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      
      if (!req.file) {
        return res.status(400).json({ error: 'Archivo CSV no proporcionado' });
      }

      const csvFilePath = req.file.path;
      const { loadNumbersFromCSV } = require('./utils');
      const userCountry = req.userProfile?.country || 'PY';
      const parsed = await loadNumbersFromCSV(csvFilePath, userCountry);
      
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
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en POST /contacts/import');
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // Obtener grupos de contactos
  // ---------------------------
  router.get('/contacts/groups', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      const groups = await metricsStore.getContactGroups(userId);
      return res.json({ groups });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /contacts/groups');
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/contacts/:contactId', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      const { contactId } = req.params;
      const contact = await metricsStore.getContactById(userId, contactId);
      if (!contact) return res.status(404).json({ error: 'Contacto no encontrado' });
      return res.json(contact);
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /contacts/:contactId');
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // Dashboard analytics
  // ---------------------------
  router.get('/dashboard/summary', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      const { from, to } = req.query || {};
      const data = await metricsStore.dashboardSummary(userId, from, to);
      return res.json(data);
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /dashboard/summary');
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/dashboard/timeline', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      const { from, to, bucket = 'day' } = req.query || {};
      const data = await metricsStore.dashboardTimeline(userId, from, to, bucket);
      return res.json({ bucket, rows: data });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /dashboard/timeline');
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/dashboard/by-group', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      const { from, to } = req.query || {};
      const rows = await metricsStore.dashboardByGroup(userId, from, to);
      return res.json({ rows });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /dashboard/by-group');
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/dashboard/by-contact', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      const { from, to, limit = 20 } = req.query || {};
      const rows = await metricsStore.dashboardByContact(userId, from, to, Number(limit));
      return res.json({ rows });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /dashboard/by-contact');
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/dashboard/current-month', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      const data = await metricsStore.dashboardCurrentMonth(userId);
      return res.json(data);
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /dashboard/current-month');
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/dashboard/monthly', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      const { months = 12 } = req.query || {};
      const rows = await metricsStore.dashboardMonthly(userId, Number(months));
      return res.json({ rows });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /dashboard/monthly');
      return res.status(500).json({ error: error.message });
    }
  });

  // GET /campaigns — paginated list with stats
  router.get('/campaigns', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 20));
      const search = req.query.search || '';
      const dateFrom = req.query.dateFrom || null;
      const dateTo = req.query.dateTo || null;

      const result = await metricsStore.listCampaigns(userId, { page, pageSize, search, dateFrom, dateTo });
      return res.json(result);
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /campaigns');
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/campaigns/:id', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      const detail = await metricsStore.getCampaignDetail(userId, req.params.id);
      if (!detail) return res.status(404).json({ error: 'Campaña no encontrada' });
      return res.json(detail);
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /campaigns/:id');
      return res.status(500).json({ error: error.message });
    }
  });

  // GET /campaigns/:id/responses — incoming messages from campaign contacts after campaign date
  router.get('/campaigns/:id/responses', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      const pgClient = require('./postgresClient');
      const chatbotEngine = require('./chatbotEngine');
      await chatbotEngine.ensureChatbotTables();

      // Get campaign info
      const campaignResult = await pgClient.query(
        'SELECT id, created_at FROM campaigns WHERE id = $1 AND user_id = $2',
        [req.params.id, userId]
      );
      if (!campaignResult.rows[0]) {
        return res.status(404).json({ error: 'Campaña no encontrada' });
      }
      const campaign = campaignResult.rows[0];

      // Get phones from campaign recipients
      const recipientResult = await pgClient.query(
        'SELECT DISTINCT phone FROM campaign_recipients WHERE campaign_id = $1',
        [campaign.id]
      );
      const phones = recipientResult.rows.map(r => r.phone);

      if (phones.length === 0) {
        return res.json({ responses: [], count: 0 });
      }

      // Get incoming messages from those phones after campaign creation date
      const messagesResult = await pgClient.query(
        `SELECT * FROM incoming_messages
         WHERE user_id = $1 AND contact_phone = ANY($2) AND is_from_contact = true
           AND created_at >= $3
         ORDER BY created_at DESC
         LIMIT 500`,
        [userId, phones, campaign.created_at]
      );

      return res.json({
        responses: messagesResult.rows,
        count: messagesResult.rows.length
      });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /campaigns/:id/responses');
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
      const userId = req.auth?.uid || 'default';
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
      const userId = req.auth?.uid || 'default';
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
      const userId = req.auth?.uid;
      if (!userId) {
        return res.status(401).json({ error: 'Usuario no autenticado' });
      }

      const whatsappManager = await sessionManager.getSessionByToken(req);

      if (whatsappManager.isReady) {
        return res.status(400).json({ error: 'Ya estás conectado a WhatsApp' });
      }

      // 1. Si ya hay QR disponible, servirlo inmediatamente (respuesta rápida)
      const quickServe = await serveQrForUser(userId, res, whatsappManager);
      if (quickServe) return;

      // 2. Si no hay socket, inicializar UNA vez (con cooldown de 60s)
      if (!whatsappManager.sock) {
        if (!qrCleanInitCooldown.has(userId)) {
          qrCleanInitCooldown.set(userId, Date.now());
          try {
            await whatsappManager.cleanInitialize();
          } catch (e) {
            logger.error({ err: e?.message, userId }, 'Error en cleanInitialize');
          }
          setTimeout(() => qrCleanInitCooldown.delete(userId), 60000);
        } else {
          await sessionManager.initializeSession(userId);
        }
      }

      // 3. Esperar máximo 10s a que Baileys genere el primer QR
      //    (solo se espera en la primera llamada; las siguientes sirven rápido)
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (whatsappManager.isReady) {
          return res.status(400).json({ error: 'Ya estás conectado a WhatsApp' });
        }
        const served = await serveQrForUser(userId, res, whatsappManager);
        if (served) return;
      }

      return res.status(404).json({
        error: 'QR no disponible para este usuario. Solicita un nuevo QR.',
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
      const authUser = req.auth?.uid;

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
      const userId = req.auth?.uid;
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
      const userId = req.auth?.uid;
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
        userId: req.auth?.uid,
        userName: req.auth?.name || req.auth?.email,
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
      const userId = req.auth.uid;
      // Clear browser session on WhatsApp logout
      await clearSession(userId).catch(() => {});
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
      const userId = req.params.userId || req.auth.uid;

      // Verificar autorización si se consulta otro usuario
      if (userId !== req.auth.uid) {
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
      const userId = req.auth?.uid;
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

      logger.info({ userId: req.auth?.uid }, 'Solicitud de limpieza de Redis recibida');

      // Llamar al método de limpieza
      const cleared = await whatsappManager._clearRedisAuth();

      if (cleared) {
        logger.info({ userId: req.auth?.uid }, 'Redis limpiado exitosamente');
        res.json({
          success: true,
          message: 'Sesión de Redis limpiada exitosamente. Puede reintentar la conexión.',
          timestamp: new Date().toISOString()
        });
      } else {
        logger.warn({ userId: req.auth?.uid }, 'No se encontraron claves para limpiar');
        res.json({
          success: true,
          message: 'No se encontraron datos antiguos en Redis',
          timestamp: new Date().toISOString()
        });
      }

    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error limpiando Redis');
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
      const userId = req.auth?.uid;
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
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error limpiando caché de usuario');
      res.status(500).json({
        success: false,
        error: 'Error limpiando caché',
        details: error?.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // ---------------------------
  // User profile (accessible even with expired trial)
  // ---------------------------
  router.get('/user/profile', conditionalAuthNoTrial, async (req, res) => {
    try {
      const profile = req.userProfile;
      if (!profile) {
        return res.status(404).json({ error: 'Profile not found' });
      }

      // Calculate trialDaysLeft
      let trialDaysLeft = 0;
      if (profile.trialEndsAt) {
        const trialEnd = profile.trialEndsAt instanceof Date
          ? profile.trialEndsAt
          : (profile.trialEndsAt && profile.trialEndsAt.toDate
            ? profile.trialEndsAt.toDate()
            : new Date(profile.trialEndsAt));
        const msLeft = trialEnd.getTime() - Date.now();
        trialDaysLeft = Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
      }

      return res.json({
        uid: profile.uid,
        email: profile.email,
        displayName: profile.displayName,
        plan: profile.plan,
        role: profile.role,
        status: profile.status || 'active',
        trialDaysLeft,
        whatsappPhone: profile.whatsappPhone,
        country: profile.country || 'PY',
        createdAt: profile.createdAt
      });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en GET /user/profile');
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // User: API Key management (Professional/Enterprise only)
  // ---------------------------
  router.post('/user/api-key', conditionalAuth, async (req, res) => {
    try {
      const uid = req.auth?.uid;
      if (!uid) return res.status(401).json({ error: 'Unauthenticated' });

      const profile = req.userProfile;
      // Only active plans or admins can generate API keys
      if (profile && profile.role !== 'admin' && profile.plan !== 'active') {
        return res.status(403).json({ error: 'API key generation requires Professional or Enterprise plan' });
      }

      const crypto = require('crypto');
      const apiKey = crypto.randomUUID();

      if (db) {
        const userRef = db.collection('users').doc(uid);
        await userRef.update({ apiKey });
        invalidateProfileCache(uid);
      }

      logger.info({ uid }, 'API key generated');
      return res.json({ success: true, apiKey });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en POST /user/api-key');
      return res.status(500).json({ error: error.message });
    }
  });

  router.delete('/user/api-key', conditionalAuth, async (req, res) => {
    try {
      const uid = req.auth?.uid;
      if (!uid) return res.status(401).json({ error: 'Unauthenticated' });

      if (db) {
        const userRef = db.collection('users').doc(uid);
        await userRef.update({ apiKey: null });
        invalidateProfileCache(uid);
      }

      logger.info({ uid }, 'API key revoked');
      return res.json({ success: true });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en DELETE /user/api-key');
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/user/api-key', conditionalAuth, async (req, res) => {
    try {
      const uid = req.auth?.uid;
      if (!uid) return res.status(401).json({ error: 'Unauthenticated' });

      if (!db) {
        return res.json({ hasApiKey: false, apiKey: null });
      }

      const userRef = db.collection('users').doc(uid);
      const snap = await userRef.get();
      const data = snap.exists ? snap.data() : {};

      return res.json({
        hasApiKey: !!data.apiKey,
        apiKey: data.apiKey || null
      });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en GET /user/api-key');
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // Phone: supported countries
  // ---------------------------
  router.get('/phone/countries', conditionalAuth, (req, res) => {
    return res.json(getCountryConfigs());
  });

  // ---------------------------
  // User: set country
  // ---------------------------
  router.put('/user/country', conditionalAuthNoTrial, async (req, res) => {
    try {
      const uid = req.auth?.uid;
      if (!uid) return res.status(401).json({ error: 'Unauthenticated' });

      const { country } = req.body || {};
      const configs = getCountryConfigs();
      if (!country || !configs[country.toUpperCase()]) {
        return res.status(400).json({ error: 'País no soportado. Usa uno de: ' + Object.keys(configs).join(', ') });
      }

      const upperCountry = country.toUpperCase();

      if (db) {
        const userRef = db.collection('users').doc(uid);
        await userRef.update({ country: upperCountry });
        invalidateProfileCache(uid);
      }

      return res.json({ success: true, country: upperCountry });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en PUT /user/country');
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // Admin: update user plan
  // ---------------------------
  router.put('/admin/users/:userId/plan', conditionalAuth, async (req, res) => {
    try {
      // Check admin role
      if (!req.userProfile || req.userProfile.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: admin role required' });
      }

      const { userId } = req.params;
      const { plan, trialEndsAt } = req.body || {};

      const validPlans = ['active', 'trial', 'expired'];
      if (!plan || !validPlans.includes(plan)) {
        return res.status(400).json({ error: 'Invalid plan. Must be one of: active, trial, expired' });
      }

      const updateData = { plan };
      if (trialEndsAt) {
        updateData.trialEndsAt = new Date(trialEndsAt);
      }

      const userRef = db.collection('users').doc(userId);
      const snap = await userRef.get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'User not found' });
      }

      await userRef.update(updateData);
      invalidateProfileCache(userId);

      logger.info({ adminUid: req.auth.uid, targetUserId: userId, plan, trialEndsAt }, 'Admin updated user plan');

      const updated = (await userRef.get()).data();
      return res.json({
        success: true,
        user: {
          uid: userId,
          email: updated.email,
          plan: updated.plan,
          role: updated.role,
          trialEndsAt: updated.trialEndsAt
        }
      });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en PUT /admin/users/:userId/plan');
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // Admin: unlink WhatsApp phone from user
  // ---------------------------
  router.delete('/admin/users/:userId/phone', conditionalAuth, async (req, res) => {
    try {
      // Check admin role
      if (!req.userProfile || req.userProfile.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: admin role required' });
      }

      const { userId } = req.params;

      const userRef = db.collection('users').doc(userId);
      const snap = await userRef.get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'User not found' });
      }

      const previousPhone = snap.data().whatsappPhone;

      // Clear phone in Firestore
      await userRef.update({ whatsappPhone: null });
      invalidateProfileCache(userId);

      // Disconnect WhatsApp session if active
      const manager = sessionManager.sessions.get(userId);
      if (manager && manager.isReady) {
        try {
          await manager.logout();
          sessionManager.sessions.delete(userId);
          logger.info({ adminUid: req.auth.uid, targetUserId: userId }, 'Admin disconnected user WhatsApp session');
        } catch (logoutErr) {
          logger.warn({ adminUid: req.auth.uid, targetUserId: userId, err: logoutErr?.message }, 'Error disconnecting user session during phone unlink');
        }
      }

      logger.info({ adminUid: req.auth.uid, targetUserId: userId, previousPhone }, 'Admin unlinked WhatsApp phone');

      return res.json({
        success: true,
        message: 'WhatsApp phone unlinked successfully',
        previousPhone: previousPhone || null
      });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en DELETE /admin/users/:userId/phone');
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // Admin: manual cleanup of a user's Redis data
  // ---------------------------
  router.post('/admin/users/:userId/cleanup', conditionalAuth, conditionalRole('admin'), async (req, res) => {
    try {
      if (!req.userProfile || req.userProfile.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: admin role required' });
      }

      const { userId } = req.params;
      const keepAuth = req.body?.keepAuth === true;

      logger.info({ adminUid: req.auth.uid, targetUserId: userId, keepAuth }, 'Admin cleanup requested');

      const result = await redisQueue.cleanupUserData(userId, { keepAuth });

      return res.json({
        success: result.success,
        userId,
        keepAuth,
        deletedKeys: result.deletedKeys,
        deletedCount: result.deletedKeys.length,
      });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en POST /admin/users/:userId/cleanup');
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // Admin: Redis key statistics
  // ---------------------------
  router.get('/admin/redis/stats', conditionalAuth, conditionalRole('admin'), async (req, res) => {
    try {
      if (!req.userProfile || req.userProfile.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: admin role required' });
      }

      const stats = await redisQueue.getRedisKeyStats();
      return res.json({ success: true, ...stats });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en GET /admin/redis/stats');
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // Admin: Orphan key scanner
  // ---------------------------
  router.get('/admin/redis/orphan-scan', conditionalAuth, conditionalRole('admin'), async (req, res) => {
    try {
      if (!req.userProfile || req.userProfile.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: admin role required' });
      }

      const scanResult = await redisQueue.scanOrphanKeys();
      return res.json({
        success: true,
        totalUsersScanned: scanResult.totalUsersScanned,
        orphanCount: scanResult.orphans.length,
        activeCount: scanResult.active.length,
        orphans: scanResult.orphans.map(o => ({
          userId: o.userId,
          keyCount: o.keyCount,
          keys: o.keys,
        })),
      });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en GET /admin/redis/orphan-scan');
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // Admin: Delete orphan keys (POST with orphan userIds)
  // ---------------------------
  router.post('/admin/redis/orphan-cleanup', conditionalAuth, conditionalRole('admin'), async (req, res) => {
    try {
      if (!req.userProfile || req.userProfile.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: admin role required' });
      }

      // First scan, then optionally filter by provided userIds
      const scanResult = await redisQueue.scanOrphanKeys();
      let toDelete = scanResult.orphans;

      if (req.body?.userIds && Array.isArray(req.body.userIds)) {
        const allowed = new Set(req.body.userIds);
        toDelete = toDelete.filter(o => allowed.has(o.userId));
      }

      if (toDelete.length === 0) {
        return res.json({ success: true, message: 'No orphan keys to delete', totalDeleted: 0 });
      }

      const result = await redisQueue.deleteOrphanKeys(toDelete);
      return res.json({ success: true, ...result });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en POST /admin/redis/orphan-cleanup');
      return res.status(500).json({ error: error.message });
    }
  });

  // ══════════════════════════════════════════════════════
  // ADMIN: USER MANAGEMENT
  // ══════════════════════════════════════════════════════

  // ---------------------------
  // Admin: list all users
  // ---------------------------
  router.get('/admin/users', conditionalAuth, conditionalRole('admin'), async (req, res) => {
    try {
      if (!req.userProfile || req.userProfile.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: admin role required' });
      }

      if (!db) {
        return res.status(503).json({ error: 'Firestore not available' });
      }

      const snapshot = await db.collection('users').get();
      const users = [];

      snapshot.forEach((doc) => {
        const data = doc.data();
        users.push({
          uid: doc.id,
          email: data.email || '',
          displayName: data.displayName || '',
          plan: data.plan || 'trial',
          role: data.role || 'user',
          status: data.status || 'active',
          country: data.country || 'PY',
          whatsappPhone: data.whatsappPhone || null,
          createdAt: data.createdAt || null,
          trialEndsAt: data.trialEndsAt || null,
          lastLoginAt: data.lastLoginAt || null
        });
      });

      logger.info({ adminUid: req.auth.uid, userCount: users.length }, 'Admin listed all users');
      return res.json({ users });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en GET /admin/users');
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // Admin: change user status (active/suspended/disabled)
  // ---------------------------
  router.put('/admin/users/:userId/status', conditionalAuth, conditionalRole('admin'), async (req, res) => {
    try {
      if (!req.userProfile || req.userProfile.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: admin role required' });
      }

      if (!db) {
        return res.status(503).json({ error: 'Firestore not available' });
      }

      const { userId } = req.params;
      const { status, reason } = req.body || {};

      const validStatuses = ['active', 'suspended', 'disabled'];
      if (!status || !validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status. Must be one of: active, suspended, disabled' });
      }

      // Prevent self-suspension
      if (userId === req.auth.uid && status !== 'active') {
        return res.status(400).json({ error: 'Cannot suspend or disable your own account' });
      }

      const userRef = db.collection('users').doc(userId);
      const snap = await userRef.get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'User not found' });
      }

      const updateData = {
        status,
        statusChangedAt: admin.firestore.FieldValue.serverTimestamp(),
        statusChangedBy: req.auth.uid
      };
      if (reason) {
        updateData.statusReason = reason;
      }

      await userRef.update(updateData);
      invalidateProfileCache(userId);

      // If suspending/disabling, clear their active session from Redis
      if (status !== 'active') {
        try {
          const manager = sessionManager.sessions.get(userId);
          if (manager && manager.isReady) {
            await manager.logout();
            sessionManager.sessions.delete(userId);
            logger.info({ adminUid: req.auth.uid, targetUserId: userId }, 'Admin disconnected user WhatsApp session (status change)');
          }
        } catch (sessionErr) {
          logger.warn({ adminUid: req.auth.uid, targetUserId: userId, err: sessionErr?.message }, 'Error disconnecting session during status change');
        }

        // Clear session guard token
        try {
          const { getRedis } = require('./redisClient');
          const redis = getRedis();
          if (redis && redis.status === 'ready') {
            await redis.del(`session:${userId}`);
          }
        } catch (redisErr) {
          logger.warn({ targetUserId: userId, err: redisErr?.message }, 'Error clearing Redis session during status change');
        }
      }

      logger.info({ adminUid: req.auth.uid, targetUserId: userId, status, reason }, 'Admin changed user status');

      const updated = (await userRef.get()).data();
      return res.json({
        success: true,
        user: {
          uid: userId,
          email: updated.email,
          status: updated.status,
          statusChangedAt: updated.statusChangedAt,
          statusReason: updated.statusReason || null
        }
      });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en PUT /admin/users/:userId/status');
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // Admin: change user role
  // ---------------------------
  router.put('/admin/users/:userId/role', conditionalAuth, conditionalRole('admin'), async (req, res) => {
    try {
      if (!req.userProfile || req.userProfile.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: admin role required' });
      }

      if (!db) {
        return res.status(503).json({ error: 'Firestore not available' });
      }

      const { userId } = req.params;
      const { role } = req.body || {};

      const validRoles = ['user', 'admin'];
      if (!role || !validRoles.includes(role)) {
        return res.status(400).json({ error: 'Invalid role. Must be one of: user, admin' });
      }

      // Prevent self-demotion
      if (userId === req.auth.uid && role !== 'admin') {
        return res.status(400).json({ error: 'Cannot remove admin role from your own account' });
      }

      const userRef = db.collection('users').doc(userId);
      const snap = await userRef.get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'User not found' });
      }

      await userRef.update({ role });
      invalidateProfileCache(userId);

      logger.info({ adminUid: req.auth.uid, targetUserId: userId, role }, 'Admin changed user role');

      const updated = (await userRef.get()).data();
      return res.json({
        success: true,
        user: {
          uid: userId,
          email: updated.email,
          role: updated.role
        }
      });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en PUT /admin/users/:userId/role');
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------
  // Admin: delete user completely
  // ---------------------------
  router.delete('/admin/users/:userId', conditionalAuth, conditionalRole('admin'), async (req, res) => {
    try {
      if (!req.userProfile || req.userProfile.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: admin role required' });
      }

      if (!db) {
        return res.status(503).json({ error: 'Firestore not available' });
      }

      const { userId } = req.params;

      // Prevent self-deletion
      if (userId === req.auth.uid) {
        return res.status(400).json({ error: 'Cannot delete your own account' });
      }

      const userRef = db.collection('users').doc(userId);
      const snap = await userRef.get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'User not found' });
      }

      const userData = snap.data();

      // Disconnect WhatsApp session if active
      try {
        const manager = sessionManager.sessions.get(userId);
        if (manager && manager.isReady) {
          await manager.logout();
          sessionManager.sessions.delete(userId);
        }
      } catch (sessionErr) {
        logger.warn({ targetUserId: userId, err: sessionErr?.message }, 'Error disconnecting session during user deletion');
      }

      // Clean up Redis data
      try {
        await redisQueue.cleanupUserData(userId, { keepAuth: false });
      } catch (redisErr) {
        logger.warn({ targetUserId: userId, err: redisErr?.message }, 'Error cleaning Redis data during user deletion');
      }

      // Delete from Firestore
      await userRef.delete();
      invalidateProfileCache(userId);

      // Optionally disable Firebase Auth account
      if (auth) {
        try {
          await auth.updateUser(userId, { disabled: true });
          logger.info({ targetUserId: userId }, 'Firebase Auth account disabled');
        } catch (authErr) {
          // User might not exist in Firebase Auth (e.g., dev mode)
          logger.warn({ targetUserId: userId, err: authErr?.message }, 'Could not disable Firebase Auth account');
        }
      }

      logger.info({ adminUid: req.auth.uid, targetUserId: userId, email: userData.email }, 'Admin deleted user');

      return res.json({
        success: true,
        message: 'User deleted successfully',
        deletedUser: {
          uid: userId,
          email: userData.email
        }
      });
    } catch (error) {
      logger.error({ err: error?.message, uid: req.auth?.uid }, 'Error en DELETE /admin/users/:userId');
      return res.status(500).json({ error: error.message });
    }
  });

  // ══════════════════════════════════════════════════════
  // TEMPLATES CRUD
  // ══════════════════════════════════════════════════════

  // Auto-create templates table if it doesn't exist
  const ensureTemplatesTable = (() => {
    let created = false;
    return async () => {
      if (created) return;
      const pg = require('./postgresClient');
      await pg.query(`
        CREATE TABLE IF NOT EXISTS templates (
          id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          name VARCHAR(255) NOT NULL,
          content TEXT NOT NULL,
          category VARCHAR(100),
          variables TEXT[],
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_templates_user ON templates(user_id);
      `);
      created = true;
    };
  })();

  // GET /templates — list all templates for the current user
  router.get('/templates', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      await ensureTemplatesTable();
      const userId = req.auth?.uid || 'default';
      const { category } = req.query || {};
      const pg = require('./postgresClient');

      let sql = 'SELECT * FROM templates WHERE user_id = $1';
      const params = [userId];

      if (category) {
        sql += ' AND category = $2';
        params.push(category);
      }

      sql += ' ORDER BY updated_at DESC';

      const result = await pg.query(sql, params);
      return res.json({ templates: result.rows });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /templates');
      return res.status(500).json({ error: error.message });
    }
  });

  // POST /templates — create a new template
  router.post('/templates', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      await ensureTemplatesTable();
      const userId = req.auth?.uid || 'default';
      const { name, content, category, variables } = req.body || {};

      if (!name || !content) {
        return res.status(400).json({ error: 'Nombre y contenido son requeridos' });
      }

      const pg = require('./postgresClient');
      const result = await pg.query(
        `INSERT INTO templates (user_id, name, content, category, variables)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [userId, name.trim(), content.trim(), category?.trim() || null, variables || null]
      );

      return res.json({ success: true, template: result.rows[0] });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en POST /templates');
      return res.status(500).json({ error: error.message });
    }
  });

  // PUT /templates/:id — update a template
  router.put('/templates/:id', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      await ensureTemplatesTable();
      const userId = req.auth?.uid || 'default';
      const { id } = req.params;
      const { name, content, category, variables } = req.body || {};

      if (!name || !content) {
        return res.status(400).json({ error: 'Nombre y contenido son requeridos' });
      }

      const pg = require('./postgresClient');
      const result = await pg.query(
        `UPDATE templates SET name = $1, content = $2, category = $3, variables = $4, updated_at = NOW()
         WHERE id = $5 AND user_id = $6
         RETURNING *`,
        [name.trim(), content.trim(), category?.trim() || null, variables || null, id, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Plantilla no encontrada' });
      }

      return res.json({ success: true, template: result.rows[0] });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en PUT /templates/:id');
      return res.status(500).json({ error: error.message });
    }
  });

  // DELETE /templates/:id — delete a template
  router.delete('/templates/:id', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      await ensureTemplatesTable();
      const userId = req.auth?.uid || 'default';
      const { id } = req.params;

      const pg = require('./postgresClient');
      const result = await pg.query(
        'DELETE FROM templates WHERE id = $1 AND user_id = $2 RETURNING id',
        [id, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Plantilla no encontrada' });
      }

      return res.json({ success: true });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en DELETE /templates/:id');
      return res.status(500).json({ error: error.message });
    }
  });

  // ══════════════════════════════════════════════════════
  // CHATBOT CONFIGURATION & FLOW
  // ══════════════════════════════════════════════════════

  const chatbotEngine = require('./chatbotEngine');

  // GET /chatbot/config — get user's chatbot config
  router.get('/chatbot/config', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      await chatbotEngine.ensureChatbotTables();
      const userId = req.auth?.uid || 'default';
      const pgClient = require('./postgresClient');

      const result = await pgClient.query(
        'SELECT * FROM chatbot_configs WHERE user_id = $1 LIMIT 1',
        [userId]
      );

      if (result.rows.length === 0) {
        return res.json({ config: null });
      }

      // Strip encrypted key from response
      const config = { ...result.rows[0] };
      config.ai_api_key_set = !!config.ai_api_key_encrypted;
      delete config.ai_api_key_encrypted;

      return res.json({ config });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /chatbot/config');
      return res.status(500).json({ error: error.message });
    }
  });

  // POST /chatbot/config — create initial config
  router.post('/chatbot/config', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      await chatbotEngine.ensureChatbotTables();
      const userId = req.auth?.uid || 'default';
      const pgClient = require('./postgresClient');

      // Check if config already exists
      const existing = await pgClient.query(
        'SELECT id FROM chatbot_configs WHERE user_id = $1 LIMIT 1',
        [userId]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Config already exists. Use PUT to update.' });
      }

      const {
        name, enabled, active_hours_start, active_hours_end, active_days,
        cooldown_minutes, only_known_contacts, max_responses_per_contact,
        ai_enabled, ai_provider, ai_api_key, ai_model, ai_system_prompt,
        welcome_message, fallback_message, bot_mode
      } = req.body || {};

      const encryptedKey = ai_api_key ? chatbotEngine.encrypt(ai_api_key) : null;

      const result = await pgClient.query(
        `INSERT INTO chatbot_configs
         (user_id, name, enabled, active_hours_start, active_hours_end, active_days,
          cooldown_minutes, only_known_contacts, max_responses_per_contact,
          ai_enabled, ai_provider, ai_api_key_encrypted, ai_model, ai_system_prompt,
          welcome_message, fallback_message, bot_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING *`,
        [
          userId,
          name || 'Mi Bot',
          enabled || false,
          active_hours_start || '08:00',
          active_hours_end || '22:00',
          active_days || [1,2,3,4,5],
          cooldown_minutes || 30,
          only_known_contacts !== undefined ? only_known_contacts : true,
          max_responses_per_contact || 5,
          ai_enabled || false,
          ai_provider || null,
          encryptedKey,
          ai_model || null,
          ai_system_prompt || null,
          welcome_message || null,
          fallback_message || 'No entendí tu mensaje. Escribí "menu" para ver las opciones.',
          bot_mode || 'flow',
        ]
      );

      chatbotEngine.invalidateConfigCache(userId);
      const config = { ...result.rows[0] };
      config.ai_api_key_set = !!config.ai_api_key_encrypted;
      delete config.ai_api_key_encrypted;

      return res.json({ success: true, config });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en POST /chatbot/config');
      return res.status(500).json({ error: error.message });
    }
  });

  // PUT /chatbot/config — update config
  router.put('/chatbot/config', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      await chatbotEngine.ensureChatbotTables();
      const userId = req.auth?.uid || 'default';
      const pgClient = require('./postgresClient');

      const {
        name, enabled, active_hours_start, active_hours_end, active_days,
        cooldown_minutes, only_known_contacts, max_responses_per_contact,
        ai_enabled, ai_provider, ai_api_key, ai_model, ai_system_prompt,
        welcome_message, fallback_message, exit_message, deactivation_message,
        start_node_id, activation_keywords, deactivation_keywords, bot_mode
      } = req.body || {};

      // Build dynamic SET clause
      const sets = [];
      const params = [];
      let idx = 1;

      function addField(col, val) {
        if (val !== undefined) {
          sets.push(`${col} = $${idx}`);
          params.push(val);
          idx++;
        }
      }

      addField('name', name);
      addField('enabled', enabled);
      addField('active_hours_start', active_hours_start);
      addField('active_hours_end', active_hours_end);
      addField('active_days', active_days);
      addField('cooldown_minutes', cooldown_minutes);
      addField('only_known_contacts', only_known_contacts);
      addField('max_responses_per_contact', max_responses_per_contact);
      addField('ai_enabled', ai_enabled);
      addField('ai_provider', ai_provider);
      addField('ai_model', ai_model);
      addField('ai_system_prompt', ai_system_prompt);
      addField('welcome_message', welcome_message);
      addField('fallback_message', fallback_message);
      addField('exit_message', exit_message);
      addField('deactivation_message', deactivation_message);
      addField('start_node_id', start_node_id);
      addField('activation_keywords', activation_keywords);
      addField('deactivation_keywords', deactivation_keywords);
      addField('bot_mode', bot_mode);

      // Handle API key specially (encrypt)
      if (ai_api_key !== undefined) {
        const encrypted = ai_api_key ? chatbotEngine.encrypt(ai_api_key) : null;
        sets.push(`ai_api_key_encrypted = $${idx}`);
        params.push(encrypted);
        idx++;
      }

      if (sets.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      params.push(userId);
      const result = await pgClient.query(
        `UPDATE chatbot_configs SET ${sets.join(', ')} WHERE user_id = $${idx} RETURNING *`,
        params
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Config not found. Use POST to create.' });
      }

      chatbotEngine.invalidateConfigCache(userId);
      const config = { ...result.rows[0] };
      config.ai_api_key_set = !!config.ai_api_key_encrypted;
      delete config.ai_api_key_encrypted;

      return res.json({ success: true, config });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en PUT /chatbot/config');
      return res.status(500).json({ error: error.message });
    }
  });

  // ── Flow nodes ──

  // GET /chatbot/nodes — get all nodes for user's chatbot
  router.get('/chatbot/nodes', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      await chatbotEngine.ensureChatbotTables();
      const userId = req.auth?.uid || 'default';
      const pgClient = require('./postgresClient');

      const configResult = await pgClient.query(
        'SELECT id FROM chatbot_configs WHERE user_id = $1 LIMIT 1',
        [userId]
      );
      if (configResult.rows.length === 0) {
        return res.json({ nodes: [] });
      }

      const configId = configResult.rows[0].id;
      const result = await pgClient.query(
        'SELECT * FROM chatbot_nodes WHERE config_id = $1 ORDER BY created_at',
        [configId]
      );

      return res.json({ nodes: result.rows, config_id: configId });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /chatbot/nodes');
      return res.status(500).json({ error: error.message });
    }
  });

  // POST /chatbot/nodes — create/update nodes (batch — send entire flow)
  router.post('/chatbot/nodes', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      await chatbotEngine.ensureChatbotTables();
      const userId = req.auth?.uid || 'default';
      const pgClient = require('./postgresClient');

      const configResult = await pgClient.query(
        'SELECT id FROM chatbot_configs WHERE user_id = $1 LIMIT 1',
        [userId]
      );
      if (configResult.rows.length === 0) {
        return res.status(404).json({ error: 'Chatbot config not found. Create config first.' });
      }

      const configId = configResult.rows[0].id;
      const { nodes } = req.body || {};

      if (!Array.isArray(nodes)) {
        return res.status(400).json({ error: 'nodes must be an array' });
      }

      // Use transaction: delete old nodes, insert new ones
      const result = await pgClient.transaction(async (client) => {
        await client.query('DELETE FROM chatbot_nodes WHERE config_id = $1', [configId]);

        const inserted = [];
        for (const node of nodes) {
          const r = await client.query(
            `INSERT INTO chatbot_nodes (config_id, node_id, type, content, position_x, position_y)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [
              configId,
              node.node_id,
              node.type,
              JSON.stringify(node.content || {}),
              node.position_x || 0,
              node.position_y || 0,
            ]
          );
          inserted.push(r.rows[0]);
        }
        return inserted;
      });

      chatbotEngine.invalidateNodesCache(configId);
      return res.json({ success: true, nodes: result });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en POST /chatbot/nodes');
      return res.status(500).json({ error: error.message });
    }
  });

  // DELETE /chatbot/nodes/:nodeId — delete a single node
  router.delete('/chatbot/nodes/:nodeId', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      await chatbotEngine.ensureChatbotTables();
      const userId = req.auth?.uid || 'default';
      const pgClient = require('./postgresClient');
      const { nodeId } = req.params;

      const configResult = await pgClient.query(
        'SELECT id FROM chatbot_configs WHERE user_id = $1 LIMIT 1',
        [userId]
      );
      if (configResult.rows.length === 0) {
        return res.status(404).json({ error: 'Chatbot config not found' });
      }

      const configId = configResult.rows[0].id;
      const result = await pgClient.query(
        'DELETE FROM chatbot_nodes WHERE id = $1 AND config_id = $2 RETURNING id',
        [nodeId, configId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Node not found' });
      }

      chatbotEngine.invalidateNodesCache(configId);
      return res.json({ success: true });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en DELETE /chatbot/nodes/:nodeId');
      return res.status(500).json({ error: error.message });
    }
  });

  // ── Conversations ──

  // GET /chatbot/conversations — list active conversations
  router.get('/chatbot/conversations', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      await chatbotEngine.ensureChatbotTables();
      const userId = req.auth?.uid || 'default';
      const pgClient = require('./postgresClient');

      const result = await pgClient.query(
        `SELECT * FROM chatbot_conversations
         WHERE user_id = $1
         ORDER BY updated_at DESC
         LIMIT 100`,
        [userId]
      );

      return res.json({ conversations: result.rows });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /chatbot/conversations');
      return res.status(500).json({ error: error.message });
    }
  });

  // PUT /chatbot/conversations/:phone/deactivate — manually deactivate bot for a contact
  router.put('/chatbot/conversations/:phone/deactivate', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      await chatbotEngine.ensureChatbotTables();
      const userId = req.auth?.uid || 'default';
      const { phone } = req.params;

      await chatbotEngine.deactivateConversation(userId, phone);
      return res.json({ success: true });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en PUT /chatbot/conversations/:phone/deactivate');
      return res.status(500).json({ error: error.message });
    }
  });

  // DELETE /chatbot/conversations/:phone — reset conversation
  router.delete('/chatbot/conversations/:phone', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      await chatbotEngine.ensureChatbotTables();
      const userId = req.auth?.uid || 'default';
      const { phone } = req.params;

      await chatbotEngine.resetConversation(userId, phone);
      return res.json({ success: true });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en DELETE /chatbot/conversations/:phone');
      return res.status(500).json({ error: error.message });
    }
  });

  // ══════════════════════════════════════════════════════
  // INBOX — Incoming messages
  // ══════════════════════════════════════════════════════

  // GET /messages/inbox — paginated conversations grouped by contact
  router.get('/messages/inbox', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      await chatbotEngine.ensureChatbotTables();
      const userId = req.auth?.uid || 'default';
      const pgClient = require('./postgresClient');
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
      const offset = (page - 1) * limit;

      const result = await pgClient.query(
        `SELECT
           im.contact_phone,
           COALESCE(c.nombre, MAX(im.contact_name)) AS contact_name,
           c.sustantivo AS tratamiento,
           c.grupo,
           MAX(im.created_at) AS last_message_at,
           COUNT(*) AS message_count,
           COUNT(*) FILTER (WHERE im.read = false AND im.is_from_contact = true) AS unread_count,
           (array_agg(im.message_text ORDER BY im.created_at DESC))[1] AS last_message
         FROM incoming_messages im
         LEFT JOIN contacts c ON c.user_id = im.user_id AND c.phone = im.contact_phone
         WHERE im.user_id = $1
         GROUP BY im.contact_phone, c.nombre, c.sustantivo, c.grupo
         ORDER BY MAX(im.created_at) DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      const countResult = await pgClient.query(
        `SELECT COUNT(DISTINCT contact_phone) AS total
         FROM incoming_messages WHERE user_id = $1`,
        [userId]
      );

      return res.json({
        conversations: result.rows,
        pagination: {
          page,
          limit,
          total: parseInt(countResult.rows[0]?.total || 0),
        },
      });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /messages/inbox');
      return res.status(500).json({ error: error.message });
    }
  });

  // GET /messages/inbox/unread — count of unread conversations
  router.get('/messages/inbox/unread', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      await chatbotEngine.ensureChatbotTables();
      const userId = req.auth?.uid || 'default';
      const pgClient = require('./postgresClient');

      const result = await pgClient.query(
        `SELECT COUNT(DISTINCT contact_phone) AS unread_conversations,
                COUNT(*) AS unread_messages
         FROM incoming_messages
         WHERE user_id = $1 AND read = false AND is_from_contact = true`,
        [userId]
      );

      return res.json({
        unread_conversations: parseInt(result.rows[0]?.unread_conversations || 0),
        unread_messages: parseInt(result.rows[0]?.unread_messages || 0),
      });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /messages/inbox/unread');
      return res.status(500).json({ error: error.message });
    }
  });

  // GET /messages/inbox/:phone — messages with a specific contact
  router.get('/messages/inbox/:phone', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      await chatbotEngine.ensureChatbotTables();
      const userId = req.auth?.uid || 'default';
      const pgClient = require('./postgresClient');
      const { phone } = req.params;
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
      const offset = (page - 1) * limit;

      // Mark messages as read
      await pgClient.query(
        `UPDATE incoming_messages SET read = true
         WHERE user_id = $1 AND contact_phone = $2 AND read = false AND is_from_contact = true`,
        [userId, phone]
      );

      const result = await pgClient.query(
        `SELECT * FROM incoming_messages
         WHERE user_id = $1 AND contact_phone = $2
         ORDER BY created_at DESC
         LIMIT $3 OFFSET $4`,
        [userId, phone, limit, offset]
      );

      return res.json({ messages: result.rows });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /messages/inbox/:phone');
      return res.status(500).json({ error: error.message });
    }
  });

  // POST /messages/inbox/:phone/reply — send reply (marks as human intervention)
  router.post('/messages/inbox/:phone/reply', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      await chatbotEngine.ensureChatbotTables();
      const userId = req.auth?.uid || 'default';
      const { phone } = req.params;
      const { message } = req.body || {};

      if (!message || !message.trim()) {
        return res.status(400).json({ error: 'Message is required' });
      }

      // Get WhatsApp session
      const manager = await sessionManager.getSession(userId);
      if (!manager || !manager.isReady || !manager.sock) {
        return res.status(503).json({ error: 'WhatsApp not connected' });
      }

      // Send via WhatsApp
      const jid = `${phone}@s.whatsapp.net`;
      await manager.sock.sendMessage(jid, { text: message.trim() });

      // Record as human intervention (deactivates bot for 30min for this contact)
      await chatbotEngine.recordOutgoingMessage(userId, phone, message.trim());

      return res.json({ success: true });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en POST /messages/inbox/:phone/reply');
      return res.status(500).json({ error: error.message });
    }
  });

  // GET /messages/inbox/:phone/bot-status — get bot status for a contact
  router.get('/messages/inbox/:phone/bot-status', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      const { phone } = req.params;
      const status = await chatbotEngine.getBotStatusForContact(userId, phone);
      return res.json(status);
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en GET /messages/inbox/:phone/bot-status');
      return res.status(500).json({ error: error.message });
    }
  });

  // PUT /messages/inbox/:phone/pause-bot — pause bot for a contact
  router.put('/messages/inbox/:phone/pause-bot', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      const { phone } = req.params;
      await chatbotEngine.pauseBotForContact(userId, phone);
      return res.json({ success: true, bot_paused: true });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en PUT /messages/inbox/:phone/pause-bot');
      return res.status(500).json({ error: error.message });
    }
  });

  // PUT /messages/inbox/:phone/resume-bot — resume bot for a contact
  router.put('/messages/inbox/:phone/resume-bot', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth?.uid || 'default';
      const { phone } = req.params;
      await chatbotEngine.resumeBotForContact(userId, phone);
      return res.json({ success: true, bot_paused: false });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en PUT /messages/inbox/:phone/resume-bot');
      return res.status(500).json({ error: error.message });
    }
  });

  // DELETE /messages/inbox/:phone — delete chat history from DB (not from WhatsApp)
  router.delete('/messages/inbox/:phone', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const userId = req.auth.uid;
      const phone = req.params.phone;
      if (!phone) return res.status(400).json({ error: 'Phone required' });

      const chatbotEngine = require('./chatbotEngine');
      await chatbotEngine.ensureChatbotTables();

      // Delete messages
      const pg = require('./postgresClient');
      const msgResult = await pg.query(
        'DELETE FROM incoming_messages WHERE user_id = $1 AND contact_phone = $2',
        [userId, phone]
      );

      // Delete conversation state
      await pg.query(
        'DELETE FROM chatbot_conversations WHERE user_id = $1 AND contact_phone = $2',
        [userId, phone]
      );

      logger.info({ userId, phone, deletedMessages: msgResult.rowCount }, 'Inbox chat deleted');
      return res.json({ success: true, deletedMessages: msgResult.rowCount });
    } catch (error) {
      logger.error({ err: error?.message, userId: req.auth?.uid }, 'Error en DELETE /messages/inbox/:phone');
      return res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { buildRoutes };
