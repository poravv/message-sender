/**
 * WhatsApp Bot con sistema de cola, gestión de conexión y procesamiento ordenado
 * Versión: 2.0
 * 
 * Este bot permite:
 * - Envío masivo de mensajes desde archivo CSV
 * - Mantiene el orden de envío según el archivo
 * - Sistema de reintentos automáticos
 * - Gestión robusta de la conexión
 * - Manejo de imágenes múltiples
 */

// Importaciones necesarias
const { createBot, createProvider, createFlow, EVENTS } = require('@bot-whatsapp/bot');
require('dotenv').config();
const express = require('express');
const BaileysProvider = require('@bot-whatsapp/provider/baileys');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const csv = require('csv-parser');
const MockAdapter = require('@bot-whatsapp/database/mock');
const { exec } = require('child_process');
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

/**
 * Convierte un archivo de audio a formato OGG/OPUS
 * @param {string} inputPath - Ruta del archivo de audio original
 * @returns {Promise<string>} - Ruta del archivo convertido
 */
async function convertAudioToOgg(inputPath) {
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Archivo de entrada no encontrado: ${inputPath}`);
    }

    // Asegurarse de que el directorio temporal exista
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    const fileName = `audio_${Date.now()}.ogg`;
    const outputPath = path.join(tempDir, fileName);
    
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .toFormat('ogg')
            .audioCodec('libopus')
            .audioChannels(1) // Mono para mejor compatibilidad
            .audioFrequency(48000) // Frecuencia estándar para WhatsApp
            .on('start', () => {
                console.log('Iniciando conversión de audio...');
            })
            .on('progress', (progress) => {
                console.log('Progreso de conversión:', progress);
            })
            .on('end', () => {
                console.log('Conversión completada:', outputPath);
                if (fs.existsSync(outputPath)) {
                    resolve(outputPath);
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

const { toBuffer } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

/**
 * Envía un mensaje de audio usando Baileys
 * @param {Object} provider - Proveedor de Baileys
 * @param {string} jid - ID del chat (número@s.whatsapp.net)
 * @param {string} audioPath - Ruta al archivo de audio
 * @returns {Promise<boolean>}
 */
async function sendAudioMessage(provider, jid, audioPath) {
    console.log(`Intentando enviar audio desde: ${audioPath}`);
    
    if (!fs.existsSync(audioPath)) {
        throw new Error(`Archivo de audio no encontrado en: ${audioPath}`);
    }

    try {
        // Leer el archivo como buffer
        const audioBuffer = fs.readFileSync(audioPath);
        const buffer = toBuffer(audioBuffer);
        
        // Enviar el audio usando el proveedor
        await provider.sendMessage(jid, {
            audio: buffer,
            mimetype: 'audio/mp3',
            ptt: true
        });

        console.log('Audio enviado exitosamente');
        return true;
    } catch (error) {
        console.error('Error en sendAudioMessage:', error);
        throw new Boom(error);
    }
}

let adapterProvider;
let isBaileysEnabled = false; // Estado de Baileys (habilitado/deshabilitado)
let botInstance;

const ADMIN_PASSWORD = process.env.RESTART_PASSWORD;

/**
 * Gestor singleton de estado de Baileys
 */
class BaileysManager {
    static instance;
    
    constructor() {
        if (BaileysManager.instance) {
            return BaileysManager.instance;
        }
        this.isEnabled = false;
        this.botInstance = null;
        this.adapterProvider = null;
        this.lastActivity = Date.now();
        this.inactivityTimeout = 30 * 60 * 1000; // 30 minutos de inactividad
        this.checkInactivityInterval = null;
        BaileysManager.instance = this;
    }

    static getInstance() {
        if (!BaileysManager.instance) {
            BaileysManager.instance = new BaileysManager();
        }
        return BaileysManager.instance;
    }

    updateActivity() {
        this.lastActivity = Date.now();
    }

    startInactivityCheck() {
        if (this.checkInactivityInterval) return;
        
        this.checkInactivityInterval = setInterval(() => {
            const inactiveTime = Date.now() - this.lastActivity;
            if (inactiveTime > this.inactivityTimeout && this.isEnabled) {
                console.log('Deshabilitando Baileys por inactividad');
                this.disable();
            }
        }, 60000); // Revisar cada minuto
    }

    stopInactivityCheck() {
        if (this.checkInactivityInterval) {
            clearInterval(this.checkInactivityInterval);
            this.checkInactivityInterval = null;
        }
    }

    async enable() {
        if (this.isEnabled) return;

        try {
            const adapterFlow = createFlow([]);
            this.adapterProvider = createProvider(BaileysProvider);
            const adapterDB = new MockAdapter();

            connectionManager.setProvider(this.adapterProvider);

            this.botInstance = createBot({
                flow: adapterFlow,
                database: adapterDB,
                provider: this.adapterProvider,
            });

            this.isEnabled = true;
            this.updateActivity();
            this.startInactivityCheck();
            
            return true;
        } catch (error) {
            console.error('Error al habilitar Baileys:', error);
            return false;
        }
    }

    async disable() {
        if (!this.isEnabled) return true;

        try {
            // Solo nos aseguramos de cambiar el estado
            this.isEnabled = false;
            
            return true;
        } catch (error) {
            console.error('Error al deshabilitar Baileys:', error);
            return false;
        }
    }

    getState() {
        return {
            isEnabled: this.isEnabled,
            lastActivity: this.lastActivity
        };
    }

    getProvider() {
        return this.adapterProvider;
    }
}

// Instancia global
const baileysManager = new BaileysManager();

// Actualizar las funciones existentes para usar el nuevo gestor
const habilitar = async () => {
    return await baileysManager.enable();
};

const deshabilitar = async (req, res) => {
    if (await baileysManager.disable()) {
        console.log('Baileys deshabilitado');
        setTimeout(() => {
            exec('pm2 restart mi-servidor', (err, stdout, stderr) => {
                if (err) {
                    console.error('Error al reiniciar con PM2:', stderr);
                } else {
                    console.log('Servidor reiniciado:', stdout);
                }
            });
        }, 10000);
        res.json({ success: true, message: 'Servidor reiniciado correctamente' });
    } else {
        console.error('Error al deshabilitar Baileys');
        res.status(500).json({ success: false, message: 'Error al deshabilitar' });
    }
};

/**
 * Clase para gestionar la conexión del bot
 * Maneja reconexiones automáticas y monitoreo del estado
 */
class ConnectionManager {
    constructor() {
        this.provider = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 5000;
        this.isReconnecting = false;
        this.connectionState = 'disconnected';
        this.messageStats = {
            total: 0,
            sent: 0,
            errors: 0,
            messages: []
        };
    }

    setProvider(provider) {
        this.provider = provider;
        this.setupEventListeners();
    }


    setupEventListeners() {
        if (!this.provider) return;

        this.provider.on(EVENTS.CONNECTION_CLOSE, async () => {
            console.log("Conexión cerrada. Iniciando reconexión automática...");
            this.connectionState = 'disconnected';
            await this.handleReconnect();
        });

        this.provider.on(EVENTS.AUTHENTICATION_FAILURE, async () => {
            console.log("Fallo de autenticación detectado.");
            this.connectionState = 'disconnected';
            await this.handleReconnect();
        });

        this.provider.on(EVENTS.CONNECTION_OPEN, () => {
            console.log("Conexión establecida exitosamente");
            this.connectionState = 'connected';
            this.reconnectAttempts = 0;
        });

        // Monitoreo de actualizaciones de conexión
        this.provider.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                this.connectionState = 'disconnected';
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 403;
                if (shouldReconnect) {
                    await this.handleReconnect();
                }
            } else if (connection === 'open') {
                this.connectionState = 'connected';
                console.log('Conexión establecida y actualizada a connected');
            }
        });

        // Agregar evento para actualización de mensajes
        this.provider.on('send.message', (status) => {
            this.updateMessageStats(status);
        });
    }

    updateMessageStats(status) {
        const { number, state, message } = status;
        this.messageStats.messages.push({
            number,
            status: state,
            message: message || ''
        });

        if (state === 'sent') {
            this.messageStats.sent++;
        } else if (state === 'error') {
            this.messageStats.errors++;
        }
    }

    getMessageStats() {
        return this.messageStats;
    }

    getMessageStats() {
        return this.messageStats;
    }

    resetMessageStats() {
        this.messageStats = {
            total: 0,
            sent: 0,
            errors: 0,
            messages: []
        };
    }

    async checkConnection() {
        // Verificar el estado real de la conexión con el proveedor
        const isConnected = this.provider?.state?.connection === 'open' || this.connectionState === 'connected';
        return isConnected;
    }

    async handleReconnect() {
        if (this.isReconnecting) return;
        this.isReconnecting = true;

        try {
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
                console.log(`Intento de reconexión ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts} en ${delay / 1000} segundos`);

                await new Promise(resolve => setTimeout(resolve, delay));

                if (this.provider) {
                    await this.provider.reconnect();
                    this.reconnectAttempts++;
                }
            } else {
                console.log("Máximo de intentos de reconexión alcanzado. Requiere reinicio manual.");
            }
        } catch (error) {
            console.error('Error durante la reconexión:', error);
        } finally {
            this.isReconnecting = false;
        }
    }

    async checkConnection() {
        return this.connectionState === 'connected';
    }
}

/**
 * Clase para gestionar la cola de mensajes
 * Maneja el envío ordenado y los reintentos
 */
class MessageQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        this.retryQueue = []; // Cola separada para reintentos
        this.maxRetries = 3;
        this.retryDelay = 5000;
        this.batchSize = 100;
    }

    /**
     * Agrega nuevos mensajes a la cola
     * @param {Array} numbers - Array de números de teléfono
     * @param {string} message - Mensaje a enviar
     * @param {Array} images - Array de imágenes (opcional)
     * @param {Object} singleImage - Imagen única (opcional)
     */
    async add(numbers, message, images, singleImage, audioFile) {
        // Inicializar estadísticas
        this.messageStats = {
            total: numbers.length,
            sent: 0,
            errors: 0,
            messages: [],
            completed: false
        };

        // Crea elementos de cola con índice original
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
     * @param {Array} batch - Lote de mensajes a procesar
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

        // Verificar si hemos completado todos los envíos
        if (this.queue.length === 0 && this.retryQueue.length === 0) {
            this.messageStats.completed = true;
        }

        // Log de progreso
        const successful = batch.length - this.messageStats.errors;
        console.log(`Lote procesado: ${successful}/${batch.length} mensajes enviados exitosamente`);
    }

    getStats() {
        return this.messageStats;
    }

    /**
     * Envía un mensaje individual
     * @param {Object} item - Item de la cola a enviar
     * @returns {Promise}
     */
    async sendMessage(item) {
        const { number, message, images, singleImage, audioFile, originalIndex } = item;
        console.log(`Enviando mensaje a ${number} (posición original: ${originalIndex + 1})`);
    
        try {
            const provider = baileysManager.getProvider();
            if (!provider) {
                throw new Error('Proveedor de WhatsApp no disponible');
            }
    
            baileysManager.updateActivity();
            
            const jid = `${number}@s.whatsapp.net`;

            if (audioFile) {
                try {
                    // Validar archivo de audio
                    if (!fs.existsSync(audioFile.path)) {
                        throw new Error('Archivo de audio no encontrado');
                    }
                    
                    console.log(`Procesando audio: ${audioFile.path}`);

                    // Convertir el audio a ogg/opus
                    const convertedAudioPath = await convertAudioToOgg(audioFile.path);
                    console.log(`Audio convertido a: ${convertedAudioPath}`);

                    // Leer el archivo convertido como buffer
                    const audioBuffer = await fs.promises.readFile(convertedAudioPath);

                    // Obtener el socket activo de la sesión
                    const sock = provider.getInstance();
                    if (!sock) {
                        throw new Error('No se pudo obtener la sesión activa de WhatsApp');
                    }

                    console.log('Usando sesión activa para enviar audio...');
                    
                    // Enviar audio usando el socket directamente
                    await sendWithRetry(async () => {
                        await sock.sendMessage(jid, {
                            audio: audioBuffer,
                            mimetype: 'audio/ogg; codecs=opus',
                            ptt: true,
                            fileName: 'audio.ogg'
                        });
                        console.log('Audio enviado exitosamente usando la sesión activa');
                    }, 3);

                    // Enviar mensaje de texto si existe
                    if (message) {
                        await provider.sendText(jid, message);
                    }

                    // Limpiar el archivo convertido pero mantener el original
                    if (fs.existsSync(convertedAudioPath)) {
                        fs.unlinkSync(convertedAudioPath);
                    }

                } catch (error) {
                    console.error(`Error al procesar audio para ${number}:`, error);
                    throw error;
                }
            } else if (singleImage) {
                await provider.sendImage(jid, singleImage.path, message);
            } else {
                await provider.sendText(jid, message);
                if (images && images.length > 0) {
                    for (const image of images) {
                        await provider.sendImage(jid, image.path);
                    }
                }
            }
            return true;
        } catch (error) {
            console.error(`Error enviando mensaje a ${number} (posición original: ${originalIndex + 1}):`, error);
            throw error;
        }
    }
    
}

async function sendWithRetry(operation, maxRetries = 3, baseDelay = 1000) {
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (i < maxRetries - 1) {
                const delay = baseDelay * Math.pow(2, i);
                console.log(`Intento ${i + 1} fallido. Reintentando en ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    throw lastError;
}

/**
 * Configuración de multer para manejo de archivos
 */
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Asegurarse de que el directorio uploads exista
        if (!fs.existsSync('uploads')) {
            fs.mkdirSync('uploads', { recursive: true });
        }
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        if (file.fieldname === 'audioFile') {
            // Mantener la extensión original del archivo
            const ext = path.extname(file.originalname);
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, `audio_${uniqueSuffix}${ext}`);
        } else {
            // Para otros archivos, mantenemos el comportamiento actual
            cb(null, file.originalname);
        }
    }
});

const fileFilter = (req, file, cb) => {
    if (file.fieldname === 'audioFile') {
        // Aceptar solo formatos de audio comunes
        if (file.mimetype.startsWith('audio/')) {
            cb(null, true);
        } else {
            cb(new Error('Formato de archivo no soportado. Solo se permiten archivos de audio.'));
        }
    } else {
        // Para otros tipos de archivos, mantener el comportamiento actual
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

// Instancias principales
const connectionManager = new ConnectionManager();
const messageQueue = new MessageQueue();
const app = express();
const port = process.env.PORT || 3000;
let server; // Variable global para el servidor HTTP

// Configuración de Express
app.use(express.static('public'));
app.use(express.json());

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
 * Función principal de inicialización
 */
const main = async () => {
    // Endpoint para obtener el estado actual de Baileys
    app.get('/baileys-status', (req, res) => {
        const state = baileysManager.getState();
        res.json({
            ...state,
            lastActivityAgo: Math.round((Date.now() - state.lastActivity) / 1000) + ' segundos'
        });
    });

    // Endpoint para habilitar/deshabilitar Baileys con verificación de estado
    app.post('/toggle-baileys', async (req, res) => {
        const { enable, password } = req.body;
        
        if (!password || password !== ADMIN_PASSWORD) {
            return res.json({ success: false, message: 'Clave incorrecta' });
        }

        try {
            if (enable) {
                if (await baileysManager.enable()) {
                    res.json({ success: true, message: 'Baileys habilitado correctamente' });
                } else {
                    res.json({ success: false, message: 'Error al habilitar Baileys' });
                }
            } else {
                if (await baileysManager.disable()) {
                    res.json({ success: true, message: 'Baileys deshabilitado correctamente' });
                } else {
                    res.json({ success: false, message: 'Error al deshabilitar Baileys' });
                }
            }
        } catch (error) {
            console.error('Error en toggle-baileys:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // Endpoint para verificar estado de conexión
    app.get('/connection-status', async (req, res) => {
        try {
            const isConnected = await connectionManager.checkConnection();
            const baileysState = baileysManager.getState();
            
            res.json({
                status: isConnected ? 'connected' : 'disconnected',
                baileysEnabled: baileysState.isEnabled,
                lastActivity: baileysState.lastActivity,
                reconnectAttempts: connectionManager.reconnectAttempts,
                isReconnecting: connectionManager.isReconnecting
            });
        } catch (error) {
            console.error('Error checking connection:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Endpoint principal para envío de mensajes con verificación de estado
    app.post('/send-messages', upload.fields([
        { name: 'csvFile', maxCount: 1 },
        { name: 'images', maxCount: 10 },
        { name: 'singleImage', maxCount: 1 },
        { name: 'audioFile', maxCount: 1 }
    ]), async (req, res) => {
        try {
            // Verificar si Baileys está habilitado
            if (!baileysManager.getState().isEnabled) {
                return res.status(400).json({ 
                    error: 'El servicio de WhatsApp no está habilitado. Por favor, habilítelo primero.' 
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

            // Actualizar actividad antes de comenzar el envío
            baileysManager.updateActivity();
            await messageQueue.add(numbers, message, images, singleImage, audioFile);

            res.json({
                status: 'success',
                message: 'Procesando mensajes',
                totalNumbers: numbers.length,
                initialStats: messageQueue.getStats()
            });

        } catch (error) {
            console.error('Error en /send-messages:', error);
            res.status(500).json({ error: error.message });
        } finally {
            // Limpiar solo archivos que no sean de audio
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

    // Endpoint para obtener el estado de los mensajes
    app.get('/message-status', (req, res) => {
        const stats = messageQueue.getStats();
        res.json(stats);
    });

    // Endpoint para obtener el QR
    app.get('/qr', (req, res) => {
        const qrPath = path.join(__dirname, 'bot.qr.png');
        if (fs.existsSync(qrPath)) {
            res.sendFile(qrPath);
        } else {
            res.status(404).json({ error: 'QR no disponible' });
        }
    });

    // Endpoint para reiniciar el servidor
    app.post('/restart-server', async (req, res) => {
        const { password } = req.body;

        if (!password || password !== ADMIN_PASSWORD) {
            return res.status(401).json({ 
                success: false, 
                message: 'Clave incorrecta' 
            });
        }

        console.log('Reiniciando servidor Node.js...');

        // Enviar respuesta antes de reiniciar
        res.json({ 
            success: true, 
            message: 'Servidor reiniciando...' 
        });

        // Cerrar el servidor HTTP y limpiar recursos
        if (server) {
            await new Promise((resolve) => {
                server.close(() => {
                    console.log('Servidor HTTP cerrado');
                    resolve();
                });
            });
            
            // Limpiar recursos de Baileys
            if (baileysManager.getState().isEnabled) {
                try {
                    await baileysManager.disable();
                } catch (error) {
                    console.error('Error al deshabilitar Baileys:', error);
                }
            }

            // Forzar el cierre del proceso
            process.kill(process.pid, 'SIGINT');
        } else {
            process.kill(process.pid, 'SIGINT');
        }
    });

    // Inicia el servidor y guarda la referencia globalmente
    server = app.listen(port, () => {
        console.log(`Servidor escuchando en http://localhost:${port}`);
    });
};

// Inicia la aplicación
main().catch(console.error);