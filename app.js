const { createBot, createProvider, createFlow, EVENTS } = require('@bot-whatsapp/bot');
require('dotenv').config();
const express = require('express');
const BaileysProvider = require('@bot-whatsapp/provider/baileys');
const MockAdapter = require('@bot-whatsapp/database/mock');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const csv = require('csv-parser');
const cron = require('node-cron');

let isSendingMessages = false;
let currentBatchIndex = 0;
const app = express();
const port = 3000;

let adapterProvider;

app.use(express.static('public'));
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

// Función para leer y cargar números del archivo CSV con validación
const loadNumbersFromCSV = (filePath) => {
    return new Promise((resolve, reject) => {
        const numbers = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                const number = Object.values(row)[0].trim();
                if (number && /^\d+$/.test(number)) {
                    numbers.push(number);
                } else {
                    console.error(`Número inválido encontrado: ${number}`);
                }
            })
            .on('end', () => {
                if (numbers.length === 0) {
                    reject(new Error('El archivo CSV no contiene números válidos.'));
                } else {
                    resolve(numbers);
                }
            })
            .on('error', reject);
    });
};

// Función para enviar mensajes e imágenes en paralelo por lotes con manejo de errores y logs
const sendMessagesInBatches = async (numbers, message, images, singleImage, batchSize) => {
    isSendingMessages = true;

    const numberChunks = chunkArray(numbers, batchSize);
    let totalSent = 0;

    for (let i = currentBatchIndex; i < numberChunks.length; i++) {
        const chunk = numberChunks[i];
        let batchSent = 0;

        console.log(`Enviando lote ${i + 1} de ${numberChunks.length}, total números en este lote: ${chunk.length}`);

        await Promise.all(
            chunk.map(async (number) => {
                try {
                    if (singleImage) {
                        const imagePath = singleImage.path;
                        await adapterProvider.sendImage(`${number}@c.us`, imagePath, message);
                    } else {
                        await adapterProvider.sendText(`${number}@c.us`, message);
                        if (images && images.length > 0) {
                            for (const image of images) {
                                const imagePath = image.path;
                                await adapterProvider.sendImage(`${number}@c.us`, imagePath);
                            }
                        }
                    }
                    batchSent += 1;
                } catch (error) {
                    console.error(`Error enviando mensaje a ${number}: ${error.message}`);
                }
            })
        );

        console.log(`Mensajes enviados exitosamente en lote ${i + 1}: ${batchSent} de ${chunk.length}`);
        totalSent += batchSent;

        currentBatchIndex = i + 1;  // Actualiza el índice del lote actual

        await new Promise(resolve => setTimeout(resolve, 100)); // Retraso opcional entre lotes
    }

    console.log(`Total de mensajes enviados exitosamente: ${totalSent} de ${numbers.length}`);
    isSendingMessages = false;
    currentBatchIndex = 0;  // Restablece el índice después de completar el envío
};

const chunkArray = (array, chunkSize) => {
    const results = [];
    for (let i = 0; i < array.length; i += chunkSize) {
        results.push(array.slice(i, i + chunkSize));
    }
    return results;
};

const main = async () => {
    const adapterDB = new MockAdapter();
    const adapterFlow = createFlow([]);
    adapterProvider = createProvider(BaileysProvider);

    if (adapterProvider) {
        adapterProvider.on(EVENTS.CONNECTION_CLOSE, async () => {
            console.log("Conexión cerrada. Intentando reconectar...");
            await adapterProvider.reconnect();
        });

        adapterProvider.on(EVENTS.CONNECTION_OPEN, async () => {
            console.log("Conexión restablecida. Continuando con el envío de mensajes.");
            if (isSendingMessages) {
                await sendMessagesInBatches(currentNumbers, currentMessage, currentImages, currentSingleImage, currentBatchSize);
            }
        });
    }

    createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    app.post('/send-messages', upload.fields([{ name: 'csvFile', maxCount: 1 }, { name: 'images', maxCount: 10 }, { name: 'singleImage', maxCount: 1 }]), async (req, res) => {
        const { message } = req.body;

        if (!req.files || !req.files['csvFile']) {
            return res.status(400).send({ error: 'Archivo CSV no proporcionado' });
        }

        const csvFilePath = req.files['csvFile'][0].path;
        const images = req.files['images'];
        const singleImage = req.files['singleImage'] ? req.files['singleImage'][0] : null;
        const batchSize = 100;

        try {
            const numbers = await loadNumbersFromCSV(csvFilePath);

            if (numbers.length === 0) {
                return res.status(400).send({ error: 'No se encontraron números válidos en el archivo CSV.' });
            }

            // Almacena los parámetros actuales para continuar el envío después de la reconexión
            global.currentNumbers = numbers;
            global.currentMessage = message;
            global.currentImages = images;
            global.currentSingleImage = singleImage;
            global.currentBatchSize = batchSize;

            await sendMessagesInBatches(numbers, message, images, singleImage, batchSize);

            res.send({ data: 'Mensajes enviados!' });
        } catch (error) {
            res.status(500).send({ error: `Error al procesar el archivo CSV o las imágenes: ${error.message}` });
        } finally {
            fs.unlinkSync(csvFilePath);
            if (images) {
                images.forEach(image => fs.unlinkSync(image.path));
            }
            if (singleImage) {
                fs.unlinkSync(singleImage.path);
            }
        }
    });

    app.get('/qr', (req, res) => {
        const qrPath = path.join(__dirname, 'bot.qr.png');
        res.sendFile(qrPath);
    });

    app.listen(port, () => {
        console.log(`Servidor escuchando en http://localhost:${port}`);
    });
};

cron.schedule('0 */6 * * *', async () => { // cada 6 horas
    if (isSendingMessages) {
        console.log("Envio de mensajes en curso. Cronjob pospuesto.");
        return;
    }

    try {
        if (adapterProvider) {
            console.log("Reiniciando bot...");
            await adapterProvider.reconnect();
        } else {
            console.log("No hay sesión...");
        }
    } catch (error) {
        console.error(error);
    }
});

main();
