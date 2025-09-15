// src/manager.js
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const {
  default: makeWASocket,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { isAuthorizedPhone, publicDir } = require('./config');
const { MessageQueue } = require('./queue');
const logger = require('./logger');
const { getAuthState } = require('./auth');
const { getRedis } = require('./redisClient');

class WhatsAppManager {
  constructor(userId = 'default') {
    this.userId = userId;

    // Estado de conexión
    this.sock = null;
    this.isReady = false;
    this.connectionState = 'disconnected';
    this.lastDisconnectReason = null;
    this.isConnecting = false;
    this.connectionPromise = null;
    this.lastActivity = Date.now();

    // Autenticación (Baileys)
    this.authState = null;
    this.saveCreds = null;
    this.authPath = null; // ruta por-usuario: .../auth_info/user-<id>
    this._clearAuth = null; // cleanup function for current auth store

    // QR
    this.qrCode = null;
    this.lastQRUpdate = null;
    this.qrCaptureRequested = false;

    // Info de user
    this.userInfo = null;
    this.securityAlert = null;

    // Rate limiting y conflictos
    this.lastMessageTime = 0;
    this.messageCount = 0;
    this.maxMessagesPerMinute = 15;
    this.conflictCount = 0;
    this.lastConflictTime = 0;
    this.isInCooldown = false;

    // Cola de mensajes
    this.messageQueue = null;
  }

  // ========= Helpers internos =========

  _getAuthDir() {
    // Si ya setearon authPath, úsalo. Si no, por defecto: <publicDir>/../auth_info/user-<id>
    if (this.authPath) return this.authPath;
    const base = path.join(publicDir, '..', 'auth_info');
    return path.join(base, `user-${this.userId}`);
  }

  _getScopedUserId() {
    // Deriva userId desde el authPath si viene con "user-<id>"
    if (this.authPath) {
      const base = path.basename(this.authPath);
      if (base.startsWith('user-')) return base.replace('user-', '');
    }
    return this.userId;
  }

  _getUserQrPath() {
    const uid = this._getScopedUserId();
    const qrFileName = `qr-${uid}.png`;
    return path.join(publicDir, qrFileName);
  }

  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  updateActivity() {
    this.lastActivity = Date.now();
  }

  getState() {
    return {
      isReady: this.isReady,
      connectionState: this.connectionState,
      lastActivity: this.lastActivity,
      lastQRUpdate: this.lastQRUpdate || null,
      hasQR: !!this.qrCode,
      securityAlert: this.securityAlert || null,
      userInfo: this.userInfo || null,
    };
  }

  getConnectionHealth() {
    return {
      isReady: this.isReady,
      connectionState: this.connectionState,
      conflictCount: this.conflictCount,
      messageCount: this.messageCount,
      maxMessagesPerMinute: this.maxMessagesPerMinute,
      isInCooldown: this.isInCooldown,
      lastConflictTime: this.lastConflictTime,
      isConnecting: this.isConnecting,
      lastDisconnectReason: this.lastDisconnectReason,
      canSendMessages:
        this.isReady && !this.isInCooldown && this._checkRateLimit() && !this.isConnecting,
    };
  }

  // ========= QR helpers =========
  requestQrCapture() {
    this.qrCaptureRequested = true;
  }

  async captureQrToDisk(userId = null) {
    try {
      if (!this.qrCode) return false;
      const uid = userId || this._getScopedUserId();
      const qrFileName = `qr-${uid}.png`;
      const qrPath = path.join(publicDir, qrFileName);

      await qrcode.toFile(qrPath, this.qrCode, {
        color: { dark: '#128C7E', light: '#FFFFFF' },
        width: 300,
        margin: 1,
      });
      this.lastQRUpdate = Date.now();
      logger.info({ qrPath, userId: uid }, 'QR guardado (captura inmediata)');
      return true;
    } catch (e) {
      logger.error({ err: e?.message }, 'captureQrToDisk falló');
      return false;
    }
  }

  // ========= Inicialización =========

  async safeInitialize() {
    if (this.isConnecting) {
      logger.warn('Conexión ya en progreso, esperando...');
      if (this.connectionPromise) {
        try {
          await this.connectionPromise;
        } catch {
          // swallow
        }
      }
      return;
    }

    if (this.isInCooldown) {
      logger.warn('En cooldown, cancelando intento de conexión');
      return;
    }

    this.isConnecting = true;
    this.connectionPromise = this._initialize()
      .catch((err) => {
        logger.error({ err: err?.message }, 'Error en inicialización segura');
        throw err;
      })
      .finally(() => {
        this.isConnecting = false;
        this.connectionPromise = null;
      });

    return this.connectionPromise;
  }

  async _initialize() {
    if (this.sock) {
      logger.info('Socket ya inicializado, reutilizando...');
      return true;
    }

    try {
      // Auth por usuario
      const authDir = this._getAuthDir();
      this.authPath = authDir;
      if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
      }

      const { state, saveCreds, clear } = await getAuthState(this.userId, authDir);
      this.authState = state;
      this.saveCreds = saveCreds;
      this._clearAuth = typeof clear === 'function' ? clear : null;

      // Socket Baileys
      this.sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10_000,
        markOnlineOnConnect: false,
      });

      // expose manager to queue via socket reference
      this.sock.manager = this;

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // QR recibido
        if (qr) {
          this.qrCode = qr;
          this.connectionState = 'qr_ready';

          const qrPath = this._getUserQrPath();
          const shouldWrite = this.qrCaptureRequested || !fs.existsSync(qrPath);

          if (shouldWrite) {
            this.qrCaptureRequested = false;
            logger.info({ userId: this._getScopedUserId() }, 'QR Code recibido');
            await qrcode.toFile(qrPath, qr, {
              color: { dark: '#128C7E', light: '#FFFFFF' },
              width: 300,
              margin: 1,
            });
            logger.info({ qrPath }, 'QR guardado');
            this.lastQRUpdate = Date.now();
          }
          // Store QR in Redis for cross-pod availability if enabled
          if ((process.env.SESSION_STORE || 'file').toLowerCase() === 'redis') {
            try {
              const { setUserQr } = require('./stores/redisAuthState');
              await setUserQr(this._getScopedUserId(), qr);
            } catch {}
          }
        }

        if (connection === 'open') {
          logger.info('Conexión abierta');
          this.connectionState = 'connected';

          if (this.sock?.user) {
            const phoneNumber = this.sock.user.id.split(':')[0];
            const pushname = `Usuario ${phoneNumber}`;

            this.userInfo = {
              phoneNumber,
              pushname,
              jid: this.sock.user.id,
            };
            logger.info({ userInfo: this.userInfo }, 'Información del usuario obtenida');

            // Autorización de número
            if (!isAuthorizedPhone(phoneNumber)) {
              const alert = `¡ALERTA! Número no autorizado: ${phoneNumber}`;
              logger.warn({ phoneNumber }, 'Número no autorizado, desconectando...');
              this.securityAlert = {
                timestamp: Date.now(),
                messages: [alert, 'Desconectando...'],
                phoneNumber,
              };

              try {
                await this.sock.sendMessage(this.sock.user.id, {
                  text: 'Número no autorizado. Se cerrará la sesión.',
                });
              } catch {
                /* noop */
              }

              this.isReady = false;
              this.connectionState = 'unauthorized';

              setTimeout(async () => {
                try {
                  await this.sock?.logout();
                  this.sock = null;
                  await this._deleteSessionFilesCompletely();
                  setTimeout(() => this.safeInitialize(), 8_000);
                } catch {
                  /* noop */
                }
              }, 3_000);
              return;
            }

            // OK
            logger.info({ phoneNumber }, 'Número autorizado');
            this.isReady = true;
            this.lastActivity = Date.now();

            // borrar QR al conectar
            const qrPath = this._getUserQrPath();
            try {
              if (fs.existsSync(qrPath)) {
                fs.unlinkSync(qrPath);
                logger.info({ qrPath }, 'QR eliminado tras conexión exitosa');
              }
            } catch {
              /* noop */
            }
          }
        }

        if (connection === 'connecting') {
          logger.info('Conectando...');
          this.connectionState = 'connecting';
        }

        if (connection === 'close') {
          const shouldReconnect =
            lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          const reason = lastDisconnect?.error?.message;
          this.lastDisconnectReason = reason;

          logger.warn(
            {
              reason,
              shouldReconnect,
              userId: this._getScopedUserId(),
            },
            'Conexión cerrada'
          );

          this.isReady = false;
          this.connectionState = 'disconnected';
          this.userInfo = null;
          this.sock = null;
          this.isConnecting = false;

          // Timeout QR
          if (reason && reason.includes('QR refs attempts ended')) {
            logger.warn('Timeout de QR. Esperando antes de reconectar...');
            if (shouldReconnect) {
              setTimeout(() => {
                logger.info('Reintentando conexión tras QR timeout...');
                this.safeInitialize();
              }, 30_000);
            }
            return;
          }

          // Conflictos
          if (reason && reason.includes('conflict')) {
            this.conflictCount++;
            this.lastConflictTime = Date.now();

            logger.warn(
              `Conflicto detectado (#${this.conflictCount}). Estrategia de reconexión inteligente...`
            );

            const cooldownMinutes = Math.min(this.conflictCount * 2, 10);
            const cooldownMs = cooldownMinutes * 60 * 1000;
            this.isInCooldown = true;

            logger.info(`Entrando en cooldown por ${cooldownMinutes} minutos debido a conflicto`);
            setTimeout(() => {
              this.isInCooldown = false;
              logger.info('Cooldown terminado, intentando reconexión');
              this.safeInitialize();
            }, cooldownMs);

            return;
          }

          // Reintento normal
          if (shouldReconnect) {
            if (!reason || !reason.includes('conflict')) {
              this.conflictCount = Math.max(0, this.conflictCount - 1);
            }

            const baseDelay = 15_000;
            const conflictPenalty = this.conflictCount * 5_000;
            const totalDelay = baseDelay + conflictPenalty;

            setTimeout(() => {
              logger.info(
                `Reintentando conexión (delay: ${totalDelay}ms, conflictos previos: ${this.conflictCount})...`
              );
              this.safeInitialize();
            }, totalDelay);
          }
        }
      });

      // Cola de mensajes por usuario
      this.messageQueue = new MessageQueue(this.sock, this.userId);
      return true;
    } catch (e) {
      logger.error({ err: e?.message }, 'Error inicializando Baileys');
      return false;
    }
  }

  // ========= QR manual =========

  async refreshQR() {
    logger.info('Solicitando refrescar QR...');
    if (this.isReady) {
      logger.info('No se puede refrescar: ya autenticado');
      return false;
    }

    try {
      // cerrar socket si existe
      if (this.sock) {
        logger.info('Cerrando socket actual...');
        try {
          await this.sock.logout();
        } catch {
          /* noop */
        }
        this.sock = null;
      }

      // borrar QR previo
      const qrPath = this._getUserQrPath();
      try {
        if (fs.existsSync(qrPath)) {
          fs.unlinkSync(qrPath);
          logger.info({ qrPath }, 'QR anterior eliminado');
        }
      } catch {
        /* noop */
      }

      // reset estado y borrar sesión
      this.isReady = false;
      this.qrCode = null;
      this.connectionState = 'disconnected';
      this.userInfo = null;
      await this._deleteSessionFilesCompletely();

      // preparar compuerta para el próximo evento 'qr'
      this.requestQrCapture();

      await this._delay(2_000);
      logger.info({ userId: this._getScopedUserId() }, 'Inicializando nuevo socket...');
      await this.safeInitialize();
      logger.info({ userId: this._getScopedUserId() }, 'Nuevo socket inicializado, esperando QR...');
      return true;
    } catch (e) {
      logger.error({ err: e?.message }, 'Error al refrescar QR');
      return false;
    }
  }

  // ========= Rate limiting =========

  _checkRateLimit() {
    const now = Date.now();
    if (now - this.lastMessageTime > 60_000) {
      this.messageCount = 0;
    }
    return this.messageCount < this.maxMessagesPerMinute;
  }

  recordMessage() {
    const now = Date.now();
    this.lastMessageTime = now;
    this.messageCount++;
    logger.info(
      `Mensaje registrado: ${this.messageCount}/${this.maxMessagesPerMinute} en el último minuto`
    );
    if (this.messageCount >= this.maxMessagesPerMinute * 0.8) {
      logger.warn(
        `Cerca del límite de rate: ${this.messageCount}/${this.maxMessagesPerMinute} (último minuto)`
      );
    }
  }

  async waitForRateLimit() {
    const store = (process.env.SESSION_STORE || 'file').toLowerCase();
    if (store === 'redis') {
      try {
        const redis = getRedis();
        const key = `wa:rl:${this._getScopedUserId()}`;
        const count = await redis.incr(key);
        if (count === 1) {
          await redis.expire(key, 60);
        }
        if (count > this.maxMessagesPerMinute) {
          const ttl = await redis.ttl(key);
          const waitTime = Math.max(1, ttl) * 1000;
          logger.warn(`Rate limit distribuido alcanzado. Esperando ${Math.ceil(waitTime/1000)}s...`);
          await this._delay(waitTime);
        }
        return;
      } catch (e) {
        logger.warn({ err: e?.message }, 'Fallo rate-limit distribuido, usando local');
      }
    }
    // Local fallback
    if (!this._checkRateLimit()) {
      const waitTime = 60_000; // 1 min
      logger.warn(`Rate limit alcanzado. Esperando ${waitTime / 1000} segundos...`);
      await this._delay(waitTime);
      this.messageCount = 0;
    }
  }

  // ========= Limpieza de sesión (archivos) =========

  async _deleteSessionFilesCompletely() {
    try {
      logger.info('Eliminando estado de sesión...');
      const store = (process.env.SESSION_STORE || 'file').toLowerCase();

      if (store === 'redis' && this._clearAuth) {
        await this._clearAuth();
        this.authState = null;
        this.saveCreds = null;
        logger.info('Estado de sesión en Redis eliminado');
        return;
      }

      // Fallback: delete local files
      const sessionDir = this._getAuthDir();

      if (!fs.existsSync(sessionDir)) {
        logger.info('Directorio de sesiones no existe');
        return;
      }

      let deleted = 0;
      for (const entry of fs.readdirSync(sessionDir)) {
        const p = path.join(sessionDir, entry);
        try {
          const stat = fs.lstatSync(p);
          if (stat.isDirectory()) {
            await fs.promises.rm(p, { recursive: true, force: true });
            deleted++;
          } else {
            fs.unlinkSync(p);
            deleted++;
          }
        } catch (error) {
          logger.error({ p, err: error?.message }, 'Error eliminando archivo/directorio de sesión');
        }
      }

      // Intentar eliminar el directorio padre si quedó vacío
      try {
        if (fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length === 0) {
          fs.rmdirSync(sessionDir);
          deleted++;
        }
      } catch {
        /* noop */
      }

      // limpiar refs en memoria
      this.authState = null;
      this.saveCreds = null;

      logger.info({ deleted, sessionDir }, 'Archivos de sesión eliminados COMPLETAMENTE');
    } catch (error) {
      logger.error(`Error al eliminar archivos de sesión completamente: ${error.message}`);
      throw error;
    }
  }

  // Compat: alias del viejo nombre (si alguien lo llama)
  async deleteSessionFiles() {
    return this._deleteSessionFilesCompletely();
  }

  // ========= Logout(s) =========

  /**
   * Logout básico (limpia socket + estado + archivos de sesión)
   * Devuelve true si finaliza sin throw (aunque hubiese fallbacks).
   */
  async logout() {
    try {
      logger.info(`Cerrando sesión de WhatsApp para usuario ${this.userId}`);

      // marcar estado
      this.isReady = false;
      this.connectionState = 'logging_out';

      // si hay socket, intentar logout; fallback: end/ws.close
      if (this.sock) {
        try {
          logger.info('Enviando logout a WhatsApp...');
          await this.sock.logout();
          logger.info('Logout enviado exitosamente a WhatsApp');

          if (this.sock.ws) {
            try {
              this.sock.ws.close(1000, 'User logout');
            } catch (wsError) {
              logger.warn('Error cerrando WebSocket manualmente');
            }
          }
        } catch (logoutError) {
          logger.warn(`Error durante logout de WhatsApp: ${logoutError.message}`);
          logger.info('Intentando desconexión forzada...');
          try {
            if (this.sock.end && typeof this.sock.end === 'function') this.sock.end();
            if (this.sock.ws && this.sock.ws.close) this.sock.ws.close(1000, 'Forced logout');
          } catch {
            logger.warn('Error en desconexión forzada');
          }
        }
        this.sock = null;
      }

      // limpiar estado
      this.isReady = false;
      this.connectionState = 'disconnected';
      this.userInfo = null;
      this.qrCode = null;
      this.isConnecting = false;
      this.connectionPromise = null;

      // borrar sesión y QR
      await this._deleteSessionFilesCompletely();

      const qrPath = this._getUserQrPath();
      try {
        if (fs.existsSync(qrPath)) {
          fs.unlinkSync(qrPath);
          logger.info(`QR eliminado: ${qrPath}`);
        }
      } catch {
        /* noop */
      }

      logger.info(`Sesión de WhatsApp cerrada COMPLETAMENTE para usuario ${this.userId}`);
      return true;
    } catch (error) {
      logger.error(`Error durante logout completo: ${error.message}`, error);

      // forzar limpieza aun con error
      this.isReady = false;
      this.connectionState = 'disconnected';
      this.sock = null;
      await this._deleteSessionFilesCompletely();
      throw error;
    }
  }

  /**
   * Logout robusto: varios intentos + verificación + cleanup forzado si hace falta.
   */
  async robustLogout() {
    logger.info(`🚪 [${this.userId}] Iniciando logout robusto de WhatsApp...`);

    const maxAttempts = 3;
    const results = { success: false, attempts: [], finalState: null };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logger.info(`🔄 [${this.userId}] Intento de logout ${attempt}/${maxAttempts}`);
      try {
        const attemptResult = await this._performLogoutAttempt(attempt);
        results.attempts.push(attemptResult);

        const stateCheck = await this.verifyLogoutState();
        if (stateCheck.fullyDisconnected) {
          logger.info(`✅ [${this.userId}] Logout exitoso en intento ${attempt}`);
          results.success = true;
          results.finalState = stateCheck;
          break;
        }

        logger.warn(`⚠️ [${this.userId}] Intento ${attempt} incompleto, reintentando...`);
        await this._delay(2000 * attempt);
      } catch (error) {
        logger.error(`❌ [${this.userId}] Error en intento ${attempt}: ${error.message}`);
        results.attempts.push({ attempt, error: error.message, success: false });
        if (attempt < maxAttempts) await this._delay(3000 * attempt);
      }
    }

    // Verificación final
    results.finalState = await this.verifyLogoutState();

    if (!results.success) {
      logger.warn(`🔧 [${this.userId}] Logout robusto falló, aplicando limpieza forzada...`);
      await this.forceCleanup();
      results.finalState = await this.verifyLogoutState();
    }

    logger.info(`🎯 [${this.userId}] Logout robusto completado`);
    return results;
  }

  async _performLogoutAttempt(attemptNumber) {
    const result = { attempt: attemptNumber, steps: [], success: false };
    try {
      const logoutResult = await this.logout();
      result.steps.push('base_logout_executed');
      result.success = !!logoutResult;

      // Si por algún motivo todavía hay socket, intentar matar ws
      if (this.sock) {
        try {
          if (this.sock.ws && this.sock.ws.readyState === 1) {
            this.sock.ws.terminate?.();
            result.steps.push('websocket_terminated');
          }
        } catch {
          result.steps.push('websocket_error');
        }
        this.sock = null;
        result.steps.push('socket_nullified');
      }

      return result;
    } catch (error) {
      result.error = error.message;
      result.steps.push('attempt_failed');
      return result;
    }
  }

  /**
   * Verifica que la sesión esté completamente cerrada.
   */
  async verifyLogoutState() {
    const state = {
      socketNull: this.sock === null,
      notReady: !this.isReady,
      disconnectedState: this.connectionState === 'disconnected',
      noUserInfo: this.userInfo === null,
      filesClean: false,
      qrClean: false,
      fullyDisconnected: false,
    };

    // archivos de sesión
    try {
      const authDir = this._getAuthDir();
      const credsPath = path.join(authDir, 'creds.json');
      state.filesClean = !fs.existsSync(credsPath);
    } catch (error) {
      logger.warn(`⚠️ [${this.userId}] Error verificando archivos: ${error.message}`);
      state.filesClean = true;
    }

    // qr
    try {
      const qrPath = this._getUserQrPath();
      state.qrClean = !fs.existsSync(qrPath);
    } catch {
      state.qrClean = true;
    }

    state.fullyDisconnected =
      state.socketNull &&
      state.notReady &&
      state.disconnectedState &&
      state.noUserInfo &&
      state.filesClean &&
      state.qrClean;

    return state;
  }

  /**
   * Limpieza forzada (sin depender de logout).
   * Verifica y elimina: socket, estado, auth files, QR.
   */
  async forceCleanup() {
    logger.warn(`🔨 [${this.userId}] Aplicando limpieza forzada...`);
    try {
      // socket
      if (this.sock) {
        try {
          this.sock.ws?.terminate?.();
        } catch {
          /* noop */
        }
        try {
          if (this.sock.end && typeof this.sock.end === 'function') this.sock.end();
        } catch {
          /* noop */
        }
        this.sock = null;
      }

      // estado
      this.isReady = false;
      this.connectionState = 'disconnected';
      this.userInfo = null;
      this.qrCode = null;
      this.isConnecting = false;
      this.connectionPromise = null;

      // archivos de sesión
      await this._deleteSessionFilesCompletely();

      // qr
      const qrPath = this._getUserQrPath();
      try {
        if (fs.existsSync(qrPath)) {
          fs.unlinkSync(qrPath);
          logger.info(`🗑️ [${this.userId}] QR eliminado forzadamente`);
        }
      } catch {
        /* noop */
      }

      logger.info(`✅ [${this.userId}] Limpieza forzada completada`);
    } catch (error) {
      logger.error(`❌ [${this.userId}] Error en limpieza forzada: ${error.message}`);
    }
  }

  /**
   * Desconexión rápida sin logout (emergencias).
   */
  async forceDisconnect() {
    try {
      logger.info(`Forzando desconexión para usuario ${this.userId}`);
      if (this.sock) {
        try {
          if (this.sock.end && typeof this.sock.end === 'function') this.sock.end();
        } catch (error) {
          logger.warn(`Error en force disconnect: ${error.message}`);
        }
        this.sock = null;
      }

      this.isReady = false;
      this.connectionState = 'disconnected';
      this.userInfo = null;
      this.qrCode = null;
      this.isConnecting = false;
      this.connectionPromise = null;

      await this._deleteSessionFilesCompletely();
      logger.info(`Desconexión forzada completada para usuario ${this.userId}`);
      return true;
    } catch (error) {
      logger.error(`Error durante desconexión forzada: ${error.message}`);
      return false;
    }
  }
}

module.exports = { WhatsAppManager };
