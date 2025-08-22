/**
 * WhatsApp Bot con cola, reintentos y envío de texto/imagen/audio
 * API: /send-messages, /message-status, /connection-status, /qr, /refresh-qr
 */

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const csv = require('csv-parser');
const qrImage = require('qrcode');
const ffmpeg = require('fluent-ffmpeg');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);

// ============================
// Rutas y setup básicos
// ============================
const app = express();
const port = process.env.PORT || 3000;

const ROOT = __dirname;
const tempDir = path.join(ROOT, 'temp');
const uploadsDir = path.join(ROOT, 'uploads');
const publicDir = path.join(ROOT, 'public');
[ tempDir, uploadsDir, publicDir ].forEach(dir => !fs.existsSync(dir) && fs.mkdirSync(dir, { recursive: true }));

app.use(express.static('public'));
app.use(express.json());

// ============================
// Helpers generales
// ============================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function isIgnorableSerializeError(err) {
  const msg = String(err?.message || err || '');
  return msg.includes('serialize') || msg.includes('getMessageModel');
}

async function safeSend(client, jid, payload, options) {
  try {
    return await client.sendMessage(jid, payload, options);
  } catch (err) {
    if (isIgnorableSerializeError(err)) {
      console.warn(`Aviso: error interno "serialize" ignorado para ${jid}`);
      return { _ignoredSerialize: true }; // marcardor de “éxito con warning”
    }
    throw err;
  }
}

function cleanupDirectory(directory, maxAgeMs, now) {
  try {
    if (!fs.existsSync(directory)) return;
    let deleted = 0;
    for (const file of fs.readdirSync(directory)) {
      const filePath = path.join(directory, file);
      try {
        if (fs.statSync(filePath).isDirectory()) continue;
        const age = now - fs.statSync(filePath).mtimeMs;
        if (age > maxAgeMs) {
          fs.unlinkSync(filePath);
          deleted++;
        }
      } catch (e) {
        console.error(`Error al eliminar ${filePath}:`, e.message);
      }
    }
    if (deleted > 0) console.log(`Limpieza: ${deleted} archivos eliminados de ${path.basename(directory)}`);
  } catch (e) {
    console.error(`Error al limpiar ${directory}:`, e.message);
  }
}

function cleanupOldFiles(maxAgeHours = 24) {
  const maxAgeMs = maxAgeHours * 3600 * 1000;
  const now = Date.now();
  console.log(`Iniciando limpieza de archivos > ${maxAgeHours}h...`);
  cleanupDirectory(uploadsDir, maxAgeMs, now);
  cleanupDirectory(tempDir, maxAgeMs, now);
}

async function convertAudioToOpus(inputPath) {
  if (!fs.existsSync(inputPath)) throw new Error(`Archivo de entrada no encontrado: ${inputPath}`);
  !fs.existsSync(tempDir) && fs.mkdirSync(tempDir, { recursive: true });

  const out = path.join(tempDir, `audio_${Date.now()}.mp3`);
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .audioChannels(2)
      .audioFrequency(44100)
      .outputOptions(['-write_xing 0', '-id3v2_version 0', '-ar 44100'])
      .format('mp3')
      .on('end', () => {
        if (!fs.existsSync(out)) return reject(new Error('El archivo convertido no existe'));
        const size = fs.statSync(out).size;
        if (size <= 0) return reject(new Error('El archivo convertido está vacío'));
        resolve(out);
      })
      .on('error', reject)
      .save(out);
  });
}

function loadNumbersFromCSV(filePath) {
  return new Promise((resolve, reject) => {
    const numbers = [];
    let line = 0;
    fs.createReadStream(filePath)
      .pipe(csv({ skipLines: 0, headers: false }))
      .on('data', (row) => {
        line++;
        const number = String(Object.values(row)[0] || '').trim();
        if (number && /^\d+$/.test(number)) numbers.push({ number, index: line });
        else console.warn(`Línea ${line}: Número inválido: "${number}"`);
      })
      .on('end', () => {
        if (numbers.length === 0) return reject(new Error('El archivo CSV no contiene números válidos.'));
        resolve(numbers.sort((a,b)=>a.index-b.index).map(x=>x.number));
      })
      .on('error', reject);
  });
}

// ============================
// Multer (CSV / images / audio)
// ============================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    !fs.existsSync(uploadsDir) && fs.mkdirSync(uploadsDir, { recursive: true });
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    if (file.fieldname === 'audioFile') {
      const ext = path.extname(file.originalname);
      const unique = `${Date.now()}-${Math.round(Math.random()*1e9)}`;
      cb(null, `audio_${unique}${ext}`);
    } else {
      cb(null, file.originalname);
    }
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'audioFile' && !file.mimetype.startsWith('audio/')) {
      return cb(new Error('Formato de archivo no soportado. Solo audio.'));
    }
    cb(null, true);
  }
});

// ============================
// Autorización de número
// ============================
const authorizedPhoneNumbers = process.env.AUTHORIZED_PHONES
  ? process.env.AUTHORIZED_PHONES.split(',').map(p => p.trim())
  : ['595992756462'];

const isAuthorizedPhone = (phoneNumber) => {
  const normalized = String(phoneNumber).replace(/[\s\-\+]/g, '');
  return authorizedPhoneNumbers.some(p => normalized === p);
};

// ============================
// Cola de mensajes
// ============================
class MessageQueue {
  constructor(client) {
    this.client = client;
    this.queue = [];
    this.retryQueue = [];
    this.isProcessing = false;
    this.maxRetries = 3;
    this.batchSize = 1; // estable con medias
    this.messageStats = { total: 0, sent: 0, errors: 0, messages: [], completed: false };
  }

  getStats() { return this.messageStats; }

  async add(numbers, message, images, singleImage, audioFile) {
    this.messageStats = { total: numbers.length, sent: 0, errors: 0, messages: [], completed: false };
    const items = numbers.map((number, i) => ({
      number, message, images, singleImage, audioFile, attempts: 0, originalIndex: i
    }));
    this.queue.push(...items);
    if (!this.isProcessing) await this.processQueue();
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;
    console.log(`Iniciando procesamiento de cola. Mensajes pendientes: ${this.queue.length}`);

    try {
      while (this.queue.length > 0 || this.retryQueue.length > 0) {
        if (this.queue.length > 0) {
          const batch = this.queue.splice(0, this.batchSize).sort((a,b)=>a.originalIndex-b.originalIndex);
          await this.processBatch(batch);
        }
        if (this.retryQueue.length > 0) {
          // respetar backoff
          const now = Date.now();
          const ready = [];
          const later = [];
          for (const it of this.retryQueue) (it._retryAt && it._retryAt > now ? later : ready).push(it);
          this.retryQueue = later;
          if (ready.length > 0) {
            const retryBatch = ready.splice(0, this.batchSize);
            await this.processBatch(retryBatch);
            this.retryQueue.unshift(...ready); // devolver lo que no entró aún
          }
        }
        if (this.queue.length > 0 || this.retryQueue.length > 0) await sleep(1000);
      }
    } finally {
      this.isProcessing = false;
      this.messageStats.completed = true;
      console.log('Cola procesada completamente');
    }
  }

  async processBatch(batch) {
    let ok = 0;
    const ordered = batch.sort((a,b)=>a.originalIndex-b.originalIndex);

    for (const item of ordered) {
      try {
        await this.sendMessage(item);
        this.messageStats.sent++;
        this.messageStats.messages.push({ number: item.number, status: 'sent', message: 'Mensaje enviado exitosamente' });
        ok++;
      } catch (err) {
        const msg = String(err?.message || err || '');
        console.error(`Error enviando mensaje a ${item.number}:`, msg);

        const isPermanent =
          msg.includes('serialize') ||
          msg.includes('no está en WhatsApp') ||
          msg.includes('Archivo de') ||
          msg.includes('No se proporcionó contenido');

        if (!isPermanent && item.attempts < this.maxRetries) {
          item.attempts++;
          const waitMs = 1500 * Math.pow(2, item.attempts - 1);
          item._retryAt = Date.now() + waitMs;
          this.retryQueue.push(item);
        } else {
          this.messageStats.errors++;
          this.messageStats.messages.push({ number: item.number, status: 'error', message: `Error: ${msg || 'Error desconocido'}` });
        }
      }
      await sleep(600); // respiro
    }

    if (this.queue.length === 0 && this.retryQueue.length === 0) this.messageStats.completed = true;
    console.log(`Lote procesado: ${ok}/${batch.length} mensajes enviados exitosamente`);
  }

  async sendMessage(item) {
    const { number, message, images, singleImage, audioFile, originalIndex } = item;
    console.log(`Enviando mensaje a ${number} (posición original: ${originalIndex + 1})`);

    try {
      if (!this.client || !this.client.info) throw new Error('Cliente de WhatsApp no está listo');

      const id = await this.client.getNumberId(number);         // number: solo dígitos
      if (!id) throw new Error(`El número ${number} no está en WhatsApp`);
      const jid = id._serialized;

      await this.client.getChatById(jid).catch(() => {});       // best-effort

      // AUDIO
      if (audioFile) {
        if (!fs.existsSync(audioFile.path)) throw new Error('Archivo de audio no encontrado');
        const converted = await convertAudioToOpus(audioFile.path);
        const audioMedia = MessageMedia.fromFilePath(converted);
        audioMedia.mimetype = 'audio/mp3';
        await safeSend(this.client, jid, audioMedia, { sendAudioAsVoice: true, sendMediaAsDocument: false });
        if (message && message.trim()) await safeSend(this.client, jid, message.trim());
        return true;
      }

      // 1 IMAGEN + caption
      if (singleImage) {
        if (!fs.existsSync(singleImage.path)) throw new Error('Archivo de imagen no encontrado');
        const media = MessageMedia.fromFilePath(singleImage.path);
        await safeSend(this.client, jid, media, { caption: message || '', sendMediaAsDocument: false });
        return true;
      }

      // N IMÁGENES (texto opcional antes)
      if (images && images.length > 0) {
        if (message && message.trim()) {
          await safeSend(this.client, jid, message.trim());
          await sleep(500);
        }
        for (const img of images) {
          if (!fs.existsSync(img.path)) { console.warn(`Imagen no encontrada: ${img.path}, omitiendo...`); continue; }
          const media = MessageMedia.fromFilePath(img.path);
          await safeSend(this.client, jid, media);
          await sleep(800);
        }
        return true;
      }

      // SOLO TEXTO
      if (message && message.trim()) {
        await safeSend(this.client, jid, message.trim());
        return true;
      }

      throw new Error('No se proporcionó contenido');
    } catch (error) {
      if (isIgnorableSerializeError(error)) {
        console.warn(`Aviso: error interno "serialize" ignorado para ${number}`);
        return true;
      }
      throw error;
    }
  }
}

// ============================
// Manager de WhatsApp (cliente)
// ============================
class WhatsAppManager {
  constructor() {
    this.client = null;
    this.isReady = false;
    this.qrCode = null;
    this.connectionState = 'disconnected';
    this.lastActivity = Date.now();
    this.messageQueue = null;
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
      console.log('Eliminando archivos de sesión...');
      const sessionDir = path.join(ROOT, 'bot_sessions');
      if (!fs.existsSync(sessionDir)) return console.log('Directorio de sesiones no encontrado');

      let deleted = 0;
      for (const f of fs.readdirSync(sessionDir)) {
        const p = path.join(sessionDir, f);
        try {
          if (fs.lstatSync(p).isDirectory()) {
            for (const sf of fs.readdirSync(p)) { fs.unlinkSync(path.join(p, sf)); deleted++; }
            fs.rmdirSync(p);
          } else { fs.unlinkSync(p); deleted++; }
        } catch (e) { console.error(`Error al eliminar ${p}:`, e.message); }
      }
      console.log(`${deleted} archivos de sesión eliminados`);
    } catch (e) { console.error('Error al eliminar archivos de sesión:', e); }
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
        console.log('QR Code recibido');
        const qrPath = path.join(publicDir, 'qr.png');
        qrImage.toFile(qrPath, qr, { color: { dark: '#128C7E', light: '#FFFFFF' }, width: 300, margin: 1 }, (err) => {
          if (err) console.error('Error al generar archivo QR:', err);
          else { console.log('QR guardado en:', qrPath); this.lastQRUpdate = Date.now(); }
        });
      });

      // Auth
      this.client.on('authenticated', () => {
        console.log('Cliente autenticado!');
        this.connectionState = 'authenticated';
        this.qrCode = null;
        const qrPath = path.join(publicDir, 'qr.png');
        try { fs.existsSync(qrPath) && fs.unlinkSync(qrPath); } catch {}
      });

      this.client.on('auth_failure', (m) => {
        console.error('Fallo de autenticación:', m);
        this.connectionState = 'auth_failure';
      });

      // Ready
      this.client.on('ready', async () => {
        try {
          if (!this.client.info || !this.client.info.wid) throw new Error('No se pudo obtener información del cliente');
          const connectedNumber = this.client.info.wid.user;
          console.log('Número de teléfono conectado:', connectedNumber);

          if (!isAuthorizedPhone(connectedNumber)) {
            const alert = `¡ALERTA! Número no autorizado: ${connectedNumber}`;
            console.log(alert);
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

          console.log('Cliente WhatsApp listo! Número autorizado:', connectedNumber);
          this.isReady = true; this.connectionState = 'connected'; this.lastActivity = Date.now();
        } catch (e) {
          console.error('Error al verificar número conectado:', e?.message || e);
          this.connectionState = 'error';
        }
      });

      // Diagnóstico (opcional)
      this.client.on('change_state', s => console.log('Estado WA Web:', s));
      this.client.on('loading_screen', (p, t) => console.log(`Cargando WA Web: ${p}% - ${t}`));

      // Disconnected
      this.client.on('disconnected', async (reason) => {
        console.log('Cliente desconectado:', reason);
        this.isReady = false; this.connectionState = 'disconnected';
        if (this.client) { try { await this.client.destroy(); } catch {} this.client = null; }
        setTimeout(() => {
          console.log('Reiniciando cliente...');
          this.initialize().catch(err => console.error('Error en reconexión automática:', err));
        }, 10000);
      });

      await this.client.initialize();
      this.messageQueue = new MessageQueue(this.client);
      return true;
    } catch (e) {
      console.error('Error inicializando cliente WhatsApp:', e?.message || e);
      return false;
    }
  }

  async refreshQR() {
    console.log('Solicitando refrescar QR...');
    if (this.isReady) { console.log('No se puede refrescar: ya autenticado'); return false; }

    try {
      if (this.client) {
        console.log('Cerrando cliente actual...');
        try { await this.client.logout().catch(()=>{}); } catch {}
        try { await this.client.destroy().catch(()=>{}); } catch {}
        this.client = null;
      }

      const qrPath = path.join(publicDir, 'qr.png');
      try { fs.existsSync(qrPath) && fs.unlinkSync(qrPath); console.log('QR anterior eliminado'); } catch {}
      this.isReady = false; this.qrCode = null; this.connectionState = 'disconnected';
      this.deleteSessionFiles();
      console.log('Esperando limpieza...'); await sleep(2000);

      console.log('Inicializando nuevo cliente...');
      await this.initialize();
      console.log('Nuevo cliente inicializado, esperando QR...');
      return true;
    } catch (e) {
      console.error('Error al refrescar QR:', e);
      return false;
    }
  }
}

// ============================
// Instancia y endpoints
// ============================
const whatsappManager = new WhatsAppManager();

app.get('/connection-status', (req, res) => {
  const s = whatsappManager.getState();
  const resp = {
    status: s.connectionState,
    isReady: s.isReady,
    lastActivity: s.lastActivity,
    lastActivityAgo: Math.round((Date.now() - s.lastActivity) / 1000),
    hasQR: !!s.qrCode,
    connectionState: s.connectionState
  };
  if (s.isReady && whatsappManager.client?.info) {
    resp.userInfo = {
      phoneNumber: whatsappManager.client.info.wid.user,
      pushname: whatsappManager.client.info.pushname || 'Usuario de WhatsApp'
    };
  }
  res.json(resp);
});

app.post('/send-messages', upload.fields([
  { name: 'csvFile', maxCount: 1 },
  { name: 'images', maxCount: 10 },
  { name: 'singleImage', maxCount: 1 },
  { name: 'audioFile', maxCount: 1 }
]), async (req, res) => {
  try {
    if (!whatsappManager.isReady) {
      return res.status(400).json({ error: 'El cliente de WhatsApp no está listo. Escaneá el QR primero.' });
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

    res.json({ status: 'success', message: 'Procesando mensajes', totalNumbers: numbers.length, initialStats: whatsappManager.messageQueue.getStats() });
  } catch (error) {
    console.error('Error en /send-messages:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (req.files) {
      // limpiar todo excepto audio (lo necesita ffmpeg)
      Object.entries(req.files).forEach(([fieldName, files]) => {
        if (fieldName !== 'audioFile') {
          for (const f of files) { try { fs.existsSync(f.path) && fs.unlinkSync(f.path); } catch {} }
        }
      });
    }
  }
});

app.get('/message-status', (req, res) => {
  if (!whatsappManager.messageQueue) return res.json({ total: 0, sent: 0, errors: 0, messages: [], completed: true });
  res.json(whatsappManager.messageQueue.getStats());
});

app.get('/qr', (req, res) => {
  const qrPath = path.join(publicDir, 'qr.png');
  if (fs.existsSync(qrPath)) res.sendFile(qrPath);
  else res.status(404).json({ error: 'QR no disponible' });
});

app.post('/refresh-qr', async (req, res) => {
  try {
    if (whatsappManager.isReady) return res.status(400).json({ success: false, message: 'No se puede actualizar el QR si ya estás conectado' });
    const ok = await whatsappManager.refreshQR();
    if (ok) res.json({ success: true, message: 'Solicitando nuevo código QR...' });
    else res.status(400).json({ success: false, message: 'No se pudo refrescar el QR en este momento' });
  } catch (e) {
    console.error('Error en refresh-qr:', e);
    res.status(500).json({ success: false, message: e.message || 'Error al refrescar QR' });
  }
});

// ============================
// Inicio del servidor
// ============================
app.listen(port, async () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
  const retentionHours = Number(process.env.FILE_RETENTION_HOURS || 24);
  console.log(`Configuración: archivos se conservarán por ${retentionHours} horas`);
  cleanupOldFiles(retentionHours);
  setInterval(() => { console.log('Limpieza automática programada...'); cleanupOldFiles(retentionHours); }, 6 * 3600 * 1000);

  try { await whatsappManager.initialize(); } catch (e) { console.error('Error inicializando WhatsApp:', e); }
});