const path = require('path');
const fs = require('fs');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const { tempDir, uploadsDir } = require('./config');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);

async function convertAudioToOpus(inputPath) {
  if (!fs.existsSync(inputPath)) throw new Error(`Archivo de entrada no encontrado: ${inputPath}`);
  !fs.existsSync(tempDir) && fs.mkdirSync(tempDir, { recursive: true });

  const out = path.join(tempDir, `audio_${Date.now()}.mp3`);
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .audioChannels(2)
      .audioFrequency(44100)
      .outputOptions(['-write_xing 0', '-id3v2_version 0', '-ar 44100'])
      .format('mp3')
      .on('end', () => {
        if (!fs.existsSync(out)) return reject(new Error('El archivo convertido no existe'));
        const size = fs.statSync(out).size;
        if (size <= 0) return reject(new Error('El archivo convertido está vacío'));
        resolve(out);
      })
      .on('error', reject)
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
      cb(null, `audio_${unique}${ext}`);
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