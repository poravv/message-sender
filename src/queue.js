const fs = require('fs');
const { sleep, isIgnorableSerializeError } = require('./utils');
const { convertAudioToOpus } = require('./media');
const { messageDelay } = require('./config');
const logger = require('./logger');

// Función para procesar variables en el mensaje
function processMessageVariables(message, variables) {
  if (!message) {
    return message;
  }
  
  let processedMessage = message;
  
  // Si hay variables disponibles, reemplazarlas
  if (variables && Object.keys(variables).length > 0) {
    Object.entries(variables).forEach(([key, value]) => {
      if (value) { // Solo reemplazar si el valor no está vacío
        const placeholder = `{${key}}`;
        const regex = new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'gi');
        processedMessage = processedMessage.replace(regex, value);
      }
    });
  }
  
  // Limpiar variables que no fueron reemplazadas (quedaron vacías)
  // Eliminar variables con espacios alrededor: " {variable} " → " "
  processedMessage = processedMessage.replace(/\s*\{[^}]+\}\s*/g, ' ');
  
  // Limpiar múltiples espacios consecutivos
  processedMessage = processedMessage.replace(/\s+/g, ' ');
  
  // Limpiar espacios al inicio y final
  processedMessage = processedMessage.trim();
  
  return processedMessage;
}

// Derivados del delay base
const LOOP_IDLE_MS   = Math.max(500, messageDelay);
const IMG_PREFIX_MS  = Math.max(0, Math.floor(messageDelay/2));
const IMG_BETWEEN_MS = messageDelay;
const SEND_BETWEEN_MS = messageDelay;
const backoffBase     = Math.max(1000, messageDelay);

class MessageQueue {
  constructor(client, userId = 'default') {
    this.client = client;
    this.userId = userId;
    this.queue = [];
    this.retryQueue = [];
    this.isProcessing = false;
    this.batchSize = 1;
    this.messageStats = null;
    // Sistema de referencias de archivos
    this.fileReferences = new Map(); // { filePath: count }
    this.filesToCleanup = new Set(); // archivos marcados para limpieza
  }

  getStats() { return this.messageStats; }

  async add(numbers, message, images, singleImage, audioFile) {
    this.messageStats = { total: numbers.length, sent: 0, errors: 0, messages: [], completed: false };
    
    // Contar referencias de archivos
    if (audioFile && audioFile.path) {
      const currentCount = this.fileReferences.get(audioFile.path) || 0;
      this.fileReferences.set(audioFile.path, currentCount + numbers.length);
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
    
    if (newCount === 0) {
      // No quedan referencias, eliminar archivo
      this.fileReferences.delete(filePath);
      this.cleanupAudioFiles(audioFile);
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
        if (file.startsWith(userPrefix) && file.endsWith('.mp3')) {
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
        
        const converted = await convertAudioToOpus(audioFile.path, this.userId);
        const audioBuffer = fs.readFileSync(converted);
        
        // Guardar la ruta del archivo convertido para limpieza posterior
        audioFile.convertedPath = converted;
        
        await this.client.sendMessage(jid, {
          audio: audioBuffer,
          mimetype: 'audio/mp4',
          ptt: true // Enviar como mensaje de voz
        });

        // Decrementar referencia del archivo de audio
        this.decrementFileReference(audioFile);

        // Enviar texto después del audio si existe
        if (processedMessage && processedMessage.trim()) {
          await sleep(SEND_BETWEEN_MS);
          await this.client.sendMessage(jid, { text: processedMessage.trim() });
        }
        return true;
      }

      // 1 IMAGEN
      if (singleImage) {
        if (!fs.existsSync(singleImage.path)) throw new Error('Archivo de imagen no encontrado');
        
        const imageBuffer = fs.readFileSync(singleImage.path);
        
        await this.client.sendMessage(jid, {
          image: imageBuffer,
          caption: processedMessage || ''
        });
        return true;
      }

            // MÚLTIPLES IMÁGENES
      if (images && images.length > 0) {
        for (let i = 0; i < images.length; i++) {
          const image = images[i];
          if (!fs.existsSync(image.path)) {
            throw new Error(`Archivo de imagen no encontrado: ${image.path}`);
          }
          
          const imageBuffer = fs.readFileSync(image.path);
          
          await this.client.sendMessage(jid, {
            image: imageBuffer,
            caption: i === 0 ? processedMessage || '' : '' // Solo agregar el mensaje a la primera imagen
          });
          
          // Pequeña pausa entre imágenes para evitar límites de velocidad
          if (i < images.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
        return true;
      }

      // SOLO TEXTO
      if (processedMessage && processedMessage.trim()) {
        await this.client.sendMessage(jid, { text: processedMessage.trim() });
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
}

module.exports = { MessageQueue };