const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { toBuffer } = require('@whiskeysockets/baileys');

// Configuración inicial
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

/**
 * Simula el provider de Baileys para pruebas
 */
const mockProvider = {
    getInstance: () => ({
        sendMessage: async (jid, message) => {
            console.log(`\nSimulando envío a ${jid}`);
            console.log('Tipo de mensaje:', message.mimetype);
            console.log('Duración:', message.seconds, 'segundos');
            console.log('Tamaño del audio:', message.audio?.length || 'N/A', 'bytes');
            return { status: 'success' };
        },
        sendText: async (jid, text) => {
            console.log(`\nMensaje adjunto: "${text}"`);
            return { status: 'success' };
        }
    })
};

/**
 * Función de conversión de audio (igual que en tu código real)
 */
async function convertAudioToWhatsApp(inputPath) {
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Archivo no encontrado: ${inputPath}`);
    }

    const outputPath = path.join(tempDir, `test_audio_${Date.now()}.ogg`);
    
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioCodec('libopus')
            .audioFrequency(16000)
            .audioChannels(1)
            .audioBitrate('24k')
            .outputOptions([
                '-application voip',
                '-frame_duration 60',
                '-vbr constrained',
                '-compression_level 10'
            ])
            .toFormat('ogg')
            .on('start', (cmd) => console.log('\nComando FFmpeg:', cmd))
            .on('progress', (progress) => console.log('Progreso:', progress.timemark))
            .on('error', (err) => {
                console.error('Error en conversión:', err);
                reject(err);
            })
            .on('end', () => {
                console.log('\nConversión completada:', outputPath);
                resolve(outputPath);
            })
            .save(outputPath);
    });
}

/**
 * Genera waveform simulada
 */
function generateWhatsAppWaveform(duration) {
    const waveform = new Uint8Array(32);
    const peaks = Math.min(30, Math.max(5, Math.floor(duration)));
    
    for (let i = 0; i < peaks; i++) {
        waveform[i] = Math.floor(Math.random() * 30) + 70;
    }
    
    return waveform;
}

/**
 * Obtiene duración del audio
 */
async function getAudioDuration(filePath) {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                console.error('Error obteniendo duración:', err);
                resolve(1);
            } else {
                resolve(metadata.format.duration || 1);
            }
        });
    });
}

/**
 * Función de prueba para enviar audio
 */
async function testSendAudio(audioFilePath, messageText = '') {
    let convertedPath; // Declarada aquí para que esté disponible en el finally
    
    try {
        console.log('\n=== INICIANDO PRUEBA ===');
        console.log('Archivo de audio:', audioFilePath);
        
        // 1. Convertir audio
        convertedPath = await convertAudioToWhatsApp(audioFilePath);
        
        // 2. Obtener metadatos
        const duration = await getAudioDuration(convertedPath);
        const waveform = generateWhatsAppWaveform(duration);
        console.log('\nMetadatos generados:');
        console.log('- Duración:', duration, 'segundos');
        console.log('- Waveform:', waveform);

        // 3. Leer archivo convertido
        const audioBuffer = await fs.promises.readFile(convertedPath);
        console.log('\nTamaño del buffer:', audioBuffer.length, 'bytes');

        // 4. Simular envío
        const jid = '1234567890@s.whatsapp.net'; // JID de prueba
        const sock = mockProvider.getInstance();
        
        await sock.sendMessage(jid, {
            audio: audioBuffer,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
            waveform: waveform,
            seconds: Math.ceil(duration),
            fileName: 'voice_message.ogg'
        });

        // Enviar mensaje adjunto si existe
        if (messageText) {
            await sock.sendText(jid, messageText);
        }

        console.log('\n=== PRUEBA EXITOSA ===');
        return true;
    } catch (error) {
        console.error('\n=== ERROR EN LA PRUEBA ===');
        console.error(error);
        return false;
    } finally {
        // Limpiar archivos temporales
        if (convertedPath && fs.existsSync(convertedPath)) {
            fs.unlinkSync(convertedPath);
            console.log('Archivo temporal eliminado:', convertedPath);
        }
    }
}

// Ejemplo de uso:
(async () => {
    // Crea un archivo de audio de prueba si no existe
    const testAudioPath = path.join(__dirname, 'test_audio.m4a');
    if (!fs.existsSync(testAudioPath)) {
        console.log('\nCreando archivo de audio de prueba...');
        // Este es un comando de ejemplo para generar un audio de prueba
        // Necesitas tener sox instalado: brew install sox
        try {
            const { execSync } = require('child_process');
            execSync(`sox -n -r 44100 -c 1 ${testAudioPath} synth 3 sine 440 vol 0.5`);
            console.log('Archivo de prueba creado:', testAudioPath);
        } catch (e) {
            console.error('Instala sox para crear audio de prueba: brew install sox');
            console.error('O usa tu propio archivo de audio cambiando testAudioPath');
            process.exit(1);
        }
    }

    // Ejecutar prueba
    await testSendAudio(testAudioPath, 'Este es un mensaje de prueba adjunto al audio');
})();