// src/manager.js
const fs = require('fs');
const path = require('path');
const qrImage = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { safeSend } = require('./utils');
const { isAuthorizedPhone, publicDir } = require('./config');
const { MessageQueue } = require('./queue');
const logger = require('./logger');

class WhatsAppManager {
  constructor() {
    this.client = null;
    this.isReady = false;
    this.qrCode = null;
    this.connectionState = 'disconnected';
    this.lastActivity = Date.now();
    this.messageQueue = null;
    this.lastQRUpdate = null;
    this.securityAlert = null;

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
      securityAlert: this.securityAlert || null
    };
  }

  updateActivity() { this.lastActivity = Date.now(); }

  deleteSessionFiles() {
    try {
      logger.info('Eliminando archivos de sesión...');
      const sessionDir = path.join(publicDir, '..', 'bot_sessions');
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
    this.qrCaptureRequested = true; // se consumirá en el próximo evento "qr"
  }

  async captureQrToDisk() {
    try {
      if (!this.qrCode) return false;
      const qrPath = path.join(publicDir, 'qr.png');
      await new Promise((resolve, reject) => {
        qrImage.toFile(
          qrPath,
          this.qrCode,
          { color: { dark: '#128C7E', light: '#FFFFFF' }, width: 300, margin: 1 },
          (err) => (err ? reject(err) : resolve())
        );
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
    if (this.client) return true;

    try {
      const puppeteerConfig = {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ],
        executablePath: process.env.CHROME_BIN || undefined,
        timeout: 60000
      };

      this.client = new Client({ authStrategy: new LocalAuth(), puppeteer: puppeteerConfig });

      // QR (ahora con compuerta)
      this.client.on('qr', (qr) => {
        this.qrCode = qr;

        const qrPath = path.join(publicDir, 'qr.png');
        const shouldWrite = this.qrCaptureRequested || !fs.existsSync(qrPath);

        if (!shouldWrite) {
          logger.debug('QR recibido (no guardado: sin solicitud y ya existe qr.png)');
          return;
        }

        // consumir compuerta 1 sola vez
        this.qrCaptureRequested = false;

        logger.info('QR Code recibido');
        qrImage.toFile(
          qrPath,
          qr,
          { color: { dark: '#128C7E', light: '#FFFFFF' }, width: 300, margin: 1 },
          (err) => {
            if (err) {
              logger.error({ err: err?.message }, 'Error al generar archivo QR');
            } else {
              logger.info({ qrPath }, 'QR guardado');
              this.lastQRUpdate = Date.now();
            }
          }
        );
      });

      // Auth
      this.client.on('authenticated', () => {
        logger.info('Cliente autenticado');
        this.connectionState = 'authenticated';
        this.qrCode = null;
        const qrPath = path.join(publicDir, 'qr.png');
        try { fs.existsSync(qrPath) && fs.unlinkSync(qrPath); } catch {}
      });

      this.client.on('auth_failure', (m) => {
        logger.error({ message: m }, 'Fallo de autenticación');
        this.connectionState = 'auth_failure';
      });

      // Ready
      this.client.on('ready', async () => {
        try {
          if (!this.client.info || !this.client.info.wid) throw new Error('No se pudo obtener información del cliente');
          const connectedNumber = this.client.info.wid.user;
          logger.info({ connectedNumber }, 'Cliente listo');

          if (!isAuthorizedPhone(connectedNumber)) {
            const alert = `¡ALERTA! Número no autorizado: ${connectedNumber}`;
            logger.warn({ connectedNumber }, 'Número no autorizado, desconectando...');
            this.securityAlert = { timestamp: Date.now(), messages: [alert, 'Desconectando...'], phoneNumber: connectedNumber };
            try { await safeSend(this.client, this.client.info.wid._serialized, 'Número no autorizado. Se cerrará la sesión.'); } catch {}
            this.isReady = false; this.connectionState = 'unauthorized';
            setTimeout(async () => {
              try { await this.client.logout(); } catch {}
              try { await this.client.destroy(); } catch {}
              this.client = null;
              this.deleteSessionFiles();
              setTimeout(() => this.initialize(), 8000);
            }, 3000);
            return;
          }

          logger.info({ connectedNumber }, 'Número autorizado');
          this.isReady = true; this.connectionState = 'connected'; this.lastActivity = Date.now();
        } catch (e) {
          logger.error({ err: e?.message }, 'Error al verificar número conectado');
          this.connectionState = 'error';
        }
      });

      // Diagnóstico (opcional)
      this.client.on('change_state', s => logger.info({ state: s }, 'Estado WA Web'));
      this.client.on('loading_screen', (p, t) => logger.info({ progress: p, text: t }, 'Cargando WA Web'));

      // Disconnected
      this.client.on('disconnected', async (reason) => {
        logger.warn({ reason }, 'Cliente desconectado');
        this.isReady = false; this.connectionState = 'disconnected';
        if (this.client) { try { await this.client.destroy(); } catch {} this.client = null; }
        setTimeout(() => {
          logger.info('Reiniciando cliente...');
          this.initialize().catch(err => logger.error({ err: err?.message }, 'Error en reconexión automática'));
        }, 10000);
      });

      await this.client.initialize();
      this.messageQueue = new MessageQueue(this.client);
      return true;
    } catch (e) {
      logger.error({ err: e?.message }, 'Error inicializando cliente WhatsApp');
      return false;
    }
  }

  async refreshQR() {
    logger.info('Solicitando refrescar QR...');
    if (this.isReady) { logger.info('No se puede refrescar: ya autenticado'); return false; }

    try {
      if (this.client) {
        logger.info('Cerrando cliente actual...');
        try { await this.client.logout().catch(()=>{}); } catch {}
        try { await this.client.destroy().catch(()=>{}); } catch {}
        this.client = null;
      }

      const qrPath = path.join(publicDir, 'qr.png');
      try { fs.existsSync(qrPath) && fs.unlinkSync(qrPath); logger.info('QR anterior eliminado'); } catch {}
      this.isReady = false; this.qrCode = null; this.connectionState = 'disconnected';
      this.deleteSessionFiles();

      // preparar compuerta para el próximo evento 'qr'
      this.requestQrCapture();

      await new Promise(r => setTimeout(r, 2000));
      logger.info('Inicializando nuevo cliente...');
      await this.initialize();
      logger.info('Nuevo cliente inicializado, esperando QR...');
      return true;
    } catch (e) {
      logger.error({ err: e?.message }, 'Error al refrescar QR');
      return false;
    }
  }
}

module.exports = { WhatsAppManager };