const { createBot, createProvider, createFlow, addKeyword, EVENTS } = require('@bot-whatsapp/bot');
require('dotenv').config();
const express = require('express');
const QRPortalWeb = require('@bot-whatsapp/portal');
const BaileysProvider = require('@bot-whatsapp/provider/baileys');
const MockAdapter = require('@bot-whatsapp/database/mock');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const csv = require('csv-parser');

const app = express();
const port = 3000;

let adapterProvider; // Definir adapterProvider fuera del scope de main

app.use(express.static('public'));
app.use(express.json()); // Para poder parsear JSON en el cuerpo de la solicitud

const upload = multer({ dest: 'uploads/' }); // Middleware para manejar archivos subidos

// Función para leer y cargar números del archivo CSV con validación
const loadNumbersFromCSV = (filePath) => {
    return new Promise((resolve, reject) => {
        const numbers = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                const number = Object.values(row)[0].trim(); // Eliminar espacios en blanco
                // Validar que el número no esté vacío y que sea un valor numérico
                if (number && /^\d+$/.test(number)) {
                    numbers.push(number);
                } else {
                    console.error(`Número inválido encontrado: ${number}`); // Log de error para debugging
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

// Función para enviar mensajes e imágenes en paralelo por lotes con manejo de errores
const sendMessagesInBatches = async (numbers, message, images, singleImage, batchSize) => {
    const numberChunks = chunkArray(numbers, batchSize);

    for (const chunk of numberChunks) {
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
                } catch (error) {
                    console.error(`Error enviando mensaje a ${number}: ${error.message}`);
                }
            })
        );
        await new Promise(resolve => setTimeout(resolve, 100)); // Retraso opcional entre lotes
    }
};

// Función para dividir un array en partes más pequeñas
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
    adapterProvider = createProvider(BaileysProvider); // Inicializar aquí

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
        const qrPath = path.join(__dirname, 'bot.qr.png'); // Ajusta la ruta según tu estructura de carpetas
        res.sendFile(qrPath);
    });

    app.listen(port, () => {
        console.log(`Servidor escuchando en http://localhost:${port}`);
    });
};

main();
