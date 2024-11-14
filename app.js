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

        const onConnectionClosed = async () => {
            console.log("Conexión cerrada. Iniciando reconexión...");
            this.connectionState = 'disconnected';
            await this.handleReconnect();
        };

        const onConnectionOpened = () => {
            console.log("Conexión establecida");
            this.connectionState = 'connected';
            this.reconnectAttempts = 0;
        };

        this.provider.on(EVENTS.CONNECTION_CLOSE, onConnectionClosed);
        this.provider.on(EVENTS.AUTHENTICATION_FAILURE, onConnectionClosed);
        this.provider.on(EVENTS.CONNECTION_OPEN, onConnectionOpened);

        this.provider.on('connection.update', async (update) => {
            if (update.connection === 'close' && update.lastDisconnect?.error?.output?.statusCode !== 403) {
                await this.handleReconnect();
            } else if (update.connection === 'open') {
                onConnectionOpened();
            }
        });

        this.provider.on('send.message', this.updateMessageStats.bind(this));
    }

    updateMessageStats({ number, state, message }) {
        this.messageStats.messages.push({ number, status: state, message: message || '' });
        this.messageStats[state === 'sent' ? 'sent' : 'errors']++;
    }

    async handleReconnect() {
        if (this.isReconnecting || this.reconnectAttempts >= this.maxReconnectAttempts) return;
        this.isReconnecting = true;

        try {
            const delay = this.reconnectDelay * (1 << this.reconnectAttempts++);
            console.log(`Intento de reconexión en ${delay / 1000} segundos`);
            await new Promise(resolve => setTimeout(resolve, delay));

            if (this.provider) await this.provider.reconnect();
        } catch (error) {
            console.error('Error durante la reconexión:', error);
        } finally {
            this.isReconnecting = false;
        }
    }

    checkConnection() {
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
        this.retryQueue = [];
        this.maxRetries = 3;
        this.retryDelay = 5000;
        this.batchSize = 100;
        this.messageStats = {
            total: 0,
            sent: 0,
            errors: 0,
            messages: [],
            completed: false
        };
    }

    async add(numbers, message, images, singleImage) {
        this.messageStats = { total: numbers.length, sent: 0, errors: 0, messages: [], completed: false };
        this.queue.push(...numbers.map((number, index) => ({
            number, message, images, singleImage, attempts: 0, originalIndex: index
        })));

        if (!this.isProcessing) await this.processQueue();
    }

    async processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;

        this.isProcessing = true;
        console.log(`Procesando cola de mensajes...`);

        while (this.queue.length > 0 || this.retryQueue.length > 0) {
            const batch = (this.queue.length > 0 ? this.queue : this.retryQueue)
                .splice(0, this.batchSize)
                .sort((a, b) => a.originalIndex - b.originalIndex);

            await this.processBatch(batch);
            if (this.queue.length > 0 || this.retryQueue.length > 0) await new Promise(resolve => setTimeout(resolve, 1000));
        }

        this.isProcessing = false;
        this.messageStats.completed = true;
        console.log('Cola procesada completamente');
    }

    async processBatch(batch) {
        const results = await Promise.allSettled(batch.map(item => this.sendMessage(item)));

        results.forEach((result, index) => {
            const item = batch[index];
            if (result.status === 'fulfilled') {
                this.messageStats.sent++;
                this.messageStats.messages.push({ number: item.number, status: 'sent', message: 'Mensaje enviado' });
            } else if (item.attempts < this.maxRetries) {
                item.attempts++;
                this.retryQueue.push(item);
            } else {
                this.messageStats.errors++;
                this.messageStats.messages.push({ number: item.number, status: 'error', message: result.reason?.message || 'Error desconocido' });
            }
        });

        console.log(`Lote procesado: ${batch.length - this.messageStats.errors}/${batch.length} mensajes enviados`);
    }

    async sendMessage({ number, message, images, singleImage }) {
        console.log(`Enviando mensaje a ${number}`);
        try {
            if (singleImage) {
                await adapterProvider.sendImage(`${number}@c.us`, singleImage.path, message);
            } else {
                await adapterProvider.sendText(`${number}@c.us`, message);
                for (const image of images || []) {
                    await adapterProvider.sendImage(`${number}@c.us`, image.path);
                }
            }
            return true;
        } catch (error) {
            console.error(`Error enviando mensaje a ${number}: ${error.message}`);
            throw error;
        }
    }

    getStats() {
        return this.messageStats;
    }
}

/**
 * Configuración de multer para manejo de archivos
 */
const upload = multer({
    dest: 'uploads/',
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB límite
    }
});

// Instancias principales
const connectionManager = new ConnectionManager();
const messageQueue = new MessageQueue();
let adapterProvider;
const app = express();
const port = 3000;

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
    const adapterFlow = createFlow([]);
    const adapterDB = new MockAdapter();
    adapterProvider = createProvider(BaileysProvider);

    // Configura el gestor de conexiones
    connectionManager.setProvider(adapterProvider);

    createBot({
        flow: adapterFlow,
        database: adapterDB,
        provider: adapterProvider,
    });

    // Endpoint para verificar estado de conexión
    app.get('/connection-status', async (req, res) => {
        try {
            const isConnected = await connectionManager.checkConnection();
            res.json({
                status: isConnected ? 'connected' : 'disconnected',
                reconnectAttempts: connectionManager.reconnectAttempts,
                isReconnecting: connectionManager.isReconnecting
            });
        } catch (error) {
            console.error('Error checking connection:', error);
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/message-status', (req, res) => {
        const stats = messageQueue.getStats();
        res.json({
            sent: stats.sent,
            total: stats.total,
            errors: stats.errors,
            messages: stats.messages,
            completed: stats.completed,
            isProcessing: messageQueue.isProcessing
        });
    });

    // Endpoint para forzar reconexión
    app.post('/force-reconnect', async (req, res) => {
        try {
            await connectionManager.handleReconnect();
            res.json({ message: 'Reconexión iniciada' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Endpoint principal para envío de mensajes
    app.post('/send-messages', upload.fields([
        { name: 'csvFile', maxCount: 1 },
        { name: 'images', maxCount: 10 },
        { name: 'singleImage', maxCount: 1 }
    ]), async (req, res) => {
        try {
            if (!req.files || !req.files['csvFile']) {
                return res.status(400).json({ error: 'Archivo CSV no proporcionado' });
            }
    
            const csvFilePath = req.files['csvFile'][0].path;
            const images = req.files['images'];
            const singleImage = req.files['singleImage'] ? req.files['singleImage'][0] : null;
            const { message } = req.body;
    
            const numbers = await loadNumbersFromCSV(csvFilePath);
    
            if (numbers.length === 0) {
                return res.status(400).json({ error: 'No se encontraron números válidos' });
            }
    
            await messageQueue.add(numbers, message, images, singleImage);
    
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
            // Limpieza de archivos
            if (req.files) {
                Object.values(req.files).flat().forEach(file => {
                    if (fs.existsSync(file.path)) {
                        fs.unlinkSync(file.path);
                    }
                });
            }
        }
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

    // Inicia el servidor
    app.listen(port, () => {
        console.log(`Servidor escuchando en http://localhost:${port}`);
    });
};

// Inicia la aplicación
main().catch(console.error);