/**
 * WhatsApp Bot con sistema de cola, gestión de conexión y procesamiento ordenado
 * Versión: 2.0 - whatsapp-web.js
 * 
 * Este bot permite:
 * - Envío masivo de mensajes desde archivo CSV
 * - Mantiene el orden de envío según el archivo
 * - Sistema de reintentos automáticos
 * - Gestión robusta de la conexión
 * - Manejo de audio PTT (Push to Talk)
 */

// Importaciones necesarias
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const csv = require('csv-parser');
const qrcode = require('qrcode-terminal');
const qrImage = require('qrcode'); // Para generar QR como imagen
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);

// Definir rutas de directorios
const tempDir = path.join(__dirname, 'temp');
const uploadsDir = path.join(__dirname, 'uploads');

// Crear directorios si no existen
[tempDir, uploadsDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Configuración del servidor
const app = express();
const port = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.RESTART_PASSWORD;

// Configuración de Express
app.use(express.static('public'));
app.use(express.json());

/**
 * Elimina un archivo del sistema después de haber sido enviado
 * @param {string} filePath - Ruta del archivo a eliminar
 * @returns {Promise<boolean>} - Resultado de la operación
 */
const cleanupFile = async (filePath) => {
    try {
        if (!filePath || !fs.existsSync(filePath)) return false;
        
        // Verificar que el archivo esté en la carpeta uploads o temp
        if (!filePath.includes(uploadsDir) && !filePath.includes(tempDir)) {
            console.warn(`Intento de eliminar archivo fuera de directorios permitidos: ${filePath}`);
            return false;
        }
        
        // Eliminar el archivo
        fs.unlinkSync(filePath);
        console.log(`Archivo eliminado: ${path.basename(filePath)}`);
        return true;
    } catch (error) {
        console.error(`Error al eliminar archivo ${path.basename(filePath)}:`, error.message);
        return false;
    }
};

/**
 * Limpia los archivos antiguos de las carpetas uploads y temp
 * @param {number} maxAgeHours - Edad máxima de archivos en horas antes de eliminar
 */
const cleanupOldFiles = (maxAgeHours = 24) => {
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const now = Date.now();
    
    console.log(`Iniciando limpieza programada de archivos con antigüedad mayor a ${maxAgeHours} horas...`);
    
    // Limpieza de carpeta uploads
    cleanupDirectory(uploadsDir, maxAgeMs, now);
    
    // Limpieza de carpeta temp
    cleanupDirectory(tempDir, maxAgeMs, now);
};

/**
 * Limpia los archivos antiguos de un directorio específico
 * @param {string} directory - Directorio a limpiar
 * @param {number} maxAgeMs - Edad máxima en milisegundos
 * @param {number} now - Timestamp actual
 */
const cleanupDirectory = (directory, maxAgeMs, now) => {
    try {
        if (!fs.existsSync(directory)) return;
        
        const files = fs.readdirSync(directory);
        let deletedCount = 0;
        
        files.forEach(file => {
            const filePath = path.join(directory, file);
            
            // Ignorar directorios
            if (fs.statSync(filePath).isDirectory()) return;
            
            // Verificar la fecha de modificación del archivo
            const stats = fs.statSync(filePath);
            const fileAge = now - stats.mtimeMs;
            
            if (fileAge > maxAgeMs) {
                try {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                } catch (err) {
                    console.error(`Error al eliminar archivo antiguo ${file}:`, err.message);
                }
            }
        });
        
        if (deletedCount > 0) {
            console.log(`Limpieza completada: ${deletedCount} archivos eliminados de ${path.basename(directory)}`);
        }
    } catch (error) {
        console.error(`Error al limpiar directorio ${directory}:`, error.message);
    }
};

/**
 * Convierte un archivo de audio a formato compatible con WhatsApp
 * @param {string} inputPath - Ruta del archivo de audio original
 * @returns {Promise<string>} - Ruta del archivo convertido
 */
async function convertAudioToOpus(inputPath) {
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Archivo de entrada no encontrado: ${inputPath}`);
    }

    // Asegurarse de que el directorio temporal exista
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    // WhatsApp ahora prefiere MP3 para PTT (Push to Talk) en muchas plataformas
    const fileName = `audio_${Date.now()}.mp3`;
    const outputPath = path.join(tempDir, fileName);
    
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .noVideo()
            .audioCodec('libmp3lame')
            .audioBitrate('128k')
            .audioChannels(2)
            .audioFrequency(44100)
            .outputOptions([
                '-write_xing 0',      // Mejorar compatibilidad
                '-id3v2_version 0',   // Sin metadatos ID3
                '-ar 44100',          // Asegurar frecuencia de muestreo
            ])
            .format('mp3')
            .on('start', () => console.log('Iniciando conversión de audio...'))
            .on('progress', (progress) => console.log('Progreso de conversión:', progress))
            .on('end', () => {
                console.log('Conversión completada:', outputPath);
                if (fs.existsSync(outputPath)) {
                    // Verificar que el archivo tenga contenido
                    const stats = fs.statSync(outputPath);
                    if (stats.size > 0) {
                        resolve(outputPath);
                    } else {
                        reject(new Error('El archivo convertido está vacío'));
                    }
                } else {
                    reject(new Error('El archivo convertido no existe después de la conversión'));
                }
            })
            .on('error', (err) => {
                console.error('Error en la conversión:', err);
                reject(err);
            })
            .save(outputPath);
    });
}

/**
 * Configuración de multer para manejo de archivos
 */
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        if (file.fieldname === 'audioFile') {
            const ext = path.extname(file.originalname);
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, `audio_${uniqueSuffix}${ext}`);
        } else {
            cb(null, file.originalname);
        }
    }
});

const fileFilter = (req, file, cb) => {
    if (file.fieldname === 'audioFile') {
        if (file.mimetype.startsWith('audio/')) {
            cb(null, true);
        } else {
            cb(new Error('Formato de archivo no soportado. Solo se permiten archivos de audio.'));
        }
    } else {
        cb(null, true);
    }
};

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB límite
    },
    fileFilter: fileFilter
});

/**
 * Lee y valida números desde un archivo CSV
 * @param {string} filePath - Ruta al archivo CSV
 * @returns {Promise<Array>} Array de números ordenados
 */
const loadNumbersFromCSV = (filePath) => {
    return new Promise((resolve, reject) => {
        const numbers = [];
        let lineNumber = 0;

        fs.createReadStream(filePath)
            .pipe(csv({
                skipLines: 0,
                headers: false
            }))
            .on('data', (row) => {
                lineNumber++;
                const number = Object.values(row)[0].trim();
                if (number && /^\d+$/.test(number)) {
                    numbers.push({
                        number,
                        index: lineNumber,
                        originalRow: row
                    });
                } else {
                    console.warn(`Línea ${lineNumber}: Número inválido encontrado: ${number}`);
                }
            })
            .on('end', () => {
                if (numbers.length === 0) {
                    reject(new Error('El archivo CSV no contiene números válidos.'));
                } else {
                    const orderedNumbers = numbers
                        .sort((a, b) => a.index - b.index)
                        .map(item => item.number);
                    resolve(orderedNumbers);
                }
            })
            .on('error', reject);
    });
};

/**
 * Clase para gestionar la cola de mensajes
 */
class MessageQueue {
    constructor(client) {
        this.client = client;
        this.queue = [];
        this.isProcessing = false;
        this.retryQueue = [];
        this.maxRetries = 3;
        this.retryDelay = 5000;
        this.batchSize = 5; // Tamaño de lote más pequeño para audios
        this.messageStats = {
            total: 0,
            sent: 0,
            errors: 0,
            messages: [],
            completed: false
        };
    }

    /**
     * Agrega nuevos mensajes a la cola
     */
    async add(numbers, message, images, singleImage, audioFile) {
        this.messageStats = {
            total: numbers.length,
            sent: 0,
            errors: 0,
            messages: [],
            completed: false
        };

        const queueItems = numbers.map((number, index) => ({
            number,
            message,
            images,
            singleImage,
            audioFile,
            attempts: 0,
            originalIndex: index
        }));

        this.queue.push(...queueItems);

        if (!this.isProcessing) {
            await this.processQueue();
        }
    }

    /**
     * Procesa la cola principal y la cola de reintentos
     */
    async processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;

        this.isProcessing = true;
        console.log(`Iniciando procesamiento de cola. Mensajes pendientes: ${this.queue.length}`);

        try {
            while (this.queue.length > 0 || this.retryQueue.length > 0) {
                if (this.queue.length > 0) {
                    const batch = this.queue.splice(0, this.batchSize)
                        .sort((a, b) => a.originalIndex - b.originalIndex);
                    await this.processBatch(batch);
                }

                if (this.retryQueue.length > 0) {
                    const retryBatch = this.retryQueue.splice(0, this.batchSize);
                    await this.processBatch(retryBatch);
                }

                if (this.queue.length > 0 || this.retryQueue.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        } finally {
            this.isProcessing = false;
            this.messageStats.completed = true;
            console.log('Cola procesada completamente');
        }
    }

    /**
     * Procesa un lote de mensajes
     */
    async processBatch(batch) {
        const results = await Promise.allSettled(
            batch.map(item => this.sendMessage(item))
        );

        results.forEach((result, index) => {
            const item = batch[index];
            if (result.status === 'fulfilled') {
                this.messageStats.sent++;
                this.messageStats.messages.push({
                    number: item.number,
                    status: 'sent',
                    message: 'Mensaje enviado exitosamente'
                });
            } else {
                console.error(`Error enviando mensaje a ${item.number}:`, result.reason);
                if (item.attempts < this.maxRetries) {
                    item.attempts++;
                    this.retryQueue.push(item);
                } else {
                    this.messageStats.errors++;
                    this.messageStats.messages.push({
                        number: item.number,
                        status: 'error',
                        message: `Error: ${result.reason?.message || 'Error desconocido'}`
                    });
                }
            }
        });

        if (this.queue.length === 0 && this.retryQueue.length === 0) {
            this.messageStats.completed = true;
        }

        const successful = results.filter(r => r.status === 'fulfilled').length;
        console.log(`Lote procesado: ${successful}/${batch.length} mensajes enviados exitosamente`);
    }

    /**
     * Retorna las estadísticas de la cola
     */
    getStats() {
        return this.messageStats;
    }

    /**
     * Envía un mensaje individual
     */
    async sendMessage(item) {
        const { number, message, images, singleImage, audioFile, originalIndex } = item;
        console.log(`Enviando mensaje a ${number} (posición original: ${originalIndex + 1})`);
    
        try {
            // Formatear número para WhatsApp (agregar el sufijo @c.us)
            const formattedNumber = `${number}@c.us`;
            
            // Validar que el cliente esté listo
            if (!this.client.info) {
                throw new Error('Cliente de WhatsApp no está listo');
            }
            
            // Verificar si el número existe en WhatsApp
            const isRegistered = await this.client.isRegisteredUser(formattedNumber);
            if (!isRegistered) {
                throw new Error(`El número ${number} no está registrado en WhatsApp`);
            }

            // Caso 1: Envío de audio
            if (audioFile) {
                try {
                    // Validar archivo de audio
                    if (!fs.existsSync(audioFile.path)) {
                        throw new Error('Archivo de audio no encontrado');
                    }
                    
                    console.log(`Procesando audio: ${audioFile.path}`);

                    // Convertir el audio a ogg/opus
                    const convertedAudioPath = await convertAudioToOpus(audioFile.path);
                    console.log(`Audio convertido a: ${convertedAudioPath}`);

                    // Crear MessageMedia desde el archivo con tipo MIME específico
                    const audioMedia = MessageMedia.fromFilePath(convertedAudioPath);
                    audioMedia.mimetype = 'audio/mp3';
                    
                    // Enviar audio como mensaje de voz
                    await this.client.sendMessage(formattedNumber, audioMedia, {
                        sendAudioAsVoice: true,
                        sendMediaAsDocument: false
                    });
                    
                    console.log('Audio enviado exitosamente');

                    // Enviar mensaje de texto si existe
                    if (message && message.trim()) {
                        await this.client.sendMessage(formattedNumber, message);
                    }

                    // ELIMINACIÓN INMEDIATA: Limpiar archivos justo después de enviar
                    console.log('Eliminando archivos de audio inmediatamente después del envío...');
                    
                    // 1. Eliminar el archivo temporal convertido
                    if (fs.existsSync(convertedAudioPath)) {
                        fs.unlinkSync(convertedAudioPath);
                        console.log(`✓ Archivo temporal eliminado: ${path.basename(convertedAudioPath)}`);
                    }
                    
                    // 2. Eliminar el archivo original subido inmediatamente
                    if (audioFile && audioFile.path && fs.existsSync(audioFile.path)) {
                        fs.unlinkSync(audioFile.path);
                        console.log(`✓ Archivo original eliminado: ${path.basename(audioFile.path)}`);
                    } else {
                        console.log('No se encontró el archivo original para eliminar');
                    }

                } catch (error) {
                    console.error(`Error al procesar audio para ${number}:`, error);
                    throw error;
                }
            }
            // Caso 2: Envío de imagen simple con comentario
            else if (singleImage) {
                try {
                    // Validar archivo de imagen
                    if (!fs.existsSync(singleImage.path)) {
                        throw new Error('Archivo de imagen no encontrado');
                    }
                    
                    console.log(`Enviando imagen: ${singleImage.path}`);
                    
                    // Crear MessageMedia desde la imagen
                    const media = MessageMedia.fromFilePath(singleImage.path);
                    
                    // Enviar la imagen con la descripción (mensaje)
                    await this.client.sendMessage(formattedNumber, media, {
                        caption: message || '',
                        sendMediaAsDocument: false
                    });
                    
                    console.log('Imagen con comentario enviada exitosamente');
                } catch (error) {
                    console.error(`Error al enviar imagen para ${number}:`, error);
                    throw error;
                }
            }
            // Caso 3: Envío de múltiples imágenes
            else if (images && images.length > 0) {
                try {
                    console.log(`Enviando ${images.length} imágenes a ${number}`);
                    
                    // Primero enviamos el mensaje de texto si existe
                    if (message && message.trim()) {
                        await this.client.sendMessage(formattedNumber, message);
                    }
                    
                    // Luego enviamos cada imagen una por una
                    for (const img of images) {
                        if (!fs.existsSync(img.path)) {
                            console.warn(`Imagen no encontrada: ${img.path}, omitiendo...`);
                            continue;
                        }
                        
                        const media = MessageMedia.fromFilePath(img.path);
                        await this.client.sendMessage(formattedNumber, media);
                        
                        // Pequeña pausa entre imágenes para evitar bloqueos
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    
                    console.log('Todas las imágenes enviadas exitosamente');
                } catch (error) {
                    console.error(`Error al enviar múltiples imágenes para ${number}:`, error);
                    throw error;
                }
            } 
            // Caso 4: Solo mensaje de texto
            else if (message && message.trim()) {
                await this.client.sendMessage(formattedNumber, message);
                console.log('Mensaje de texto enviado exitosamente');
            } else {
                throw new Error('No se proporcionó ningún contenido para enviar (mensaje, imagen o audio)');
            }
            
            return true;
        } catch (error) {
            console.error(`Error enviando mensaje a ${number}:`, error);
            throw error;
        }
    }
}

/**
 * Clase para gestionar el cliente de WhatsApp
 */
class WhatsAppManager {
    constructor() {
        this.client = null;
        this.isReady = false;
        this.qrCode = null;
        this.connectionState = 'disconnected';
        this.lastActivity = Date.now();
    }

    async initialize() {
        if (this.client) return;

        try {
            // Crear cliente con autenticación local y configuración extendida de Puppeteer
            this.client = new Client({
                authStrategy: new LocalAuth(),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--single-process',
                        '--disable-gpu'
                    ],
                    executablePath: process.env.CHROME_BIN || undefined,
                    timeout: 60000 // Aumentar timeout a 60 segundos
                }
            });

            // Manejar evento de QR code
            this.client.on('qr', (qr) => {
                this.qrCode = qr;
                console.log('QR Code recibido');
                // Eliminado: qrcode.generate(qr, { small: true }); // Ya no imprimimos QR en terminal

                // Guardar QR como imagen en formato PNG con mejor calidad
                const qrPath = path.join(__dirname, 'public', 'qr.png');
                qrImage.toFile(qrPath, qr, {
                    color: {
                        dark: '#128C7E', // Color verde de WhatsApp
                        light: '#FFFFFF' // Fondo blanco
                    },
                    width: 300,
                    margin: 1
                }, (err) => {
                    if (err) {
                        console.error('Error al generar archivo QR:', err);
                    } else {
                        console.log('QR guardado en:', qrPath);
                        this.lastQRUpdate = Date.now();
                    }
                });

                // Emitir evento de actualización de QR
                this.onQRUpdated && this.onQRUpdated(qr);
            });

            // Manejar evento de autenticación
            this.client.on('authenticated', () => {
                console.log('Cliente autenticado!');
                this.connectionState = 'authenticated';
                
                // Limpiar QR cuando ya está autenticado
                this.qrCode = null;
                const qrPath = path.join(__dirname, 'public', 'qr.png');
                try {
                    if (fs.existsSync(qrPath)) {
                        fs.unlinkSync(qrPath);
                    }
                } catch (error) {
                    console.error('Error al eliminar imagen QR:', error);
                }
            });

            // Manejar evento de listo
            this.client.on('ready', async () => {
                try {
                    // Verificar si el número conectado está autorizado
                    // Obtener el número de teléfono del cliente conectado usando client.info.wid
                    if (!this.client.info || !this.client.info.wid) {
                        throw new Error('No se pudo obtener información del cliente conectado');
                    }
                    
                    const connectedNumber = this.client.info.wid.user; // Obtiene el número de teléfono conectado
                    console.log('Número de teléfono conectado:', connectedNumber);
                    
                    if (!isAuthorizedPhone(connectedNumber)) {
                        // Crear mensajes de alerta detallados
                        const alertMsg1 = `¡ALERTA DE SEGURIDAD! Número no autorizado intentando conectarse: ${connectedNumber}`;
                        const alertMsg2 = 'Desconectando cliente no autorizado y eliminando sesión...';
                        
                        console.log(alertMsg1);
                        console.log(alertMsg2);
                        
                        // Guardar los mensajes de alerta para mostrarlos en el frontend
                        this.securityAlert = {
                            timestamp: Date.now(),
                            messages: [
                                alertMsg1,
                                alertMsg2
                            ],
                            phoneNumber: connectedNumber
                        };
                        
                        // Mostrar mensaje al cliente no autorizado antes de desconectar
                        try {
                            await this.client.sendMessage(this.client.info.wid._serialized, 
                                'Este número no está autorizado para usar este sistema. La conexión será cerrada.');
                        } catch (e) {
                            console.log('No se pudo enviar mensaje de advertencia:', e);
                        }
                        
                        // Cambiar estado inmediatamente
                        this.isReady = false;
                        this.connectionState = 'unauthorized';
                        
                        // Forzar desconexión y eliminación de sesión
                        setTimeout(async () => {
                            try {
                                console.log('Cerrando cliente no autorizado...');
                                await this.client.logout();
                                console.log('Sesión cerrada mediante logout');
                            } catch (logoutError) {
                                console.log('Error en logout, usando método alternativo:', logoutError.message);
                            }
                            
                            try {
                                await this.client.destroy();
                                console.log('Cliente destruido correctamente');
                            } catch (destroyError) {
                                console.error('Error al destruir cliente:', destroyError);
                            }
                            
                            // Eliminar archivos de sesión
                            this.deleteSessionFiles();
                            
                            // Limpiar cliente
                            this.client = null;
                            
                            // Reiniciar después de una pausa para mostrar adecuadamente el estado no autorizado
                            setTimeout(() => this.initialize(), 8000);
                        }, 3000);
                        
                        return;
                    }
                    
                    console.log('Cliente WhatsApp listo! Número autorizado:', connectedNumber);
                    this.isReady = true;
                    this.connectionState = 'connected';
                    this.lastActivity = Date.now();
                } catch (error) {
                    console.error('Error al verificar el número conectado:', error);
                    this.connectionState = 'error';
                }
            });

            // Manejar evento de desconexión con estrategia de reintento mejorada
            this.client.on('disconnected', async (reason) => {
                console.log('Cliente desconectado:', reason);
                this.isReady = false;
                this.connectionState = 'disconnected';
                
                // Liberar recursos del cliente actual
                if (this.client) {
                    try {
                        await this.client.destroy();
                    } catch (e) {
                        console.log('Error al destruir cliente:', e);
                    }
                    this.client = null;
                }
                
                // Reiniciar cliente con nueva instancia después de un tiempo
                setTimeout(() => {
                    console.log('Creando nueva instancia y reconectando...');
                    this.initialize().catch(err => {
                        console.error('Error en reconexión automática:', err);
                    });
                }, 10000);  // Esperar 10 segundos antes de reconectar
            });

            // Inicializar cliente
            await this.client.initialize();
            
            // Crear instancia de MessageQueue
            this.messageQueue = new MessageQueue(this.client);
            
            return true;
        } catch (error) {
            console.error('Error inicializando cliente WhatsApp:', error);
            return false;
        }
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

    updateActivity() {
        this.lastActivity = Date.now();
    }
    
    /**
     * Refresca el QR forzando un restablecimiento del estado del cliente
     * @returns {Promise<boolean>} Resultado del refresco
     */
    /**
     * Elimina los archivos de sesión para forzar una nueva autenticación
     */
    deleteSessionFiles() {
        try {
            console.log('Eliminando archivos de sesión...');
            const sessionDir = path.join(__dirname, 'bot_sessions');
            
            if (fs.existsSync(sessionDir)) {
                const files = fs.readdirSync(sessionDir);
                let filesDeleted = 0;
                
                files.forEach(file => {
                    const filePath = path.join(sessionDir, file);
                    try {
                        if (fs.lstatSync(filePath).isDirectory()) {
                            // Es un directorio, borrar su contenido recursivamente
                            fs.readdirSync(filePath).forEach(subFile => {
                                const subFilePath = path.join(filePath, subFile);
                                fs.unlinkSync(subFilePath);
                                filesDeleted++;
                            });
                            // Intentar eliminar el directorio vacío
                            fs.rmdirSync(filePath);
                        } else {
                            // Es un archivo, borrarlo directamente
                            fs.unlinkSync(filePath);
                            filesDeleted++;
                        }
                    } catch (err) {
                        console.error(`Error al eliminar ${filePath}:`, err.message);
                    }
                });
                
                console.log(`${filesDeleted} archivos de sesión eliminados`);
            } else {
                console.log('Directorio de sesiones no encontrado');
            }
        } catch (error) {
            console.error('Error al eliminar archivos de sesión:', error);
        }
    }
    
    /**
     * Refresca el QR forzando una nueva autenticación
     * @returns {Promise<boolean>} Resultado del refresco
     */
    async refreshQR() {
        console.log('Solicitando refrescar QR...');
        
        if (this.isReady) {
            console.log('No se puede refrescar el QR: el cliente ya está autenticado');
            return false;
        }
        
        try {
            console.log('Preparando generación de nuevo QR...');
            
            // 1. Cerrar cliente existente si lo hay
            if (this.client) {
                console.log('Cerrando cliente actual...');
                try {
                    // Intentar logout primero (cierra sesión en WhatsApp Web)
                    await this.client.logout().catch(e => 
                        console.log('Error en logout (ignorable):', e.message)
                    );
                } catch (e) {
                    console.log('Error al hacer logout:', e);
                }
                
                try {
                    await this.client.destroy().catch(e => 
                        console.log('Error al destruir cliente (ignorable):', e.message)
                    );
                } catch (e) {
                    console.log('Error al destruir cliente:', e);
                }
                
                this.client = null;
            }
            
            // 2. Eliminar archivo QR existente
            const qrPath = path.join(__dirname, 'public', 'qr.png');
            try {
                if (fs.existsSync(qrPath)) {
                    fs.unlinkSync(qrPath);
                    console.log('Archivo QR anterior eliminado');
                }
            } catch (fileError) {
                console.warn('Error al eliminar archivo QR anterior:', fileError);
            }
            
            // 3. Limpiar estados
            this.isReady = false;
            this.qrCode = null;
            this.connectionState = 'disconnected';
            
            // 4. Eliminar archivos de sesión para forzar nueva autenticación
            this.deleteSessionFiles();
            
            // 5. Esperar un momento para que todo se limpie adecuadamente
            console.log('Esperando limpieza de recursos...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // 6. Crear un cliente completamente nuevo
            console.log('Inicializando nuevo cliente...');
            await this.initialize();
            console.log('Nuevo cliente inicializado, esperando generación de QR...');
            return true;
        } catch (error) {
            console.error('Error al refrescar QR:', error);
            return false;
        }
    }
}

// Instancia de WhatsAppManager
const whatsappManager = new WhatsAppManager();

// Configurar rutas de API
app.get('/connection-status', (req, res) => {
    const state = whatsappManager.getState();
    // Añadimos un console.log para depuración
    res.json({
        status: state.connectionState,
        isReady: state.isReady,
        lastActivity: state.lastActivity,
        lastActivityAgo: Math.round((Date.now() - state.lastActivity) / 1000),
        hasQR: !!state.qrCode || false, // Asegurar que se envíe el estado del QR
        connectionState: state.connectionState // Estado explícito de conexión
    });
});

// Lista de números autorizados para conectarse al sistema
const authorizedPhoneNumbers = process.env.AUTHORIZED_PHONES 
    ? process.env.AUTHORIZED_PHONES.split(',').map(phone => phone.trim())
    : ['595992756462', '']; // Números de ejemplo, deberías cambiarlos por los tuyos

// Middleware para verificar si un número está autorizado
const isAuthorizedPhone = (phoneNumber) => {
    // Normalizar el número eliminando espacios, guiones y símbolos
    const normalizedPhone = phoneNumber.replace(/[\s\-\+]/g, '');
    return authorizedPhoneNumbers.some(authPhone => normalizedPhone.includes(authPhone));
};

app.post('/toggle-whatsapp', async (req, res) => {
    const { enable, password, phoneNumber } = req.body;
    
    // Verificar contraseña
    if (!password || password !== ADMIN_PASSWORD) {
        return res.json({ success: false, message: 'Clave incorrecta' });
    }
    
    // Si está habilitando, verificar que el número esté autorizado
    if (enable && phoneNumber) {
        if (!isAuthorizedPhone(phoneNumber)) {
            console.log(`Intento de conexión no autorizado desde: ${phoneNumber}`);
            return res.json({ 
                success: false, 
                message: 'Este número no está autorizado para usar el sistema.' 
            });
        }
        console.log(`Acceso autorizado para el número: ${phoneNumber}`);
    }

    try {
        if (enable) {
            if (await whatsappManager.initialize()) {
                res.json({ success: true, message: 'WhatsApp inicializado correctamente' });
            } else {
                res.json({ success: false, message: 'Error al inicializar WhatsApp' });
            }
        } else {
            res.json({ success: false, message: 'La desconexión manual no está implementada para esta librería' });
        }
    } catch (error) {
        console.error('Error en toggle-whatsapp:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/send-messages', upload.fields([
    { name: 'csvFile', maxCount: 1 },
    { name: 'images', maxCount: 10 },
    { name: 'singleImage', maxCount: 1 },
    { name: 'audioFile', maxCount: 1 }
]), async (req, res) => {
    try {
        // Verificar si el cliente está listo
        if (!whatsappManager.isReady) {
            return res.status(400).json({ 
                error: 'El cliente de WhatsApp no está listo. Por favor, escanea el código QR primero.' 
            });
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

        if (numbers.length === 0) {
            return res.status(400).json({ error: 'No se encontraron números válidos' });
        }

        // Actualizar actividad
        whatsappManager.updateActivity();
        await whatsappManager.messageQueue.add(numbers, message, images, singleImage, audioFile);

        res.json({
            status: 'success',
            message: 'Procesando mensajes',
            totalNumbers: numbers.length,
            initialStats: whatsappManager.messageQueue.getStats()
        });

    } catch (error) {
        console.error('Error en /send-messages:', error);
        res.status(500).json({ error: error.message });
    } finally {
        // Limpiar archivos excepto de audio
        if (req.files) {
            Object.entries(req.files).forEach(([fieldName, files]) => {
                if (fieldName !== 'audioFile') {
                    files.forEach(file => {
                        if (fs.existsSync(file.path)) {
                            fs.unlinkSync(file.path);
                        }
                    });
                }
            });
        }
    }
});

app.get('/message-status', (req, res) => {
    if (!whatsappManager.messageQueue) {
        return res.json({
            total: 0,
            sent: 0,
            errors: 0,
            messages: [],
            completed: true
        });
    }
    
    const stats = whatsappManager.messageQueue.getStats();
    res.json(stats);
});

app.get('/qr', (req, res) => {
    const qrPath = path.join(__dirname, 'public', 'qr.png');
    if (fs.existsSync(qrPath)) {
        res.sendFile(qrPath);
    } else {
        res.status(404).json({ error: 'QR no disponible' });
    }
});

app.post('/refresh-qr', async (req, res) => {
    try {
        // Verificar si el cliente está desconectado o en espera de autenticación
        if (whatsappManager.isReady) {
            return res.status(400).json({
                success: false,
                message: 'No se puede actualizar el QR si ya estás conectado'
            });
        }
        
        const result = await whatsappManager.refreshQR();
        if (result) {
            res.json({
                success: true,
                message: 'Solicitando nuevo código QR...'
            });
        } else {
            res.status(400).json({
                success: false,
                message: 'No se pudo refrescar el QR en este momento'
            });
        }
    } catch (error) {
        console.error('Error en refresh-qr:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error al refrescar QR'
        });
    }
});

app.post('/restart-server', async (req, res) => {
    const { password } = req.body;

    if (!password || password !== ADMIN_PASSWORD) {
        return res.status(401).json({ 
            success: false, 
            message: 'Clave incorrecta' 
        });
    }

    console.log('Reiniciando servidor Node.js...');

    res.json({ 
        success: true, 
        message: 'Servidor reiniciando...' 
    });

    // Cerrar servidor y reiniciar
    setTimeout(() => {
        process.exit(0);
    }, 1000);
});

// Iniciar servidor
app.listen(port, async () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
    
    // Ejecutar limpieza inicial de archivos antiguos
    const retentionHours = process.env.FILE_RETENTION_HOURS || 24;
    console.log(`Configuración: archivos se conservarán por ${retentionHours} horas`);
    cleanupOldFiles(retentionHours);
    
    // Programar limpieza periódica (cada 6 horas)
    const cleanupInterval = 6 * 60 * 60 * 1000; // 6 horas en milisegundos
    setInterval(() => {
        console.log("Ejecutando limpieza automática programada...");
        cleanupOldFiles(retentionHours);
    }, cleanupInterval);
    
    // Inicializar WhatsApp automáticamente al iniciar
    try {
        await whatsappManager.initialize();
    } catch (error) {
        console.error('Error inicializando WhatsApp:', error);
    }
});