// src/manager.js
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState,
  downloadContentFromMessage,
  generateWAMessageFromContent,
  proto,
  prepareWAMessageMedia,
  MediaType
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { isAuthorizedPhone, publicDir } = require('./config');
const { MessageQueue } = require('./queue');
const logger = require('./logger');

class WhatsAppManager {
  constructor(userId = 'default') {
    this.userId = userId;
    this.sock = null;
    this.isReady = false;
    this.qrCode = null;
    this.connectionState = 'disconnected';
    this.lastActivity = Date.now();
    this.messageQueue = null;
    this.lastQRUpdate = null;
    this.securityAlert = null;
    this.userInfo = null;
    this.authState = null;
    this.saveCreds = null;
    this.authPath = null; // Ruta personalizable para autenticación
    
    // Rate limiting y control de conflictos
    this.lastMessageTime = 0;
    this.messageCount = 0;
    this.maxMessagesPerMinute = 15; // Límite más conservador
    this.conflictCount = 0;
    this.lastConflictTime = 0;
    this.isInCooldown = false;
    
    // Mutex para prevenir conexiones concurrentes
    this.isConnecting = false;
    this.connectionPromise = null;
    this.lastDisconnectReason = null;

    // Comp. para controlar cuándo guardar el PNG
    this.qrCaptureRequested = false;
  }

  getState() {
    return {
      isReady: this.isReady,
      connectionState: this.connectionState,
      lastActivity: this.lastActivity,
      lastQRUpdate: this.lastQRUpdate || null,
      hasQR: !!this.qrCode,
      securityAlert: this.securityAlert || null,
      userInfo: this.userInfo || null
    };
  }

  updateActivity() { this.lastActivity = Date.now(); }

  deleteSessionFiles() {
    try {
      logger.info('Eliminando archivos de sesión...');
      const sessionDir = this.authPath || path.join(publicDir, '..', 'auth_info');
      if (!fs.existsSync(sessionDir)) return logger.info('Directorio de sesiones no encontrado');

      let deleted = 0;
      for (const f of fs.readdirSync(sessionDir)) {
        const p = path.join(sessionDir, f);
        try {
          if (fs.lstatSync(p).isDirectory()) {
            for (const sf of fs.readdirSync(p)) {
              fs.unlinkSync(path.join(p, sf));
              deleted++;
            }
            fs.rmdirSync(p);
          } else {
            fs.unlinkSync(p);
            deleted++;
          }
        } catch (e) {
          logger.error({ p, err: e?.message }, 'Error eliminando archivo de sesión');
        }
      }
      logger.info({ deleted, sessionDir }, 'Archivos de sesión eliminados');
    } catch (e) {
      logger.error({ err: e?.message }, 'Error al eliminar archivos de sesión');
    }
  }

  // ===== Comp. QR: API para la ruta /refresh-qr =====
  requestQrCapture() {
    this.qrCaptureRequested = true;
  }

  async captureQrToDisk(userId = null) {
    try {
      if (!this.qrCode) return false;
      
      // Si tenemos un userId, crear QR específico para ese usuario
      const qrFileName = userId ? `qr-${userId}.png` : 'qr.png';
      const qrPath = path.join(publicDir, qrFileName);
      
      await qrcode.toFile(qrPath, this.qrCode, {
        color: { dark: '#128C7E', light: '#FFFFFF' },
        width: 300,
        margin: 1
      });
      this.lastQRUpdate = Date.now();
      logger.info({ qrPath, userId }, 'QR guardado (captura inmediata)');
      return true;
    } catch (e) {
      logger.error({ err: e?.message }, 'captureQrToDisk falló');
      return false;
    }
  }

  // Método seguro para inicializar que evita conexiones concurrentes
  async safeInitialize() {
    // Si ya hay una conexión en progreso, esperar a que termine
    if (this.isConnecting) {
      logger.warn('Conexión ya en progreso, esperando...');
      if (this.connectionPromise) {
        try {
          await this.connectionPromise;
        } catch (err) {
          logger.warn('Conexión anterior falló, continuando con nueva conexión');
        }
      }
      return;
    }

    // Si está en cooldown, no conectar
    if (this.isInCooldown) {
      logger.warn('En cooldown, cancelando intento de conexión');
      return;
    }

    // Marcar como conectando y guardar promesa
    this.isConnecting = true;
    this.connectionPromise = this.initialize()
      .catch(err => {
        logger.error({ err: err?.message }, 'Error en inicialización segura');
        throw err;
      })
      .finally(() => {
        this.isConnecting = false;
        this.connectionPromise = null;
      });

    return this.connectionPromise;
  }

  async initialize() {
    if (this.sock) {
      logger.info('Socket ya inicializado, reutilizando...');
      return true;
    }

    try {
      // Configurar autenticación
      const authDir = this.authPath || path.join(publicDir, '..', 'auth_info');
      if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      this.authState = state;
      this.saveCreds = saveCreds;

      // Crear socket
      this.sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }), // Logger compatible con Baileys
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000,
        markOnlineOnConnect: false
      });

      // Event handlers
      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.qrCode = qr;
          this.connectionState = 'qr_ready';

          // Obtener userId desde authPath si está disponible
          const userId = this.authPath ? path.basename(this.authPath).replace('user-', '') : null;
          const qrFileName = userId ? `qr-${userId}.png` : 'qr.png';
          const qrPath = path.join(publicDir, qrFileName);
          
          const shouldWrite = this.qrCaptureRequested || !fs.existsSync(qrPath);

          if (shouldWrite) {
            this.qrCaptureRequested = false;
            logger.info({ userId }, 'QR Code recibido');
            await qrcode.toFile(qrPath, qr, {
              color: { dark: '#128C7E', light: '#FFFFFF' },
              width: 300,
              margin: 1
            });
            logger.info({ qrPath, userId }, 'QR guardado');
            this.lastQRUpdate = Date.now();
          }
        }

        if (connection === 'close') {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          const reason = lastDisconnect?.error?.message;
          
          this.lastDisconnectReason = reason;
          
          logger.warn({ 
            reason,
            shouldReconnect,
            userId: this.authPath ? path.basename(this.authPath).replace('user-', '') : null
          }, 'Conexión cerrada');
          
          this.isReady = false;
          this.connectionState = 'disconnected';
          this.userInfo = null;
          this.sock = null;
          this.isConnecting = false; // Reset mutex

          // Manejar diferentes tipos de desconexión
          if (reason && reason.includes('QR refs attempts ended')) {
            logger.warn('Sesión cerrada por timeout de QR. Esperando antes de reconectar...');
            // QR timeout - esperar más tiempo antes de reconectar
            if (shouldReconnect) {
              setTimeout(() => {
                logger.info('Reintentando conexión tras QR timeout...');
                this.safeInitialize();
              }, 30000); // 30 segundos para QR timeout
            }
            return;
          }

          // Evitar reconexión en caso de conflictos
          if (reason && reason.includes('conflict')) {
            this.conflictCount++;
            this.lastConflictTime = Date.now();
            
            logger.warn(`Conflicto detectado (#${this.conflictCount}). Implementando estrategia de reconexión inteligente`);
            
            // Cooldown escalado basado en número de conflictos
            const cooldownMinutes = Math.min(this.conflictCount * 2, 10); // Máximo 10 minutos
            const cooldownMs = cooldownMinutes * 60 * 1000;
            
            this.isInCooldown = true;
            
            logger.info(`Entrando en cooldown por ${cooldownMinutes} minutos debido a conflicto`);
            
            setTimeout(() => {
              this.isInCooldown = false;
              logger.info('Cooldown terminado, intentando reconexión después de conflicto');
              this.safeInitialize();
            }, cooldownMs);
            
            return;
          }

          if (shouldReconnect) {
            // Reset contador de conflictos en desconexiones normales
            if (!reason || !reason.includes('conflict')) {
              this.conflictCount = Math.max(0, this.conflictCount - 1);
            }
            
            // Delay más largo para evitar conflictos, escalado si hay historial de conflictos
            const baseDelay = 15000; // 15 segundos base
            const conflictPenalty = this.conflictCount * 5000; // 5 segundos adicionales por conflicto previo
            const totalDelay = baseDelay + conflictPenalty;
            
            setTimeout(() => {
              logger.info(`Reintentando conexión (delay: ${totalDelay}ms, conflictos previos: ${this.conflictCount})...`);
              this.safeInitialize();
            }, totalDelay);
          }
        } else if (connection === 'open') {
          logger.info('Conexión abierta');
          this.connectionState = 'connected';

          // Obtener información del usuario
          if (this.sock?.user) {
            const phoneNumber = this.sock.user.id.split(':')[0];
            
            // Log para ver qué propiedades están disponibles
            logger.info({ userObject: this.sock.user }, 'Propiedades disponibles del usuario');
            
            // Establecer información básica del usuario
            // En Baileys, el pushname se obtiene mejor desde mensajes o contactos
            // Por ahora usamos el número como identificador principal
            const pushname = `Usuario ${phoneNumber}`;
            
            this.userInfo = {
              phoneNumber: phoneNumber,
              pushname: pushname,
              jid: this.sock.user.id
            };
            logger.info({ userInfo: this.userInfo }, 'Información del usuario obtenida');

            // Verificar si está autorizado
            if (!isAuthorizedPhone(phoneNumber)) {
              const alert = `¡ALERTA! Número no autorizado: ${phoneNumber}`;
              logger.warn({ phoneNumber }, 'Número no autorizado, desconectando...');
              this.securityAlert = { 
                timestamp: Date.now(), 
                messages: [alert, 'Desconectando...'], 
                phoneNumber 
              };
              
              // Enviar mensaje de advertencia y desconectar
              try {
                await this.sock.sendMessage(this.sock.user.id, { 
                  text: 'Número no autorizado. Se cerrará la sesión.' 
                });
              } catch {}
              
              this.isReady = false;
              this.connectionState = 'unauthorized';
              
              setTimeout(async () => {
                try {
                  await this.sock?.logout();
                  this.sock = null;
                  this.deleteSessionFiles();
                  setTimeout(() => this.initialize(), 8000);
                } catch {}
              }, 3000);
              return;
            }

            logger.info({ phoneNumber }, 'Número autorizado');
            this.isReady = true;
            this.lastActivity = Date.now();
            
            // Eliminar QR una vez conectado (específico del usuario)
            const userId = this.authPath ? path.basename(this.authPath).replace('user-', '') : null;
            const qrFileName = userId ? `qr-${userId}.png` : 'qr.png';
            const qrPath = path.join(publicDir, qrFileName);
            
            try { 
              if (fs.existsSync(qrPath)) {
                fs.unlinkSync(qrPath); 
                logger.info({ userId, qrPath }, 'QR eliminado tras conexión exitosa');
              }
            } catch {}
          }
        } else if (connection === 'connecting') {
          logger.info('Conectando...');
          this.connectionState = 'connecting';
        }
      });

      // Configurar cola de mensajes con userId
      this.messageQueue = new MessageQueue(this.sock, this.userId);
      
      return true;
    } catch (e) {
      logger.error({ err: e?.message }, 'Error inicializando Baileys');
      return false;
    }
  }

  async refreshQR() {
    logger.info('Solicitando refrescar QR...');
    if (this.isReady) { 
      logger.info('No se puede refrescar: ya autenticado'); 
      return false; 
    }

    try {
      if (this.sock) {
        logger.info('Cerrando socket actual...');
        try { 
          await this.sock.logout(); 
        } catch {}
        this.sock = null;
      }

      // Eliminar QR específico del usuario
      const userId = this.authPath ? path.basename(this.authPath).replace('user-', '') : null;
      const qrFileName = userId ? `qr-${userId}.png` : 'qr.png';
      const qrPath = path.join(publicDir, qrFileName);
      
      try { 
        if (fs.existsSync(qrPath)) {
          fs.unlinkSync(qrPath); 
          logger.info({ userId, qrPath }, 'QR anterior eliminado'); 
        }
      } catch {}
      
      this.isReady = false; 
      this.qrCode = null; 
      this.connectionState = 'disconnected';
      this.userInfo = null;
      this.deleteSessionFiles();

      // preparar compuerta para el próximo evento 'qr'
      this.requestQrCapture();

      await new Promise(r => setTimeout(r, 2000));
      logger.info({ userId }, 'Inicializando nuevo socket...');
      await this.safeInitialize();
      logger.info({ userId }, 'Nuevo socket inicializado, esperando QR...');
      return true;
    } catch (e) {
      logger.error({ err: e?.message }, 'Error al refrescar QR');
      return false;
    }
  }

  // Métodos para rate limiting y manejo de conflictos
  checkRateLimit() {
    const now = Date.now();
    const oneMinuteAgo = now - (60 * 1000);
    
    // Reset contador si ha pasado más de un minuto
    if (now - this.lastMessageTime > 60000) {
      this.messageCount = 0;
    }
    
    return this.messageCount < this.maxMessagesPerMinute;
  }
  
  recordMessage() {
    const now = Date.now();
    this.lastMessageTime = now;
    this.messageCount++;
    
    logger.info(`Mensaje registrado: ${this.messageCount}/${this.maxMessagesPerMinute} en la última hora`);
    
    // Si estamos cerca del límite, registrar advertencia
    if (this.messageCount >= this.maxMessagesPerMinute * 0.8) {
      logger.warn(`Cerca del límite de rate: ${this.messageCount}/${this.maxMessagesPerMinute}`);
    }
  }
  
  async waitForRateLimit() {
    if (!this.checkRateLimit()) {
      const waitTime = 60000; // Esperar 1 minuto
      logger.warn(`Rate limit alcanzado. Esperando ${waitTime/1000} segundos...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.messageCount = 0; // Reset contador después del cooldown
    }
  }
  
  isInConflictCooldown() {
    if (!this.isInCooldown) return false;
    
    const now = Date.now();
    const timeSinceLastConflict = now - this.lastConflictTime;
    const cooldownDuration = Math.min(this.conflictCount * 2 * 60 * 1000, 10 * 60 * 1000);
    
    return timeSinceLastConflict < cooldownDuration;
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
      canSendMessages: this.isReady && !this.isInCooldown && this.checkRateLimit() && !this.isConnecting
    };
  }
}

module.exports = { WhatsAppManager };