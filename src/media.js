const path = require('path');
const fs = require('fs');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const { tempDir, uploadsDir } = require('./config');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);

async function convertAudioToOpus(inputPath, userId = 'default') {
  if (!fs.existsSync(inputPath)) throw new Error(`Archivo de entrada no encontrado: ${inputPath}`);
  !fs.existsSync(tempDir) && fs.mkdirSync(tempDir, { recursive: true });

  // Incluir userId en el nombre del archivo para evitar conflictos entre usuarios
  const timestamp = Date.now();
  const fileName = `audio_${userId}_${timestamp}.m4a`;
  const out = path.join(tempDir, fileName);
  
  console.log(`[AUDIO] Iniciando conversión: ${inputPath} -> ${out}`);
  
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec('aac')     // AAC es el formato más compatible con iOS
      .audioBitrate('64k')   // Bitrate más bajo para mejor compatibilidad
      .audioChannels(1)      // Mono para mensajes de voz
      .audioFrequency(44100) // Frecuencia estándar para mejor calidad
      .outputOptions([
        '-f', 'mp4',               // Contenedor MP4 
        '-movflags', '+faststart', // Optimización para reproducción inmediata
        '-profile:a', 'aac_low',   // Perfil AAC de baja complejidad
        '-avoid_negative_ts', 'make_zero', // Evitar timestamps negativos
        '-fflags', '+genpts'       // Generar timestamps si faltan
      ])
      .format('mp4')
      .on('start', (commandLine) => {
        console.log(`[AUDIO] Ejecutando FFmpeg: ${commandLine}`);
      })
      .on('progress', (progress) => {
        console.log(`[AUDIO] Progreso: ${Math.round(progress.percent || 0)}%`);
      })
      .on('end', () => {
        console.log(`[AUDIO] Conversión completada: ${out}`);
        if (!fs.existsSync(out)) return reject(new Error('El archivo convertido no existe'));
        const size = fs.statSync(out).size;
        console.log(`[AUDIO] Tamaño del archivo convertido: ${size} bytes`);
        if (size <= 0) return reject(new Error('El archivo convertido está vacío'));
        
        // Verificar duración mínima
        setTimeout(() => {
          if (!fs.existsSync(out)) return reject(new Error('El archivo se eliminó antes de completar la verificación'));
          resolve(out);
        }, 100);
      })
      .on('error', (err) => {
        console.error(`[AUDIO] Error en conversión: ${err.message}`);
        reject(err);
      })
      .save(out);
  });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    !fs.existsSync(uploadsDir) && fs.mkdirSync(uploadsDir, { recursive: true });
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    if (file.fieldname === 'audioFile') {
      const ext = path.extname(file.originalname);
      const unique = `${Date.now()}-${Math.round(Math.random()*1e9)}`;
      // Incluir userId para evitar conflictos entre usuarios
      const userId = req.auth?.sub || req.auth?.id || 'default';
      cb(null, `audio_${userId}_${unique}${ext}`);
    } else {
      cb(null, file.originalname);
    }
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'audioFile' && !file.mimetype.startsWith('audio/')) {
      return cb(new Error('Formato de archivo no soportado. Solo audio.'));
    }
    cb(null, true);
  }
});

module.exports = {
  convertAudioToOpus,
  upload
};