// src/sessionManager.js
const { WhatsAppManager } = require('./manager');
const path = require('path');
const fs = require('fs').promises;
const logger = require('./logger');

class SessionManager {
  constructor() {
    this.sessions = new Map(); // userId -> WhatsAppManager instance
    this.userSessions = new Map(); // Para mapear tokens a userIds
    this.baseSessionPath = path.join(__dirname, '..', 'bot_sessions');
    this.creatingSession = new Map(); // Para evitar creación concurrente
  }

  // Obtener o crear sesión para un usuario
  async getSession(userId) {
    // Si ya existe la sesión, devolverla inmediatamente
    if (this.sessions.has(userId)) {
      return this.sessions.get(userId);
    }
    
    // Si ya se está creando esta sesión, esperar a que termine
    if (this.creatingSession.has(userId)) {
      await this.creatingSession.get(userId);
      return this.sessions.get(userId);
    }
    
    // Crear promesa para bloquear otras llamadas concurrentes
    const creationPromise = this.createSession(userId);
    this.creatingSession.set(userId, creationPromise);
    
    try {
      await creationPromise;
      return this.sessions.get(userId);
    } finally {
      this.creatingSession.delete(userId);
    }
  }
  
  async createSession(userId) {
    const sessionPath = path.join(this.baseSessionPath, `user-${userId}`);
    
    // Crear directorio si no existe
    await fs.mkdir(sessionPath, { recursive: true });
    
    const manager = new WhatsAppManager(userId);
    // Modificar la ruta de autenticación para este usuario específico
    manager.authPath = sessionPath;
    
    // Verificar que no hay otra sesión activa para este usuario
    const existingSessions = Array.from(this.sessions.values());
    const hasActiveWhatsApp = existingSessions.some(m => m.isReady);
    
    if (hasActiveWhatsApp) {
      logger.warn({ userId }, 'Ya hay una sesión de WhatsApp activa, creando sesión sin inicializar');
      // No inicializar automáticamente para evitar conflictos
    } else {
      // Inicializar la sesión solo si no hay otras activas
      await manager.safeInitialize();
    }
    
    this.sessions.set(userId, manager);
    logger.info({ userId, sessionPath, hasActiveWhatsApp }, 'Nueva sesión creada para usuario');
  }

  // Obtener sesión por token JWT (después de validar con Keycloak)
  async getSessionByToken(req) {
    const userId = req.auth?.sub || req.auth?.id; // Desde JWT de Keycloak
    
    logger.info('Getting session by token', {
      userId,
      userName: req.auth?.name || req.auth?.preferred_username,
      email: req.auth?.email,
      authPresent: !!req.auth,
      availableFields: Object.keys(req.auth || {})
    });
    
    if (!userId) {
      logger.error('Usuario no autenticado - no se encontró userId en token', {
        auth: req.auth
      });
      throw new Error('Usuario no autenticado');
    }
    
    const session = await this.getSession(userId);
    
    logger.info('Session obtained for user', {
      userId,
      sessionExists: !!session,
      isReady: session?.getState()?.isReady
    });
    
    return session;
  }

  // Listar sesiones activas
  getActiveSessions() {
    const active = [];
    for (const [userId, manager] of this.sessions) {
      const state = manager.getState();
      active.push({
        userId,
        isReady: state.isReady,
        connectionState: state.connectionState,
        userInfo: state.userInfo,
        lastActivity: state.lastActivity,
        hasQR: state.hasQR
      });
    }
    return active;
  }

  // Cerrar sesión específica
  async closeSession(userId) {
    const manager = this.sessions.get(userId);
    if (manager) {
      try {
        if (manager.sock) {
          await manager.sock.logout();
        }
        this.sessions.delete(userId);
        logger.info({ userId }, 'Sesión cerrada para usuario');
      } catch (error) {
        logger.error({ userId, error: error.message }, 'Error cerrando sesión');
      }
    }
  }

  // Inicializar una sesión específica (para cuando no hay conflictos)
  async initializeSession(userId) {
    const manager = this.sessions.get(userId);
    if (manager && !manager.sock) {
      try {
        await manager.safeInitialize();
        logger.info({ userId }, 'Sesión inicializada manualmente');
        return true;
      } catch (error) {
        logger.error({ userId, error: error.message }, 'Error inicializando sesión');
        return false;
      }
    }
    return false;
  }

  // Obtener estadísticas generales
  getStats() {
    const sessions = this.getActiveSessions();
    return {
      totalSessions: sessions.length,
      readySessions: sessions.filter(s => s.isReady).length,
      connectingSessions: sessions.filter(s => s.connectionState === 'connecting').length,
      qrPendingSessions: sessions.filter(s => s.connectionState === 'qr_ready').length,
      sessions: sessions
    };
  }

  // Limpiar sesiones inactivas (más de 24 horas sin actividad)
  cleanupInactiveSessions(maxInactiveHours = 24) {
    const now = Date.now();
    const maxInactiveMs = maxInactiveHours * 60 * 60 * 1000;
    
    for (const [userId, manager] of this.sessions) {
      const state = manager.getState();
      if (now - state.lastActivity > maxInactiveMs) {
        logger.info({ userId, hoursInactive: (now - state.lastActivity) / (60 * 60 * 1000) }, 'Cerrando sesión inactiva');
        this.closeSession(userId);
      }
    }
  }

  // Cerrar sesión de WhatsApp para un usuario específico
  async logoutUser(userId) {
    try {
      logger.info(`Iniciando logout de WhatsApp para usuario: ${userId}`);
      
      const manager = this.sessions.get(userId);
      if (!manager) {
        logger.info(`No hay sesión activa para usuario: ${userId}`);
        return { success: true, message: 'No había sesión activa' };
      }

      // Llamar al método logout del manager
      await manager.logout();
      
      // Remover la sesión del mapa
      this.sessions.delete(userId);
      
      logger.info(`Logout completado para usuario: ${userId}`);
      return { success: true, message: 'Sesión de WhatsApp cerrada exitosamente' };
      
    } catch (error) {
      logger.error(`Error durante logout de usuario ${userId}: ${error.message}`, error);
      
      // Limpiar sesión aunque haya errores
      if (this.sessions.has(userId)) {
        try {
          const manager = this.sessions.get(userId);
          await manager.forceDisconnect();
        } catch (forceError) {
          logger.error(`Error en force disconnect: ${forceError.message}`);
        }
        this.sessions.delete(userId);
      }
      
      return { success: false, message: error.message };
    }
  }

  // Logout por token JWT
  async logoutByToken(req) {
    const userId = req.auth?.sub || req.auth?.id;
    
    if (!userId) {
      throw new Error('Usuario no autenticado');
    }
    
    logger.info(`Logout solicitado por token para usuario: ${userId}`);
    return await this.logoutUser(userId);
  }
}

// Singleton instance
module.exports = new SessionManager();