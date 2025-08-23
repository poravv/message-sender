const fs = require('fs');
const { MessageMedia } = require('whatsapp-web.js');
const { sleep, safeSend, isIgnorableSerializeError } = require('./utils');
const { convertAudioToOpus } = require('./media');
const { messageDelay } = require('./config');
const logger = require('./logger');  // <<--- importamos el logger

// Derivados del delay base
const LOOP_IDLE_MS   = Math.max(500, messageDelay);
const IMG_PREFIX_MS  = Math.max(0, Math.floor(messageDelay/2));
const IMG_BETWEEN_MS = messageDelay;
const SEND_BETWEEN_MS = messageDelay;
const backoffBase     = Math.max(1000, messageDelay);

class MessageQueue {
  constructor(client) {
    this.client = client;
    this.queue = [];
    this.retryQueue = [];
    this.isProcessing = false;
    this.maxRetries = 3;
    this.batchSize = 1;
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
    logger.info(`Iniciando procesamiento de cola. Mensajes pendientes: ${this.queue.length}`);

    try {
      while (this.queue.length > 0 || this.retryQueue.length > 0) {
        if (this.queue.length > 0) {
          const batch = this.queue.splice(0, this.batchSize).sort((a,b)=>a.originalIndex-b.originalIndex);
          await this.processBatch(batch);
        }

        if (this.retryQueue.length > 0) {
          const now = Date.now();
          const ready = [];
          const later = [];
          for (const it of this.retryQueue) (it._retryAt && it._retryAt > now ? later : ready).push(it);
          this.retryQueue = later;

          if (ready.length > 0) {
            const retryBatch = ready.splice(0, this.batchSize);
            await this.processBatch(retryBatch);
            this.retryQueue.unshift(...ready);
          }
        }

        if (this.queue.length > 0 || this.retryQueue.length > 0) {
          await sleep(LOOP_IDLE_MS);
        }
      }
    } finally {
      this.isProcessing = false;
      this.messageStats.completed = true;
      logger.info('Cola procesada completamente');
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
        logger.error(`Error enviando mensaje a ${item.number}: ${msg}`);

        const isPermanent =
          msg.includes('serialize') ||
          msg.includes('no está en WhatsApp') ||
          msg.includes('Archivo de') ||
          msg.includes('No se proporcionó contenido');

        if (!isPermanent && item.attempts < this.maxRetries) {
          item.attempts++;
          const waitMs = backoffBase * Math.pow(2, item.attempts - 1);
          item._retryAt = Date.now() + waitMs;
          this.retryQueue.push(item);
        } else {
          this.messageStats.errors++;
          this.messageStats.messages.push({ number: item.number, status: 'error', message: `Error: ${msg || 'Error desconocido'}` });
        }
      }

      await sleep(SEND_BETWEEN_MS);
    }

    if (this.queue.length === 0 && this.retryQueue.length === 0) this.messageStats.completed = true;
    logger.info(`Lote procesado: ${ok}/${batch.length} mensajes enviados exitosamente`);
  }

  async sendMessage(item) {
    const { number, message, images, singleImage, audioFile, originalIndex } = item;
    logger.info(`Enviando mensaje a ${number} (posición original: ${originalIndex + 1})`);

    try {
      if (!this.client || !this.client.info) throw new Error('Cliente de WhatsApp no está listo');

      const id = await this.client.getNumberId(number);
      if (!id) throw new Error(`El número ${number} no está en WhatsApp`);
      const jid = id._serialized;

      await this.client.getChatById(jid).catch(() => {});

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

      // 1 IMAGEN
      if (singleImage) {
        if (!fs.existsSync(singleImage.path)) throw new Error('Archivo de imagen no encontrado');
        const media = MessageMedia.fromFilePath(singleImage.path);
        await safeSend(this.client, jid, media, { caption: message || '', sendMediaAsDocument: false });
        return true;
      }

      // N IMÁGENES
      if (images && images.length > 0) {
        if (message && message.trim()) {
          await safeSend(this.client, jid, message.trim());
          await sleep(IMG_PREFIX_MS);
        }
        for (const img of images) {
          if (!fs.existsSync(img.path)) {
            logger.warn(`Imagen no encontrada: ${img.path}, omitiendo...`);
            continue;
          }
          const media = MessageMedia.fromFilePath(img.path);
          await safeSend(this.client, jid, media);
          await sleep(IMG_BETWEEN_MS);
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
        logger.warn(`Aviso: error interno "serialize" ignorado para ${number}`);
        return true;
      }
      throw error;
    }
  }
}

module.exports = { MessageQueue };