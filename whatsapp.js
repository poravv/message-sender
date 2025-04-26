const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { parsePhoneNumber } = require('libphonenumber-js');

class WhatsAppManager {
    constructor() {
        this.client = null;
        this.isReady = false;
        this.qrCode = null;
        this.connectionState = 'disconnected';
        this.lastActivity = Date.now();
        this.messageQueue = null;
        this.logger = pino({ level: 'silent' });
        this.authFolder = path.join(__dirname, 'bot_sessions');
    }

    async initialize() {
        if (this.client) return;

        try {
            // Asegurar que existe el directorio de autenticación
            if (!fs.existsSync(this.authFolder)) {
                fs.mkdirSync(this.authFolder, { recursive: true });
            }

            // Asegurar que existe el directorio public para el QR
            const publicDir = path.join(__dirname, 'public');
            if (!fs.existsSync(publicDir)) {
                fs.mkdirSync(publicDir, { recursive: true });
                console.log('Directorio public creado');
            }
            
            // Crear un QR provisional en caso de que Baileys no genere uno
            const qrcode = require('qrcode');
            const qrPath = path.join(publicDir, 'qr.png');
            try {
                await qrcode.toFile(qrPath, 'Inicializando conexión...', {
                    type: 'png',
                    margin: 2,
                    width: 400
                });
                console.log('QR provisional creado en:', qrPath);
            } catch (err) {
                console.error('Error creando QR provisional:', err);
            }

            // Cargar estado de autenticación
            const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);

            // Crear cliente de WhatsApp con configuración para evitar errores 515
            this.client = makeWASocket({
                auth: state,
                printQRInTerminal: true,
                browser: ['WhatsApp Desktop', 'Desktop', ''],
                logger: pino({ level: 'silent' }),
                mobile: false,
                defaultQueryTimeoutMs: 0,
                qrTimeout: 0,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 10000,
                emitOwnEvents: true,
                markOnlineOnConnect: true,
                // Esta configuración es crítica para evitar errores 515
                version: undefined,
                transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
                getMessage: async () => undefined
            });

            // Manejar eventos de conexión
            this.client.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                // Manejo del código QR
                if (qr) {
                    try {
                        this.qrCode = qr;
                        this.connectionState = 'qr';
                        console.log('Nuevo código QR recibido');
                        
                        // Crear directorio public si no existe
                        const publicDir = path.join(__dirname, 'public');
                        if (!fs.existsSync(publicDir)) {
                            fs.mkdirSync(publicDir, { recursive: true });
                        }
                        
                        // Guardar QR como imagen usando método directo con más compatibilidad
                        const qrPath = path.join(publicDir, 'qr.png');
                        
                        // Generar QR usando qrcode-terminal primero (para consola)
                        const qrcodeTerminal = require('qrcode-terminal');
                        qrcodeTerminal.generate(qr, { small: true });
                        
                        // Ahora generar el archivo PNG para la interfaz web
                        const qrcode = require('qrcode');
                        console.log('Generando archivo QR en:', qrPath);
                        
                        try {
                            fs.writeFileSync(qrPath + '.txt', qr);
                            console.log('Contenido QR guardado en texto plano');
                        } catch (err) {
                            console.error('Error guardando texto QR:', err);
                        }
                        
                        await qrcode.toFile(qrPath, qr, {
                            type: 'png',
                            quality: 1,
                            margin: 2,
                            width: 600,
                            color: {
                                dark: '#000000',
                                light: '#ffffff'
                            }
                        });
                        
                        // Verificar si se creó el archivo
                        if (fs.existsSync(qrPath)) {
                            console.log('✅ QR guardado exitosamente en:', qrPath);
                            this.lastQRUpdate = Date.now();
                        } else {
                            console.error('❌ El archivo QR no se creó correctamente');
                        }
                    } catch (error) {
                        console.error('Error al guardar el QR:', error);
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    console.log('Conexión cerrada. Código de estado:', statusCode);
                    
                    // Manejar diferentes casos de desconexión
                    if (statusCode === 515) {
                        console.log('Error de versión del protocolo, intentando con configuración alternativa...');
                        await this.deleteSessionFiles();
                        this.connectionState = 'disconnected';
                        this.isReady = false;
                        this.client = null;
                        // Esperar un momento antes de reintentar
                        setTimeout(async () => {
                            try {
                                await this.initialize();
                            } catch (err) {
                                console.error('Error en reinicio:', err);
                            }
                        }, 3000);
                    } else if (statusCode === DisconnectReason.loggedOut || 
                             statusCode === DisconnectReason.connectionClosed) {
                        console.log('Sesión cerrada o desconectada');
                        this.connectionState = 'disconnected';
                        this.isReady = false;
                        this.client = null;
                        await this.deleteSessionFiles();
                        setTimeout(() => this.initialize(), 2000);
                    } else {
                        console.log('Intentando reconexión...');
                        this.client = null;
                        setTimeout(() => this.initialize(), 2000);
                    }
                }
                } else if (connection === 'open') {
                    console.log('Conexión establecida!');
                    this.isReady = true;
                    this.connectionState = 'connected';
                    this.lastActivity = Date.now();

                    // Verificar número autorizado
                    const connectedNumber = this.client.user.id.split(':')[0];
                    if (!this.isAuthorizedPhone(connectedNumber)) {
                        console.log('Número no autorizado, desconectando...');
                        await this.logout();
                        return;
                    }

                    // Inicializar cola de mensajes
                    this.messageQueue = new MessageQueue(this);
                }
            });

            // Guardar credenciales cuando cambien
            this.client.ev.on('creds.update', saveCreds);

            return true;
        } catch (error) {
            console.error('Error inicializando cliente WhatsApp:', error);
            return false;
        }
    }

    async generateQRImage(qr, qrPath) {
        const qrcode = require('qrcode');
        try {
            console.log('Generando QR...');
            
            // Asegurarse de que el directorio public existe
            const publicDir = path.dirname(qrPath);
            if (!fs.existsSync(publicDir)) {
                fs.mkdirSync(publicDir, { recursive: true });
                console.log('Directorio public creado:', publicDir);
            }

            // Eliminar el archivo QR anterior si existe
            if (fs.existsSync(qrPath)) {
                fs.unlinkSync(qrPath);
                console.log('QR anterior eliminado');
            }

            // Generar el nuevo QR con opciones optimizadas
            await qrcode.toFile(qrPath, qr, {
                type: 'png',
                quality: 0.95,
                color: {
                    dark: '#128C7E',
                    light: '#FFFFFF'
                },
                width: 512,
                margin: 1,
                errorCorrectionLevel: 'L'
            });
            
            console.log('Nuevo QR generado y guardado en:', qrPath);
            this.lastQRUpdate = Date.now();
            this.qrCode = qr;
            
            // Verificar que el archivo se creó correctamente
            if (!fs.existsSync(qrPath)) {
                throw new Error('El archivo QR no se generó correctamente');
            }
        } catch (err) {
            console.error('Error al generar archivo QR:', err);
            throw err;
        }
    }

    isAuthorizedPhone(phoneNumber) {
        const authorizedPhones = process.env.AUTHORIZED_PHONES ? 
            process.env.AUTHORIZED_PHONES.split(',').map(p => p.trim()) :
            ['595992756462'];
        return authorizedPhones.some(auth => phoneNumber.includes(auth));
    }

    async logout() {
        try {
            if (this.client) {
                try {
                    await this.client.logout().catch(() => {});
                } catch (error) {
                    console.log('Error en logout, continuando...:', error);
                }
                
                // Independientemente del resultado del logout, limpiamos todo
                await this.deleteSessionFiles();
                this.client = null;
                this.isReady = false;
                this.connectionState = 'disconnected';
                this.qrCode = null;
                
                // Inicializar una nueva instancia para obtener un nuevo QR
                await this.initialize();
                return true;
            }
            return false;
        } catch (error) {
            console.error('Error en logout:', error);
            return false;
        }
    }

    async deleteSessionFiles() {
        try {
            if (fs.existsSync(this.authFolder)) {
                fs.rmSync(this.authFolder, { recursive: true, force: true });
            }
        } catch (error) {
            console.error('Error al eliminar archivos de sesión:', error);
        }
    }

    async refreshQR() {
        try {
            console.log('Iniciando proceso de refresco de QR...');
            
            // Limpiar cliente existente
            if (this.client) {
                console.log('Cerrando conexión existente...');
                try {
                    this.client.ev.removeAllListeners();
                    await this.client.logout().catch(() => {});
                } catch (error) {
                    console.log('Error al cerrar conexión:', error);
                }
                this.client = null;
            }

            // Limpiar archivos de sesión
            console.log('Limpiando archivos de sesión...');
            await this.deleteSessionFiles();
            
            // Limpiar estado
            this.isReady = false;
            this.connectionState = 'disconnected';
            this.qrCode = null;
            
            // Eliminar archivo QR existente
            const qrPath = path.join(__dirname, 'public', 'qr.png');
            if (fs.existsSync(qrPath)) {
                fs.unlinkSync(qrPath);
            }
            
            console.log('Iniciando nueva conexión...');
            // Iniciar nueva conexión
            const success = await this.initialize();
            
            if (success) {
                console.log('Nueva conexión iniciada exitosamente');
                return true;
            } else {
                console.error('Error al iniciar nueva conexión');
                return false;
            }
        } catch (error) {
            console.error('Error en el proceso de refresco de QR:', error);
            return false;
        }
    }

    getState() {
        return {
            isReady: this.isReady,
            connectionState: this.connectionState,
            lastActivity: this.lastActivity,
            lastQRUpdate: this.lastQRUpdate || null,
            hasQR: !!this.qrCode
        };
    }

    updateActivity() {
        this.lastActivity = Date.now();
    }
}

class MessageQueue {
    constructor(whatsappManager) {
        this.manager = whatsappManager;
        this.queue = [];
        this.isProcessing = false;
        this.retryQueue = [];
        this.maxRetries = 3;
        this.retryDelay = 5000;
        this.batchSize = 5;
        this.messageStats = {
            total: 0,
            sent: 0,
            errors: 0,
            messages: [],
            completed: false
        };
    }

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
    }

    async sendMessage(item) {
        const { number, message, images, singleImage, audioFile } = item;
        
        try {
            const jid = `${number}@s.whatsapp.net`;
            
            // Verificar si el número existe en WhatsApp
            const [result] = await this.manager.client.onWhatsApp(number);
            if (!result?.exists) {
                throw new Error(`El número ${number} no está registrado en WhatsApp`);
            }

            // Enviar audio
            if (audioFile) {
                const audioData = await this.processAudioFile(audioFile.path);
                await this.manager.client.sendMessage(jid, { audio: audioData, ptt: true });
                
                if (message?.trim()) {
                    await this.manager.client.sendMessage(jid, { text: message });
                }
            }
            // Enviar imagen simple con mensaje
            else if (singleImage) {
                await this.manager.client.sendMessage(jid, {
                    image: { url: singleImage.path },
                    caption: message || undefined
                });
            }
            // Enviar múltiples imágenes
            else if (images?.length > 0) {
                if (message?.trim()) {
                    await this.manager.client.sendMessage(jid, { text: message });
                }

                for (const img of images) {
                    await this.manager.client.sendMessage(jid, {
                        image: { url: img.path }
                    });
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            // Solo mensaje de texto
            else if (message?.trim()) {
                await this.manager.client.sendMessage(jid, { text: message });
            } else {
                throw new Error('No se proporcionó ningún contenido para enviar');
            }

            return true;
        } catch (error) {
            console.error(`Error enviando mensaje a ${number}:`, error);
            throw error;
        }
    }

    async processAudioFile(audioPath) {
        const ffmpeg = require('fluent-ffmpeg');
        const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
        ffmpeg.setFfmpegPath(ffmpegPath);

        const outputPath = path.join(
            path.dirname(audioPath),
            `processed-${path.basename(audioPath)}.mp3`
        );

        return new Promise((resolve, reject) => {
            ffmpeg(audioPath)
                .toFormat('mp3')
                .on('end', () => {
                    const buffer = fs.readFileSync(outputPath);
                    fs.unlinkSync(outputPath); // Limpiamos el archivo temporal
                    resolve(buffer);
                })
                .on('error', (err) => {
                    console.error('Error procesando audio:', err);
                    reject(err);
                })
                .save(outputPath);
        });
    }

    getStats() {
        return this.messageStats;
    }
}

module.exports = WhatsAppManager;
