const fs = require('fs');
const path = require('path');
const express = require('express');
const { upload } = require('./media');
const { cleanupOldFiles, loadNumbersFromCSV } = require('./utils');
const { publicDir, retentionHours } = require('./config');
const logger = require('./logger');
const { checkJwt, requireRole } = require('./auth');
const sessionManager = require('./sessionManager');

// Map para rastrear operaciones de refresh-qr en progreso por usuario
const qrRefreshInProgress = new Map();

// Middleware condicional para desarrollo
const conditionalAuth = (req, res, next) => {
  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  if (isDevelopment) {
    // En desarrollo, simular usuario autenticado
    req.auth = { 
      sub: 'dev-user-001',
      name: 'Usuario Desarrollo',
      preferred_username: 'dev-user',
      email: 'dev@test.com'
    };
    req.userRoles = { all: ['sender_api'], realmRoles: [], clientRoles: ['sender_api'] };
    return next();
  }
  
  // En producción, usar autenticación real
  return checkJwt(req, res, next);
};

const conditionalRole = (role) => (req, res, next) => {
  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  if (isDevelopment) {
    return next(); // En desarrollo, omitir verificación de roles
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
      
      const resp = {
        status: s.connectionState,
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
      
      if (!req.files || !req.files['csvFile']) {
        return res.status(400).json({ error: 'Archivo CSV no proporcionado' });
      }

      const csvFilePath = req.files['csvFile'][0].path;
      const images = req.files['images'];
      const singleImage = req.files['singleImage'] ? req.files['singleImage'][0] : null;
      const audioFile = req.files['audioFile'] ? req.files['audioFile'][0] : null;
      const { message } = req.body;

      const numbers = await loadNumbersFromCSV(csvFilePath);
      if (numbers.length === 0) return res.status(400).json({ error: 'No se encontraron números válidos' });

      whatsappManager.updateActivity();
      await whatsappManager.messageQueue.add(numbers, message, images, singleImage, audioFile);

      res.json({ 
        status: 'success', 
        message: 'Procesando mensajes', 
        totalNumbers: numbers.length, 
        userId: req.auth?.sub,
        initialStats: whatsappManager.messageQueue.getStats() 
      });
    } catch (error) {
      logger.error({ err: error?.message }, 'Error en /send-messages');
      res.status(500).json({ error: error.message });
    } finally {
      // Limpiar todos los archivos subidos, incluidos los de audio en caso de error
      if (req.files) {
        Object.entries(req.files).forEach(([fieldName, files]) => {
          for (const f of files) {
            try {
              if (fs.existsSync(f.path)) {
                fs.unlinkSync(f.path);
                logger.info(`Archivo temporal eliminado: ${f.path}`);
              }
            } catch (cleanupError) {
              logger.warn(`Error al eliminar archivo temporal: ${f.path} - ${cleanupError.message}`);
            }
          }
        });
      }
    }
  });

  router.get('/message-status', conditionalAuth, conditionalRole('sender_api'), async (req, res) => {
    try {
      const whatsappManager = await sessionManager.getSessionByToken(req);
      if (!whatsappManager.messageQueue) {
        return res.json({ total: 0, sent: 0, errors: 0, messages: [], completed: true });
      }
      res.json(whatsappManager.messageQueue.getStats());
    } catch (error) {
      logger.error({ err: error?.message }, 'Error en /message-status');
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/qr', conditionalAuth, async (req, res) => {
    try {
      const userId = req.auth?.sub;
      if (!userId) {
        return res.status(401).json({ error: 'Usuario no autenticado' });
      }
      
      // Verificar que el manager del usuario esté disponible
      const whatsappManager = await sessionManager.getSessionByToken(req);
      
      // Si no hay socket, intentar inicializar
      if (!whatsappManager.sock) {
        const initialized = await sessionManager.initializeSession(userId);
        if (!initialized) {
          return res.status(500).json({ 
            error: 'No se pudo inicializar la sesión de WhatsApp',
            userId: userId
          });
        }
        // Esperar un poco para que se genere el QR
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      if (whatsappManager.isReady) {
        return res.status(400).json({ error: 'Ya estás conectado a WhatsApp' });
      }
      
      const qrFileName = `qr-${userId}.png`;
      const qrPath = path.join(publicDir, qrFileName);
      
      if (fs.existsSync(qrPath)) {
        res.sendFile(qrPath);
      } else {
        res.status(404).json({ 
          error: 'QR no disponible para este usuario. Solicita un nuevo QR.',
          userId: userId
        });
      }
    } catch (error) {
      logger.error({ err: error?.message }, 'Error en /qr');
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
          qrUrl: `/qr-${userId}.png`
        });
      }

      // Plan B: regenerar QR si no hay uno en memoria
      const ok = await whatsappManager.refreshQR();
      if (ok) {
        qrRefreshInProgress.delete(userId); // Limpiar al completar exitosamente
        return res.json({ 
          success: true, 
          message: 'Solicitando nuevo código QR...',
          qrUrl: `/qr-${userId}.png`
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

  return router;
}

module.exports = { buildRoutes };