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
          // '--single-process', // no usar (inestable)
          '--disable-gpu'
        ],
        executablePath: process.env.CHROME_BIN || undefined,
        timeout: 60000
      };

      this.client = new Client({ authStrategy: new LocalAuth(), puppeteer: puppeteerConfig });

      // QR
      this.client.on('qr', (qr) => {
        this.qrCode = qr;
        logger.info('QR Code recibido');
        const qrPath = path.join(publicDir, 'qr.png');
        qrImage.toFile(qrPath, qr, { color: { dark: '#128C7E', light: '#FFFFFF' }, width: 300, margin: 1 }, (err) => {
          if (err) logger.error({ err: err?.message }, 'Error al generar archivo QR');
          else { logger.info({ qrPath }, 'QR guardado'); this.lastQRUpdate = Date.now(); }
        });
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