const { Queue, Worker, QueueEvents, JobsOptions } = require('bullmq');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const { getRedisConnectionOptions, getRedis } = require('./redisClient');
const sessionManager = require('./sessionManager');
const { messageDelay, tempDir } = require('./config');
const { convertAudioToOpus } = require('./media');

const s3 = require('./storage/s3');

const delayFactor = Math.max(0.5, Number(process.env.MESSAGE_DELAY_FACTOR || 1));
const BASE_DELAY = Math.max(800, Math.floor(messageDelay * delayFactor));
const LOOP_IDLE_MS   = BASE_DELAY;
const SEND_BETWEEN_MS = BASE_DELAY;

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

const connection = getRedisConnectionOptions();
const QUEUE_NAME = 'ms:messages';

const queue = new Queue(QUEUE_NAME, { connection });
const events = new QueueEvents(QUEUE_NAME, { connection });
events.on('failed', ({ jobId, failedReason }) => logger.warn({ jobId, failedReason }, 'Job failed'));

// Redis keys helpers
function statusKey(userId){ return `ms:status:${userId}`; }
function progressKey(userId){ return `ms:progress:${userId}`; }

async function resetStatus(userId, total){
  const r = getRedis();
  await r.hset(statusKey(userId), {
    total: String(total), sent: '0', errors: '0', completed: '0',
    startedAt: String(Date.now()), updatedAt: String(Date.now()),
  });
}

async function incField(userId, field, by = 1){
  const r = getRedis();
  await r.hincrby(statusKey(userId), field, by);
  await r.hset(statusKey(userId), 'updatedAt', String(Date.now()));
}

async function markCompleted(userId){
  const r = getRedis();
  await r.hset(statusKey(userId), { completed: '1', finishedAt: String(Date.now()) });
}

async function getStatus(userId){
  const r = getRedis();
  const data = await r.hgetall(statusKey(userId));
  if (!data || Object.keys(data).length === 0) {
    return { total: 0, sent: 0, errors: 0, completed: true, messages: [] };
  }
  return {
    total: Number(data.total||0),
    sent: Number(data.sent||0),
    errors: Number(data.errors||0),
    completed: data.completed === '1',
    messages: [],
  };
}

// Public API: enqueue campaign
async function enqueueCampaign(userId, numbers, message, images, singleImage, audio) {
  await resetStatus(userId, numbers.length);
  const job = await queue.add('campaign', { userId, numbers, message, images, singleImage, audio }, { removeOnComplete: 100, removeOnFail: 200 });
  return { jobId: job.id };
}

// Helpers
function processMessageVariables(message, variables) {
  if (!message) return message;
  let processedMessage = message;
  if (variables && Object.keys(variables).length > 0) {
    Object.entries(variables).forEach(([key, value]) => {
      if (value) {
        const placeholder = `{${key}}`;
        const regex = new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'gi');
        processedMessage = processedMessage.replace(regex, value);
      }
    });
  }
  processedMessage = processedMessage.replace(/\s*\{[^}]+\}\s*/g, ' ');
  processedMessage = processedMessage.replace(/\s+/g, ' ').trim();
  return processedMessage;
}

async function getImageBufferCached(cache, img){
  if (!img) return null;
  const key = img.s3Key ? `s3:${img.s3Key}` : (img.path ? `fs:${img.path}` : null);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  let buf;
  if (img.s3Key) {
    buf = await s3.getObjectBuffer(img.s3Key);
  } else if (img.path && fs.existsSync(img.path)) {
    buf = fs.readFileSync(img.path);
  } else {
    throw new Error(`Archivo de imagen no encontrado${img.path ? ': ' + img.path : ''}`);
  }
  cache.set(key, buf);
  return buf;
}

async function ensureConvertedAudio(userId, audio) {
  if (!audio || !audio.s3Key) return null;
  const origKey = audio.s3Key;
  const convKey = origKey.replace(/(\.[^./]+)?$/, '-converted.m4a');
  // Intentar usar objeto convertido existente
  try {
    const exists = await s3.existsObject(convKey);
    if (exists) return { s3Key: convKey, mimetype: 'audio/mp4' };
  } catch {}

  // Descargar original, convertir y subir
  const localOrig = path.join(tempDir, `audio_download_${userId}_${Date.now()}`);
  const localConv = await (async () => {
    const buf = await s3.getObjectBuffer(origKey);
    fs.writeFileSync(localOrig, buf);
    try {
      const out = await convertAudioToOpus(localOrig, userId);
      const convBuf = fs.readFileSync(out);
      await s3.putObjectFromBuffer(convKey, convBuf, 'audio/mp4');
      try { fs.unlinkSync(out); } catch {}
      return out;
    } finally {
      try { fs.unlinkSync(localOrig); } catch {}
    }
  })();
  try { if (localConv && fs.existsSync(localConv)) fs.unlinkSync(localConv); } catch {}
  return { s3Key: convKey, mimetype: 'audio/mp4' };
}

async function processCampaign(job){
  const { userId, numbers, message, images, singleImage, audio } = job.data;
  const manager = await sessionManager.getSession(userId);
  if (!manager || !manager.sock) {
    await sessionManager.initializeSession(userId);
  }
  const client = (await sessionManager.getSession(userId)).sock;
  if (!client || !client.user) throw new Error('Socket de WhatsApp no está listo');

  // Preparaciones de media
  const imageCache = new Map();
  let convertedAudio = null;
  if (audio && audio.s3Key) {
    convertedAudio = await ensureConvertedAudio(userId, audio);
  }

  let sent = 0;
  for (let i = 0; i < numbers.length; i++) {
    const entry = numbers[i];
    const number = typeof entry === 'string' ? entry : entry.number;
    const variables = typeof entry === 'object' && entry.variables ? entry.variables : {};

    const processedMessage = processMessageVariables(message, variables || {});
    const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;

    try {
      if (manager && typeof manager.waitForRateLimit === 'function') {
        await manager.waitForRateLimit();
      }

      // Audio primero si existe
      if (convertedAudio) {
        const buf = await s3.getObjectBuffer(convertedAudio.s3Key);
        await client.sendMessage(jid, { audio: buf, mimetype: 'audio/mp4', ptt: true });
        if (processedMessage) {
          await sleep(SEND_BETWEEN_MS);
          await client.sendMessage(jid, { text: processedMessage });
        }
      } else if (singleImage) {
        const buf = await getImageBufferCached(imageCache, singleImage);
        await client.sendMessage(jid, { image: buf, caption: processedMessage || '' });
      } else if (images && images.length > 0) {
        for (let k = 0; k < images.length; k++) {
          const img = images[k];
          const buf = await getImageBufferCached(imageCache, img);
          await client.sendMessage(jid, { image: buf, caption: k === 0 ? (processedMessage || '') : '' });
          if (k < images.length - 1) await sleep(SEND_BETWEEN_MS);
        }
      } else if (processedMessage) {
        await client.sendMessage(jid, { text: processedMessage });
      } else {
        throw new Error('No se proporcionó contenido');
      }

      sent++;
      await incField(userId, 'sent', 1);
    } catch (err) {
      logger.warn(`Error enviando a ${number}: ${err?.message}`);
      await incField(userId, 'errors', 1);
    }

    await sleep(SEND_BETWEEN_MS);
  }

  await markCompleted(userId);

  // Limpieza condicional en S3
  try {
    if (s3.isEnabled() && s3.shouldDeleteAfterSend()) {
      // borrar imágenes
      if (Array.isArray(images)) {
        for (const img of images) if (img?.s3Key) await s3.deleteObject(img.s3Key);
      }
      if (singleImage?.s3Key) await s3.deleteObject(singleImage.s3Key);
      if (convertedAudio?.s3Key) await s3.deleteObject(convertedAudio.s3Key);
      if (audio?.s3Key) await s3.deleteObject(audio.s3Key);
    }
  } catch {}
}

// Worker
const worker = new Worker(QUEUE_NAME, async (job) => {
  if (job.name === 'campaign') {
    return await processCampaign(job);
  }
}, { connection, concurrency: 1 });

worker.on('completed', (job) => logger.info({ jobId: job.id }, 'Job completed'));
worker.on('failed', (job, err) => logger.warn({ jobId: job?.id, err: err?.message }, 'Job failed'));

module.exports = {
  enqueueCampaign,
  getStatus,
};
