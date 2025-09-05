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
  }

  // Obtener o crear sesión para un usuario
  async getSession(userId) {
    if (!this.sessions.has(userId)) {
      const sessionPath = path.join(this.baseSessionPath, `user-${userId}`);
      
      // Crear directorio si no existe
      await fs.mkdir(sessionPath, { recursive: true });
      
      const manager = new WhatsAppManager();
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
        await manager.initialize();
      }
      
      this.sessions.set(userId, manager);
      logger.info({ userId, sessionPath, hasActiveWhatsApp }, 'Nueva sesión creada para usuario');
    }
    
    return this.sessions.get(userId);
  }

  // Obtener sesión por token JWT (después de validar con Keycloak)
  async getSessionByToken(req) {
    const userId = req.auth?.sub || req.auth?.id; // Desde JWT de Keycloak
    if (!userId) {
      throw new Error('Usuario no autenticado');
    }
    
    return await this.getSession(userId);
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
        await manager.initialize();
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
}

// Singleton instance
module.exports = new SessionManager();