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

    app.post('/send-messages', upload.single('csvFile'), async (req, res) => {
        const { message } = req.body;
        const csvFilePath = req.file.path; // Ruta del archivo CSV subido
        const delay = 100; // 2000 milisegundos = 2 segundos

        try {
            const numbers = await loadNumbersFromCSV(csvFilePath);
            await sendMessagesWithDelay(numbers, message, delay);
            res.send({ data: 'Mensajes enviados!' });
        } catch (error) {
            res.status(500).send({ error: 'Error al procesar el archivo CSV' });
        } finally {
            // Borrar el archivo CSV después de procesarlo
            fs.unlinkSync(csvFilePath);
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
