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
  constructor() {
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
      const sessionDir = path.join(publicDir, '..', 'auth_info');
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
      logger.info({ deleted }, 'Archivos de sesión eliminados');
    } catch (e) {
      logger.error({ err: e?.message }, 'Error al eliminar archivos de sesión');
    }
  }

  // ===== Comp. QR: API para la ruta /refresh-qr =====
  requestQrCapture() {
    this.qrCaptureRequested = true;
  }

  async captureQrToDisk() {
    try {
      if (!this.qrCode) return false;
      const qrPath = path.join(publicDir, 'qr.png');
      await qrcode.toFile(qrPath, this.qrCode, {
        color: { dark: '#128C7E', light: '#FFFFFF' },
        width: 300,
        margin: 1
      });
      this.lastQRUpdate = Date.now();
      logger.info({ qrPath }, 'QR guardado (captura inmediata)');
      return true;
    } catch (e) {
      logger.error({ err: e?.message }, 'captureQrToDisk falló');
      return false;
    }
  }

  async initialize() {
    if (this.sock) return true;

    try {
      // Configurar autenticación
      const authDir = path.join(publicDir, '..', 'auth_info');
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
        logger: pino({ level: 'silent' }) // Logger compatible con Baileys
      });

      // Event handlers
      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.qrCode = qr;
          this.connectionState = 'qr_ready';

          const qrPath = path.join(publicDir, 'qr.png');
          const shouldWrite = this.qrCaptureRequested || !fs.existsSync(qrPath);

          if (shouldWrite) {
            this.qrCaptureRequested = false;
            logger.info('QR Code recibido');
            await qrcode.toFile(qrPath, qr, {
              color: { dark: '#128C7E', light: '#FFFFFF' },
              width: 300,
              margin: 1
            });
            logger.info({ qrPath }, 'QR guardado');
            this.lastQRUpdate = Date.now();
          }
        }

        if (connection === 'close') {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          logger.warn({ 
            reason: lastDisconnect?.error?.message,
            shouldReconnect 
          }, 'Conexión cerrada');
          
          this.isReady = false;
          this.connectionState = 'disconnected';
          this.userInfo = null;
          this.sock = null;

          if (shouldReconnect) {
            setTimeout(() => {
              logger.info('Reintentando conexión...');
              this.initialize().catch(err => logger.error({ err: err?.message }, 'Error en reconexión'));
            }, 5000);
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
            
            // Eliminar QR una vez conectado
            const qrPath = path.join(publicDir, 'qr.png');
            try { 
              if (fs.existsSync(qrPath)) {
                fs.unlinkSync(qrPath); 
                logger.info('QR eliminado tras conexión exitosa');
              }
            } catch {}
          }
        } else if (connection === 'connecting') {
          logger.info('Conectando...');
          this.connectionState = 'connecting';
        }
      });

      // Configurar cola de mensajes
      this.messageQueue = new MessageQueue(this.sock);
      
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

      const qrPath = path.join(publicDir, 'qr.png');
      try { 
        fs.existsSync(qrPath) && fs.unlinkSync(qrPath); 
        logger.info('QR anterior eliminado'); 
      } catch {}
      
      this.isReady = false; 
      this.qrCode = null; 
      this.connectionState = 'disconnected';
      this.userInfo = null;
      this.deleteSessionFiles();

      // preparar compuerta para el próximo evento 'qr'
      this.requestQrCapture();

      await new Promise(r => setTimeout(r, 2000));
      logger.info('Inicializando nuevo socket...');
      await this.initialize();
      logger.info('Nuevo socket inicializado, esperando QR...');
      return true;
    } catch (e) {
      logger.error({ err: e?.message }, 'Error al refrescar QR');
      return false;
    }
  }
}

module.exports = { WhatsAppManager };