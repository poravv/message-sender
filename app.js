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

// Función para leer y cargar números del archivo CSV
const loadNumbersFromCSV = (filePath) => {
    return new Promise((resolve, reject) => {
        const numbers = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                const number = Object.values(row)[0]; // Asumimos que los números están en la primera columna
                if (number) {
                    numbers.push(number);
                }
            })
            .on('end', () => {
                resolve(numbers);
            })
            .on('error', reject);
    });
};

// Función para enviar mensajes con retraso
const sendMessagesWithDelay = async (numbers, message, delay) => {
    for (const number of numbers) {
        await adapterProvider.sendText(`${number}@c.us`, message);
        await new Promise(resolve => setTimeout(resolve, delay));
    }
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
    
        // Verifica si el archivo CSV fue subido
        if (!req.files || !req.files['csvFile']) {
            return res.status(400).send({ error: 'Archivo CSV no proporcionado' });
        }
    
        const csvFilePath = req.files['csvFile'][0].path; // Ruta del archivo CSV subido
        const images = req.files['images']; // Varias imágenes subidas
        const singleImage = req.files['singleImage'] ? req.files['singleImage'][0] : null; // Una sola imagen subida con comentario
        const delay = 5; // 5 milisegundos
    
        try {
            const numbers = await loadNumbersFromCSV(csvFilePath);
    
            // Enviar mensajes e imágenes a cada número
            for (const number of numbers) {
                if (singleImage) {
                    // Si hay una sola imagen, enviarla con el mensaje como pie de foto
                    const imagePath = singleImage.path;
                    await adapterProvider.sendImage(`${number}@c.us`, imagePath, message);
                } else {
                    // Si no, enviar el mensaje de texto primero
                    await adapterProvider.sendText(`${number}@c.us`, message);
    
                    // Enviar varias imágenes si están presentes
                    if (images && images.length > 0) {
                        for (const image of images) {
                            const imagePath = image.path;
                            await adapterProvider.sendImage(`${number}@c.us`, imagePath);
                        }
                    }
                }
    
                // Esperar el retraso definido entre cada envío
                await new Promise(resolve => setTimeout(resolve, delay));
            }
    
            res.send({ data: 'Mensajes enviados!' });
        } catch (error) {
            res.status(500).send({ error: 'Error al procesar el archivo CSV o las imágenes' });
        } finally {
            // Borrar los archivos CSV e imágenes después de procesarlos
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
