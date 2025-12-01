const fs = require('fs');
const { sleep, isIgnorableSerializeError } = require('./utils');
const { convertAudioToOpus } = require('./media');
const { messageDelay } = require('./config');
const logger = require('./logger');

// Función para procesar variables en el mensaje
function processMessageVariables(message, variables) {
  if (!message) return message;
  let processedMessage = message;

  if (variables && Object.keys(variables).length > 0) {
    Object.entries(variables).forEach(([key, value]) => {
      if (value) {
        const placeholder = `{${key}}`;
        const regex = new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'gi');
        processedMessage = processedMessage.replace(regex, value);
      }
    });
  }

  // Quitar placeholders no reemplazados sin comerse saltos de línea
  processedMessage = processedMessage.replace(/\{[^}\n]+\}/g, '');

  // Normalizar fin de línea y espacios sin colapsar \n
  processedMessage = processedMessage.replace(/\r\n/g, '\n');
  processedMessage = processedMessage.replace(/[ \t]+\n/g, '\n');
  processedMessage = processedMessage.replace(/\n[ \t]+/g, '\n');
  processedMessage = processedMessage.replace(/[ \t]{2,}/g, ' ');
  processedMessage = processedMessage.replace(/[ \t]+$/gm, '');

  processedMessage = processedMessage.trim();
  return processedMessage;
}

// Timings derivados del delay base (alineados al config para mayor throughput)
const delayFactor = Math.max(0.5, Number(process.env.MESSAGE_DELAY_FACTOR || 1));
const BASE_DELAY = Math.max(800, Math.floor(messageDelay * delayFactor));
const LOOP_IDLE_MS   = BASE_DELAY;                // entre iteraciones del loop
const IMG_PREFIX_MS  = Math.max(300, BASE_DELAY); // antes de la primera imagen
const IMG_BETWEEN_MS = BASE_DELAY;                // entre imágenes
const SEND_BETWEEN_MS = BASE_DELAY;               // entre envíos (texto/audio)
const backoffBase     = Math.max(2000, BASE_DELAY * 2);

class MessageQueue {
  constructor(client, userId = 'default') {
    this.client = client;
    this.userId = userId;
    this.queue = [];
    this.retryQueue = [];
    this.isProcessing = false;
    this.batchSize = 1;
    this.messageStats = null;
    this.maxRetries = 3;
    // Sistema de referencias de archivos
    this.fileReferences = new Map(); // { filePath: count }
    this.filesToCleanup = new Set(); // archivos marcados para limpieza
    // Rutas de imágenes a limpiar al finalizar
    this.imagePaths = new Set();
    // Caché de buffers e índice de S3
    this.imageCache = new Map(); // key: fs:<path> | s3:<key>
    this.s3ImageKeys = new Set();
  }

  getStats() { return this.messageStats; }

  async add(numbers, message, images, singleImage, audioFile) {
    this.messageStats = { total: numbers.length, sent: 0, errors: 0, messages: [], completed: false };
    
    // Contar referencias de archivos
    if (audioFile && audioFile.path) {
      const currentCount = this.fileReferences.get(audioFile.path) || 0;
      this.fileReferences.set(audioFile.path, currentCount + numbers.length);
    }
    // Registrar rutas/keys de imágenes para limpieza posterior y/o cache
    if (Array.isArray(images)) {
      for (const img of images) {
        if (!img) continue;
        if (img.path) this.imagePaths.add(img.path);
        if (img.s3Key) this.s3ImageKeys.add(img.s3Key);
      }
    }
    if (singleImage) {
      if (singleImage.path) this.imagePaths.add(singleImage.path);
      if (singleImage.s3Key) this.s3ImageKeys.add(singleImage.s3Key);
    }
    
    const items = numbers.map((entry, i) => {
      // Soporte para formato legacy (solo números) y nuevo formato (con variables)
      const number = typeof entry === 'string' ? entry : entry.number;
      const variables = typeof entry === 'object' && entry.variables ? entry.variables : {};
      
      return {
        number, 
        message, 
        variables,
        images, 
        singleImage, 
        audioFile, 
        attempts: 0, 
        originalIndex: i
      };
    });
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
      
      // Limpiar todos los archivos marcados para limpieza
      if (this.filesToCleanup.size > 0) {
        logger.info(`Limpiando ${this.filesToCleanup.size} archivos de audio`);
        for (const audioFile of this.filesToCleanup) {
          this.cleanupAudioFiles(audioFile);
        }
        this.filesToCleanup.clear();
      }
      
      // Limpiar imágenes subidas asociadas a esta ejecución
      if (this.imagePaths.size > 0) {
        let removed = 0;
        for (const p of this.imagePaths) {
          try {
            if (fs.existsSync(p)) {
              fs.unlinkSync(p);
              removed++;
            }
          } catch (e) {
            logger.warn(`No se pudo eliminar imagen ${p}: ${e.message}`);
          }
        }
        if (removed > 0) logger.info(`Imágenes temporales eliminadas: ${removed}`);
        this.imagePaths.clear();
      }
      
      // Borrar imágenes locales al finalizar
      if (this.imagePaths.size > 0) {
        let removed = 0;
        for (const p of this.imagePaths) {
          try {
            if (fs.existsSync(p)) { fs.unlinkSync(p); removed++; }
          } catch (e) {
            logger.warn(`No se pudo eliminar imagen local ${p}: ${e.message}`);
          }
        }
        if (removed > 0) logger.info(`Imágenes locales eliminadas: ${removed}`);
        this.imagePaths.clear();
      }

      // Borrar imágenes de S3 al finalizar si está habilitado
      try {
        const s3 = require('./storage/s3');
        if (s3.isEnabled() && s3.shouldDeleteAfterSend() && this.s3ImageKeys.size > 0) {
          let deleted = 0;
          for (const key of this.s3ImageKeys) {
            const ok = await s3.deleteObject(key);
            if (ok) deleted++;
          }
          if (deleted > 0) logger.info(`Imágenes S3 eliminadas: ${deleted}`);
        }
      } catch (e) {
        logger.warn(`No se pudo eliminar imágenes S3: ${e.message}`);
      }

      // Limpiar caché de imágenes en memoria
      this.imageCache.clear();

      // Limpiar archivos temp remanentes al finalizar
      this.cleanupTempDirectory();
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

  // Decrementar referencia de archivo y limpiar si es necesario
  decrementFileReference(audioFile) {
    if (!audioFile || !audioFile.path) return;
    
    const filePath = audioFile.path;
    const currentCount = this.fileReferences.get(filePath) || 0;
    const newCount = Math.max(0, currentCount - 1);
    
    logger.info(`Decrementando referencia de archivo: ${filePath}`, {
      currentCount,
      newCount,
      willDelete: newCount === 0,
      convertedPath: audioFile.convertedPath
    });
    
    if (newCount === 0) {
      // No quedan referencias, marcar para limpieza pero no eliminar inmediatamente
      this.fileReferences.delete(filePath);
      this.filesToCleanup.add(audioFile);
      logger.info(`Archivo marcado para limpieza posterior: ${filePath}`);
    } else {
      // Aún hay referencias pendientes
      this.fileReferences.set(filePath, newCount);
    }
  }

  // Limpiar archivos de audio cuando no hay más referencias
  cleanupAudioFiles(audioFile) {
    if (!audioFile) return;
    
    try {
      // Limpiar archivo original
      if (fs.existsSync(audioFile.path)) {
        fs.unlinkSync(audioFile.path);
        logger.info(`Archivo de audio original eliminado: ${audioFile.path}`);
      }
      
      // Limpiar archivo convertido usando la ruta real guardada
      if (audioFile.convertedPath && fs.existsSync(audioFile.convertedPath)) {
        fs.unlinkSync(audioFile.convertedPath);
        logger.info(`Archivo de audio convertido eliminado: ${audioFile.convertedPath}`);
      }
    } catch (cleanupError) {
      logger.warn(`Error al limpiar archivos de audio: ${cleanupError.message}`);
    }
  }

  // Limpiar directorio temp de archivos remanentes específicos del usuario
  cleanupTempDirectory() {
    try {
      const { tempDir } = require('./config');
      
      if (!fs.existsSync(tempDir)) return;
      
      const files = fs.readdirSync(tempDir);
      let cleanedCount = 0;
      
      // Solo limpiar archivos de este usuario específico
      const userPrefix = `audio_${this.userId}_`;
      
      files.forEach(file => {
        if (file.startsWith(userPrefix) && (file.endsWith('.m4a') || file.endsWith('.aac'))) {
          const filePath = require('path').join(tempDir, file);
          try {
            fs.unlinkSync(filePath);
            cleanedCount++;
          } catch (error) {
            logger.warn(`Error al eliminar archivo temp ${file}: ${error.message}`);
          }
        }
      });
      
      if (cleanedCount > 0) {
        logger.info(`Limpieza de directorio temp completada para usuario ${this.userId}: ${cleanedCount} archivos eliminados`);
      }
    } catch (error) {
      logger.warn(`Error durante limpieza del directorio temp para usuario ${this.userId}: ${error.message}`);
    }
  }

  async sendMessage(item) {
    const { number, message, variables, images, singleImage, audioFile, originalIndex } = item;
    logger.info(`Enviando mensaje a ${number} (posición original: ${originalIndex + 1})`);

    try {
      if (!this.client || !this.client.user) throw new Error('Socket de WhatsApp no está listo');
      
      // Rate limiting deshabilitado por solicitud del cliente
      // if (this.client.manager && typeof this.client.manager.waitForRateLimit === 'function') {
      //   await this.client.manager.waitForRateLimit();
      // }

      // Procesar variables en el mensaje
      const processedMessage = processMessageVariables(message, variables || {});
      
      // Log para debug de variables
      if (variables && Object.keys(variables).length > 0) {
        logger.info({ number, variables, originalMessage: message, processedMessage }, 'Variables procesadas en mensaje');
      }

      // Formatear número para Baileys (agregar @s.whatsapp.net si no lo tiene)
      const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;

      // AUDIO
      if (audioFile) {
        if (!fs.existsSync(audioFile.path)) throw new Error('Archivo de audio no encontrado');
        
        // Solo convertir una vez y reutilizar el archivo convertido
        let converted;
        if (!audioFile.convertedPath || !fs.existsSync(audioFile.convertedPath)) {
          converted = await convertAudioToOpus(audioFile.path, this.userId);
          audioFile.convertedPath = converted;
          logger.info(`Audio convertido para envío múltiple: ${converted}`);
        } else {
          converted = audioFile.convertedPath;
          logger.info(`Reutilizando audio convertido: ${converted}`);
        }
        
        // Verificar que el archivo convertido existe antes de leer
        if (!fs.existsSync(converted)) {
          throw new Error(`Archivo de audio convertido no encontrado: ${converted}`);
        }
        
        const audioBuffer = fs.readFileSync(converted);
        const stats = fs.statSync(converted);
        
        logger.info(`Enviando audio a ${number}:`, {
          originalFile: audioFile.path,
          convertedFile: converted,
          bufferSize: audioBuffer.length,
          fileSize: stats.size,
          destinatario: originalIndex + 1,
          mimetype: 'audio/mp4'
        });
        
        // Intentar múltiples formatos de mimetype para máxima compatibilidad
        let sendSuccess = false;
        const mimetypes = ['audio/mp4', 'audio/aac', 'audio/mpeg'];
        
        for (const mimetype of mimetypes) {
          try {
            await this.client.sendMessage(jid, {
              audio: audioBuffer,
              mimetype: mimetype,
              fileName: 'audio.m4a',
              ptt: false // Enviar como audio adjunto (música)
            });
            
            logger.info(`Audio enviado exitosamente a ${number} con mimetype ${mimetype} (destinatario ${originalIndex + 1})`);
            
            // Registrar mensaje para rate limiting
            if (this.client.manager && typeof this.client.manager.recordMessage === 'function') {
              this.client.manager.recordMessage();
            }
            
            sendSuccess = true;
            break;
          } catch (mimeError) {
            logger.warn(`Fallo con mimetype ${mimetype} para ${number}: ${mimeError.message}`);
            if (mimetype === mimetypes[mimetypes.length - 1]) {
              throw mimeError; // Si es el último mimetype, lanzar el error
            }
          }
        }
        
        if (!sendSuccess) {
          throw new Error('No se pudo enviar el audio con ningún formato de mimetype');
        }

        // Decrementar referencia del archivo de audio SOLO después del envío exitoso
        this.decrementFileReference(audioFile);

        // Enviar texto después del audio si existe
        if (processedMessage && processedMessage.trim()) {
          await sleep(SEND_BETWEEN_MS);
          await this.client.sendMessage(jid, { text: processedMessage.trim() });
          
          // Registrar mensaje adicional para rate limiting
          if (this.client.manager && typeof this.client.manager.recordMessage === 'function') {
            this.client.manager.recordMessage();
          }
        }
        return true;
      }

      // 1 IMAGEN
      if (singleImage) {
        const imageBuffer = await this._getImageBuffer(singleImage);
        
        await this.client.sendMessage(jid, {
          image: imageBuffer,
          caption: processedMessage || ''
        });
        
        // Registrar mensaje para rate limiting
        if (this.client.manager && typeof this.client.manager.recordMessage === 'function') {
          this.client.manager.recordMessage();
        }
        
        return true;
      }

            // MÚLTIPLES IMÁGENES
      if (images && images.length > 0) {
        for (let i = 0; i < images.length; i++) {
          const image = images[i];
          const imageBuffer = await this._getImageBuffer(image);
          
          await this.client.sendMessage(jid, {
            image: imageBuffer,
            caption: i === 0 ? processedMessage || '' : '' // Solo agregar el mensaje a la primera imagen
          });
          
          // Registrar mensaje para rate limiting
          if (this.client.manager && typeof this.client.manager.recordMessage === 'function') {
            this.client.manager.recordMessage();
          }
          
          // Pausa más larga entre imágenes para evitar límites de velocidad
          if (i < images.length - 1) {
            await new Promise(resolve => setTimeout(resolve, SEND_BETWEEN_MS));
          }
        }
        return true;
      }

      // SOLO TEXTO
      if (processedMessage && processedMessage.trim()) {
        await this.client.sendMessage(jid, { text: processedMessage.trim() });
        
        // Registrar mensaje para rate limiting
        if (this.client.manager && typeof this.client.manager.recordMessage === 'function') {
          this.client.manager.recordMessage();
        }
        
        return true;
      }

      throw new Error('No se proporcionó contenido');
    } catch (error) {
      // Decrementar referencia del archivo en caso de error también
      if (audioFile) {
        this.decrementFileReference(audioFile);
      }
      
      if (isIgnorableSerializeError(error)) {
        logger.warn(`Aviso: error interno "serialize" ignorado para ${number}`);
        return true;
      }
      throw error;
    }
  }

  async _getImageBuffer(image) {
    const key = image?.s3Key ? `s3:${image.s3Key}` : (image?.path ? `fs:${image.path}` : null);
    if (!key) throw new Error('Archivo de imagen no encontrado');
    if (this.imageCache.has(key)) return this.imageCache.get(key);

    if (image.s3Key) {
      const s3 = require('./storage/s3');
      if (!s3.isEnabled()) throw new Error('S3 habilitado pero no configurado');
      const buf = await s3.getObjectBuffer(image.s3Key);
      this.imageCache.set(key, buf);
      return buf;
    }

    if (image.path && fs.existsSync(image.path)) {
      const buf = fs.readFileSync(image.path);
      this.imageCache.set(key, buf);
      return buf;
    }

    throw new Error(`Archivo de imagen no encontrado${image.path ? ': ' + image.path : ''}`);
  }
}

module.exports = { MessageQueue };
