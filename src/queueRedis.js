/**
 * Redis key patterns (user-scoped):
 *
 * Queue & campaign keys (src/queueRedis.js):
 *   ms:status:{userId}              - campaign sending status (hash)                TTL: 24h
 *   ms:progress:{userId}            - campaign progress tracking (hash)             TTL: 24h
 *   ms:cancel:{userId}              - cancellation flag (string)                    TTL: 1h
 *   ms:lock:campaign:{userId}       - campaign execution lock (string)              TTL: 1h
 *   ms:list:{userId}                - message recipient list (string/JSON)          TTL: env REDIS_LIST_TTL_SECONDS (default 1h)
 *   ms:hb:{userId}                  - frontend heartbeat (string)                   TTL: env HEARTBEAT_TTL_SECONDS (default 5m)
 *   ms:events:{userId}              - event stream for UI (list)                    TTL: env EVENTS_TTL_SECONDS (default 1h)
 *
 * Session key (src/middleware/sessionGuard.js):
 *   ms:session:{userId}             - active session token (string/JSON)            TTL: 24h
 *
 * Metrics/cache keys (src/metricsStoreRedis.js / metricsStorePostgres.js):
 *   ms:contacts:{userId}            - contacts cache (hash)
 *   ms:contacts:idmap:{userId}      - contacts ID map cache (hash)
 *   ms:campaigns:{userId}           - campaigns cache (sorted set)
 *   ms:metrics:events:seq:{userId}  - metric event sequence (string)
 *   ms:metrics:events:z:{userId}    - metric events sorted set
 *   ms:metrics:events:h:{userId}    - metric events hash
 *   ms:metrics:monthly:sent:{userId}  - monthly sent stats (hash)
 *   ms:metrics:monthly:error:{userId} - monthly error stats (hash)
 *   ms:metrics:contact:stats:{userId} - contact-level stats (hash)
 *
 * WhatsApp/ownership keys:
 *   wa:owner:{userId}               - pod ownership (string)                        TTL: env REDIS_OWNER_TTL_SECONDS (default 60s)
 *   wa:auth:{userId}:*              - Baileys auth state (multiple keys)            TTL: env REDIS_TTL_SECONDS (default 12h) — DO NOT expire
 *   wa:lock:connect:{userId}        - per-user connection lock (string)             TTL: 30-45s (set by acquireLock)
 *
 * Global keys:
 *   ms:messages (BullMQ queue)      - message processing queue
 *   ms:campaign:seq                 - campaign ID sequence
 *   ms:campaign:data:{campaignId}   - campaign data (hash)
 *   ms:campaign:recipients:{campaignId} - campaign recipients (hash)
 */

const { Queue, Worker, QueueEvents, JobsOptions } = require('bullmq');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const { getRedisConnectionOptions, getRedis } = require('./redisClient');
const sessionManager = require('./sessionManager');
const { messageDelay, tempDir } = require('./config');
const { convertAudioToOpus } = require('./media');
const { acquireLock } = require('./redisLock');
const sessOwner = require('./owner');
const metricsStore = require('./metricsStore');

const s3 = require('./storage/s3');

const delayFactor = Math.max(0.5, Number(process.env.MESSAGE_DELAY_FACTOR || 1));
const BASE_DELAY = Math.max(800, Math.floor(messageDelay * delayFactor));
const LOOP_IDLE_MS = BASE_DELAY;
const SEND_BETWEEN_MS = BASE_DELAY;
const WORKER_CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 3));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const connection = getRedisConnectionOptions();
const QUEUE_NAME = 'ms:messages';

const queue = new Queue(QUEUE_NAME, { connection });
const events = new QueueEvents(QUEUE_NAME, { connection });
events.on('failed', ({ jobId, failedReason }) => logger.warn({ jobId, failedReason }, 'Job failed'));

// Redis keys helpers
function statusKey(userId) { return `ms:status:${userId}`; }
function progressKey(userId) { return `ms:progress:${userId}`; }
function cancelKey(userId) { return `ms:cancel:${userId}`; }
function campaignLockKey(userId) { return `ms:lock:campaign:${userId}`; }
function listKey(userId) { return `ms:list:${userId}`; }
function heartbeatKey(userId) { return `ms:hb:${userId}`; }
function eventsKey(userId) { return `ms:events:${userId}`; }

const STATUS_TTL = 24 * 60 * 60;    // 24h for status hash
const PROGRESS_TTL = 24 * 60 * 60;  // 24h for progress hash

async function resetStatus(userId, total) {
  const r = getRedis();
  await r.hset(statusKey(userId), {
    total: String(total), sent: '0', errors: '0', completed: '0', canceled: '0',
    startedAt: String(Date.now()), updatedAt: String(Date.now()),
  });
  await r.expire(statusKey(userId), STATUS_TTL);
}

async function incField(userId, field, amount = 1) {
  const r = getRedis();
  if (!r || r.status === 'end') return;
  try {
    await r.pipeline()
      .hincrby(statusKey(userId), field, amount)
      .hset(statusKey(userId), 'updatedAt', String(Date.now()))
      .expire(statusKey(userId), STATUS_TTL)
      .exec();
  } catch { }
}

async function markCompleted(userId) {
  const r = getRedis();
  await r.hset(statusKey(userId), { completed: '1', finishedAt: String(Date.now()) });
  await r.expire(statusKey(userId), STATUS_TTL);
}

async function markCanceled(userId) {
  const r = getRedis();
  await r.hset(statusKey(userId), {
    canceled: '1', completed: '1', finishedAt: String(Date.now()), canceledAt: String(Date.now()),
    updatedAt: String(Date.now()),
  });
  await r.expire(statusKey(userId), STATUS_TTL);
}

// Guardar/limpiar la lista de números en Redis (por usuario)
async function saveList(userId, numbers) {
  const r = getRedis();
  try {
    const ttl = Math.max(600, Number(process.env.REDIS_LIST_TTL_SECONDS || 3600));
    await r.set(listKey(userId), JSON.stringify(numbers || []), 'EX', ttl);
  } catch { }
}

async function clearList(userId) {
  const r = getRedis();
  try { await r.del(listKey(userId)); } catch { }
}

// Heartbeat por usuario (para detectar refresh/cierre)
async function touchHeartbeat(userId) {
  const r = getRedis();
  try {
    const ttl = Math.max(10, Number(process.env.HEARTBEAT_TTL_SECONDS || 300));
    await r.set(heartbeatKey(userId), String(Date.now()), 'EX', ttl);
  } catch { }
}

async function hasHeartbeat(userId) {
  const r = getRedis();
  try {
    const v = await r.get(heartbeatKey(userId));
    return !!v;
  } catch {
    return false;
  }
}

function validateNumbersArray(numbers) {
  if (!Array.isArray(numbers)) return { valid: false, invalidCount: 1 };
  let invalid = 0;
  for (const entry of numbers) {
    const n = String(typeof entry === 'string' ? entry : entry?.number || '').trim();
    const onlyDigits = /^\d+$/.test(n);
    const validLength = n.length === 12;
    const hasPrefix = n.startsWith('595');
    if (!onlyDigits || !validLength || !hasPrefix) invalid++;
  }
  return { valid: invalid === 0, invalidCount: invalid };
}

// Eventos (lista circular por usuario) para poblar el frontend
async function addEvent(userId, type, data = {}) {
  const r = getRedis();
  if (!r || r.status === 'end') return;
  try {
    const max = Math.max(10, Number(process.env.EVENTS_MAX || 200));
    const ttl = Math.max(600, Number(process.env.EVENTS_TTL_SECONDS || 3600));
    const ev = JSON.stringify({ type, ...data, timestamp: Date.now() });
    const key = eventsKey(userId);
    const statusK = statusKey(userId);

    await r.pipeline()
      .lpush(key, ev)
      .ltrim(key, 0, max - 1)
      .expire(key, ttl)
      .hset(statusK, 'updatedAt', String(Date.now()))
      .exec();
  } catch { }
}

async function getRecentEvents(userId, limit = 100) {
  const r = getRedis();
  try {
    const raw = await r.lrange(eventsKey(userId), 0, Math.max(0, Number(limit) - 1));
    return raw.map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

async function requestCancel(userId) {
  const r = getRedis();
  const ttl = Math.max(60, Number(process.env.REDIS_CANCEL_TTL_SECONDS || 600));
  await r.set(cancelKey(userId), '1', 'EX', ttl);
  await r.hset(statusKey(userId), { canceled: '1', updatedAt: String(Date.now()) });
  await r.expire(statusKey(userId), STATUS_TTL);
}

async function isCanceled(userId) {
  const r = getRedis();
  const val = await r.get(cancelKey(userId));
  return String(val) === '1';
}

async function clearCancel(userId) {
  const r = getRedis();
  try { await r.del(cancelKey(userId)); } catch { }
}

async function getStatus(userId) {
  const r = getRedis();
  const data = await r.hgetall(statusKey(userId));
  if (!data || Object.keys(data).length === 0) {
    return { total: 0, sent: 0, errors: 0, completed: true, canceled: false, messages: [] };
  }
  return {
    total: Number(data.total || 0),
    sent: Number(data.sent || 0),
    errors: Number(data.errors || 0),
    completed: data.completed === '1',
    canceled: data.canceled === '1',
    messages: [],
  };
}

function parseKeepPolicy(val, defaultVal) {
  if (val === undefined || val === null || val === '') return defaultVal;
  const s = String(val).trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('count:')) {
    const n = Number(s.split(':')[1] || '0');
    return isNaN(n) ? defaultVal : { count: Math.max(0, n) };
  }
  if (s.startsWith('age:')) {
    const n = Number(s.split(':')[1] || '0');
    return isNaN(n) ? defaultVal : { age: Math.max(0, n) };
  }
  const n = Number(s);
  if (!isNaN(n)) return Math.max(0, n);
  return defaultVal;
}

const REMOVE_ON_COMPLETE = parseKeepPolicy(process.env.QUEUE_REMOVE_ON_COMPLETE, true);
const REMOVE_ON_FAIL = parseKeepPolicy(process.env.QUEUE_REMOVE_ON_FAIL, { age: 3600 });

// Public API: enqueue campaign
async function enqueueCampaign(userId, numbers, templates, images, singleImage, audio, meta = {}) {
  await resetStatus(userId, numbers.length);
  await saveList(userId, numbers);
  const job = await queue.add('campaign', {
    userId,
    numbers,
    templates,
    images,
    singleImage,
    audio,
    campaignId: meta?.campaignId || null,
  }, { removeOnComplete: REMOVE_ON_COMPLETE, removeOnFail: REMOVE_ON_FAIL });
  try {
    const r = getRedis();
    await r.hset(statusKey(userId), { jobId: String(job.id), updatedAt: String(Date.now()) });
    await r.expire(statusKey(userId), STATUS_TTL);
    // Log event enqueue
    if (typeof addEvent === 'function') {
      await addEvent(userId, 'enqueue', { jobId: String(job.id), total: numbers.length, templateCount: templates?.length || 1 });
    }
  } catch { }
  return { jobId: job.id };
}

// Cancelar campañas de un usuario: marca cancel y elimina jobs en espera
async function cancelCampaign(userId) {
  await requestCancel(userId);
  try { if (typeof addEvent === 'function') await addEvent(userId, 'cancel_requested', {}); } catch { }
  // Remover jobs en espera/delayed del usuario
  const types = ['waiting', 'delayed', 'paused'];
  const jobs = await queue.getJobs(types, 0, -1, true);
  let removed = 0;
  for (const job of jobs) {
    try {
      if (job?.data?.userId === userId) { await job.remove(); removed++; }
    } catch { }
  }
  await markCanceled(userId);
  await clearProgress(userId);
  await clearList(userId);
  try { if (typeof addEvent === 'function') await addEvent(userId, 'job_canceled', { reason: 'cancel_api' }); } catch { }
  return { removed };
}

async function setProgress(userId, data) {
  const r = getRedis();
  const payload = {};
  if (data.currentIndex !== undefined) payload.currentIndex = String(data.currentIndex);
  if (data.total !== undefined) payload.total = String(data.total);
  if (data.number !== undefined) payload.number = String(data.number);
  if (data.status) payload.status = String(data.status);
  if (data.message) payload.message = String(data.message);
  if (data.resumeFrom !== undefined) payload.resumeFrom = String(data.resumeFrom);
  payload.updatedAt = String(Date.now());
  await r.hset(progressKey(userId), payload);
  await r.expire(progressKey(userId), PROGRESS_TTL);
}

async function clearProgress(userId) {
  const r = getRedis();
  try { await r.del(progressKey(userId)); } catch { }
}

/**
 * Eliminar todos los jobs pendientes de un usuario
 */
async function removeUserJobs(userId) {
  try {
    const states = ['waiting', 'delayed', 'active', 'paused'];
    let removed = 0;

    for (const state of states) {
      const jobs = await queue.getJobs([state], 0, -1, true);
      for (const job of jobs) {
        if (job?.data?.userId === userId) {
          await job.remove();
          removed++;
        }
      }
    }

    if (removed > 0) {
      logger.info({ userId, removed }, 'Jobs del usuario eliminados de la cola');
    }

    return removed;
  } catch (error) {
    logger.error({ userId, error: error.message }, 'Error eliminando jobs del usuario');
    return 0;
  }
}

/**
 * Limpieza completa de datos de Redis para un usuario.
 * Se ejecuta en: logout, error fatal, desvinculación.
 *
 * @param {string} userId
 * @param {object} [options]
 * @param {boolean} [options.keepAuth=false] - If true, skip deleting wa:auth keys (preserves WhatsApp reconnection state)
 * @returns {Promise<{success: boolean, deletedKeys: string[]}>}
 */
async function cleanupUserData(userId, options = {}) {
  const { keepAuth = false } = options;
  logger.info({ userId, keepAuth }, 'Limpiando datos de Redis para usuario');
  const r = getRedis();
  const deletedKeys = [];

  try {
    // Eliminar todos los jobs pendientes del usuario
    await removeUserJobs(userId);

    // Direct keys to delete
    const directKeys = [
      statusKey(userId),         // ms:status:{userId}
      progressKey(userId),       // ms:progress:{userId}
      listKey(userId),           // ms:list:{userId}
      cancelKey(userId),         // ms:cancel:{userId}
      eventsKey(userId),         // ms:events:{userId}
      heartbeatKey(userId),      // ms:hb:{userId}
      campaignLockKey(userId),   // ms:lock:campaign:{userId}
      `ms:session:${userId}`,    // session token
      `ms:contacts:${userId}`,   // contacts cache
      `ms:contacts:idmap:${userId}`, // contacts ID map
      `ms:campaigns:${userId}`,  // campaigns cache
      `wa:owner:${userId}`,      // pod ownership
    ];

    for (const key of directKeys) {
      try {
        const deleted = await r.del(key);
        if (deleted > 0) deletedKeys.push(key);
      } catch (err) {
        logger.warn({ userId, key, err: err?.message }, 'Error deleting key during cleanup');
      }
    }

    // Pattern-based keys: ms:metrics:*:{userId}
    const metricPatterns = [
      `ms:metrics:events:seq:${userId}`,
      `ms:metrics:events:z:${userId}`,
      `ms:metrics:events:h:${userId}`,
      `ms:metrics:monthly:sent:${userId}`,
      `ms:metrics:monthly:error:${userId}`,
      `ms:metrics:contact:stats:${userId}`,
    ];
    for (const key of metricPatterns) {
      try {
        const deleted = await r.del(key);
        if (deleted > 0) deletedKeys.push(key);
      } catch (err) {
        logger.warn({ userId, key, err: err?.message }, 'Error deleting metrics key during cleanup');
      }
    }

    // wa:auth:{userId}:* — SCAN-based deletion (dynamic suffixes)
    if (!keepAuth) {
      try {
        const authPattern = `wa:auth:${userId}:*`;
        let cursor = '0';
        do {
          const [nextCursor, keys] = await r.scan(cursor, 'MATCH', authPattern, 'COUNT', 200);
          cursor = nextCursor;
          if (keys && keys.length) {
            await r.del(keys);
            deletedKeys.push(...keys);
          }
        } while (cursor !== '0');
      } catch (err) {
        logger.warn({ userId, err: err?.message }, 'Error deleting wa:auth keys during cleanup');
      }
    }

    logger.info({ userId, deletedCount: deletedKeys.length, keepAuth }, 'Datos de Redis limpiados exitosamente');
    return { success: true, deletedKeys };
  } catch (error) {
    logger.error({ userId, error: error.message }, 'Error limpiando datos de Redis');
    return { success: false, deletedKeys };
  }
}

async function getQueueInfo(userId) {
  try {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'paused');
    const waitingJobs = await queue.getJobs(['waiting'], 0, -1, true);
    let position = null;
    let queuedForUser = 0;
    for (let i = 0; i < waitingJobs.length; i++) {
      const j = waitingJobs[i];
      if (j?.data?.userId === userId) {
        queuedForUser++;
        if (position === null) position = i + 1; // 1-based approx
      }
    }
    const activeJobs = await queue.getJobs(['active'], 0, -1, true);
    const activeForUser = activeJobs.some(j => j?.data?.userId === userId);
    return { counts, position, queuedForUser, activeForUser };
  } catch (e) {
    return { counts: {}, position: null, queuedForUser: 0, activeForUser: false };
  }
}

async function getStatusDetailed(userId) {
  const r = getRedis();
  const data = await r.hgetall(statusKey(userId));
  if (!data || Object.keys(data).length === 0) {
    return { total: 0, sent: 0, errors: 0, completed: true, canceled: false, messages: [], inProgress: false, queue: { waiting: 0, active: 0, delayed: 0, paused: 0, position: null, activeForUser: false, queuedForUser: 0 }, etaSeconds: 0 };
  }
  const prog = await r.hgetall(progressKey(userId));
  const base = {
    total: Number(data.total || 0),
    sent: Number(data.sent || 0),
    errors: Number(data.errors || 0),
    completed: data.completed === '1',
    canceled: data.canceled === '1',
    startedAt: data.startedAt ? Number(data.startedAt) : null,
    updatedAt: data.updatedAt ? Number(data.updatedAt) : null,
    finishedAt: data.finishedAt ? Number(data.finishedAt) : null,
    jobId: data.jobId || null,
    progress: prog && Object.keys(prog).length ? {
      currentIndex: prog.currentIndex ? Number(prog.currentIndex) : null,
      total: prog.total ? Number(prog.total) : (data.total ? Number(data.total) : null),
      number: prog.number || null,
      status: prog.status || null,
      message: prog.message || null,
      updatedAt: prog.updatedAt ? Number(prog.updatedAt) : null,
    } : null,
    messages: [],
  };
  const qi = await getQueueInfo(userId);
  const remaining = Math.max(0, base.total - base.sent - base.errors);
  const eta = remaining * Math.ceil(SEND_BETWEEN_MS / 1000);
  const state = base.canceled ? 'canceled' : (base.completed ? 'completed' : ((base.progress && base.progress.status === 'sending') || qi.activeForUser ? 'running' : (qi.queuedForUser > 0 && !qi.activeForUser ? 'queued' : 'idle')));
  // Mapear eventos recientes a filas de tabla
  const evLimit = Math.max(10, Number(process.env.EVENTS_UI_LIMIT || 100));
  const events = await getRecentEvents(userId, evLimit);
  // Deduplicar por número quedándose con el evento más reciente
  // Nota: getRecentEvents devuelve más reciente primero (LPUSH + LRANGE 0..)
  const latestByNumber = new Map();
  for (const e of events) {
    if (!e || e.type !== 'message' || !e.number) continue;
    if (!latestByNumber.has(e.number)) {
      latestByNumber.set(e.number, {
        number: e.number,
        status: e.status || 'queued',
        timestamp: e.timestamp,
        response: e.response || e.message,
      });
    }
  }
  // Convertir a arreglo; opcionalmente ordenar por timestamp ascendente para tabla
  const messages = Array.from(latestByNumber.values()).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  return {
    ...base,
    resuming_from: prog && prog.resumeFrom ? Number(prog.resumeFrom) : null,
    queue: {
      waiting: qi.counts?.waiting || 0,
      active: qi.counts?.active || 0,
      delayed: qi.counts?.delayed || 0,
      paused: qi.counts?.paused || 0,
      position: qi.position,
      activeForUser: qi.activeForUser,
      queuedForUser: qi.queuedForUser,
    },
    inProgress: !base.completed && !base.canceled && (base.sent + base.errors > 0 || qi.activeForUser),
    etaSeconds: eta,
    state,
    canceled: base.canceled, // Exponer explícitamente para el frontend
    queuePositionExact: qi.position,
    messages,
  };
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
  // Quitar placeholders no reemplazados sin comerse saltos de línea
  processedMessage = processedMessage.replace(/\{[^}\n]+\}/g, '');
  // Normalizar EOL y espacios sin colapsar los \n
  processedMessage = processedMessage.replace(/\r\n/g, '\n');
  processedMessage = processedMessage.replace(/[ \t]+\n/g, '\n');
  processedMessage = processedMessage.replace(/\n[ \t]+/g, '\n');
  processedMessage = processedMessage.replace(/[ \t]{2,}/g, ' ');
  processedMessage = processedMessage.replace(/[ \t]+$/gm, '');
  processedMessage = processedMessage.trim();
  return processedMessage;
}

async function getImageBufferCached(cache, img) {
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

  logger.info({ userId, origKey, convKey }, 'Procesando audio desde S3');

  // Intentar usar objeto convertido existente
  try {
    const exists = await s3.existsObject(convKey);
    if (exists) {
      logger.info({ userId, convKey }, 'Audio convertido ya existe en S3');
      return { s3Key: convKey, mimetype: 'audio/mp4' };
    }
  } catch (err) {
    logger.warn({ userId, error: err.message }, 'Error verificando audio convertido existente');
  }

  // Descargar original, convertir y subir
  logger.info({ userId, origKey }, 'Descargando audio original de S3...');
  const localOrig = path.join(tempDir, `audio_download_${userId}_${Date.now()}`);
  const localConv = await (async () => {
    const buf = await s3.getObjectBuffer(origKey);
    logger.info({ userId, size: buf.length }, 'Audio descargado de S3');
    fs.writeFileSync(localOrig, buf);
    try {
      logger.info({ userId, localOrig }, 'Convirtiendo audio...');
      const out = await convertAudioToOpus(localOrig, userId);
      const convBuf = fs.readFileSync(out);
      logger.info({ userId, convKey, size: convBuf.length }, 'Subiendo audio convertido a S3...');
      await s3.putObjectFromBuffer(convKey, convBuf, 'audio/mp4');
      logger.info({ userId, convKey }, 'Audio convertido subido exitosamente');
      try { fs.unlinkSync(out); } catch { }
      return out;
    } finally {
      try { fs.unlinkSync(localOrig); } catch { }
    }
  })();
  try { if (localConv && fs.existsSync(localConv)) fs.unlinkSync(localConv); } catch { }
  return { s3Key: convKey, mimetype: 'audio/mp4' };
}

async function processCampaign(job) {
  const { userId, numbers, templates, images, singleImage, audio, campaignId } = job.data;
  // Exclusión por usuario para permitir concurrencia entre usuarios
  const ttlSec = Math.max(300, Number(process.env.REDIS_CAMPAIGN_LOCK_TTL || 3600));
  const { unlock } = await acquireLock(campaignLockKey(userId), ttlSec, { timeoutMs: 15000 });

  // Declarar manager fuera del try para que esté disponible en finally
  let manager;
  let client;

  try {
    // Asegurar que sólo el owner procese el job de este usuario
    const iAmOwner = await sessOwner.tryEnsureOwnership(userId, sessOwner.getOwnerTtl());
    if (!iAmOwner) {
      // Si otro es owner, reprogramar para que lo tome ese pod
      try { await job.moveToDelayed(Date.now() + 2000); } catch { }
      return;
    }

    if (await isCanceled(userId)) {
      logger.warn({ userId }, 'Campaña marcada como cancelada antes de iniciar');
      await markCanceled(userId);
      if (campaignId) {
        try { await metricsStore.setCampaignStatus(userId, campaignId, 'canceled'); } catch { }
      }
      try { await addEvent(userId, 'job_canceled', { reason: 'pre_start_cancelled' }); } catch { }
      return;
    }

    // Si ya está marcada como completada en status, no reprocesar
    try {
      const r = getRedis();
      const sdata = await r.hgetall(statusKey(userId));
      if (sdata && Object.keys(sdata).length) {
        if (sdata.completed === '1') {
          logger.info({ userId }, 'Campaña ya marcada como completada. Omitiendo reproceso.');
          return;
        }
        if (sdata.canceled === '1') {
          logger.info({ userId }, 'Campaña ya marcada como cancelada. Omitiendo reproceso.');
          await markCanceled(userId);
          if (campaignId) {
            try { await metricsStore.setCampaignStatus(userId, campaignId, 'canceled'); } catch { }
          }
          return;
        }
      }
    } catch { }

    manager = await sessionManager.getSession(userId);
    if (!manager || !manager.sock) {
      await sessionManager.initializeSession(userId);
      manager = await sessionManager.getSession(userId);
    }
    client = manager.sock;
    if (!client || !client.user) throw new Error('Socket de WhatsApp no está listo');

    if (campaignId) {
      try { await metricsStore.setCampaignStatus(userId, campaignId, 'running', { startedAt: Date.now() }); } catch { }
    }

    // Validaciones previas
    const numCheck = validateNumbersArray(numbers);
    if (!numCheck.valid) {
      logger.warn({ userId, invalidCount: numCheck.invalidCount }, 'Lista con números inválidos; cancelando campaña');
      await markCanceled(userId);
      await clearList(userId);
      if (campaignId) {
        try { await metricsStore.setCampaignStatus(userId, campaignId, 'canceled'); } catch { }
      }
      try { if (typeof addEvent === 'function') await addEvent(userId, 'job_canceled', { reason: 'invalid_numbers', invalid: numCheck.invalidCount }); } catch { }
      return;
    }

    // Validar templates
    if (!Array.isArray(templates) || templates.length === 0 || templates.length > 5) {
      logger.warn({ userId, templateCount: templates?.length }, 'Templates inválidos; cancelando campaña');
      await markCanceled(userId);
      await clearList(userId);
      if (campaignId) {
        try { await metricsStore.setCampaignStatus(userId, campaignId, 'canceled'); } catch { }
      }
      try { if (typeof addEvent === 'function') await addEvent(userId, 'job_canceled', { reason: 'invalid_templates' }); } catch { }
      return;
    }

    // Validar que al menos un template tenga contenido o haya media
    const hasValidTemplate = templates.some(t => t && t.trim().length > 0);
    if (!hasValidTemplate && !singleImage && !(images && images.length) && !audio) {
      logger.warn({ userId }, 'Contenido inválido (sin mensaje ni media); cancelando campaña');
      await markCanceled(userId);
      await clearList(userId);
      if (campaignId) {
        try { await metricsStore.setCampaignStatus(userId, campaignId, 'canceled'); } catch { }
      }
      try { if (typeof addEvent === 'function') await addEvent(userId, 'job_canceled', { reason: 'invalid_content' }); } catch { }
      return;
    }

    logger.info({ userId, templateCount: templates.length, numbersCount: numbers.length }, 'Iniciando campaña con templates múltiples');

    // Preparaciones de media
    const imageCache = new Map();
    let convertedAudio = null;
    if (audio && audio.s3Key) {
      try {
        convertedAudio = await ensureConvertedAudio(userId, audio);
      } catch (err) {
        logger.error({ userId, error: err.message }, 'Error procesando audio desde S3');
        throw new Error(`Error al procesar audio: ${err.message}`);
      }
    }

    // Reanudar desde progreso previo
    let startIdx = 0;
    try {
      const r = getRedis();
      const prog = await r.hgetall(progressKey(userId));
      if (prog && Object.keys(prog).length) {
        const ci = Number(prog.currentIndex || 0);
        if (ci > 0) {
          if (prog.status === 'sent' || prog.status === 'error') {
            // si fue enviado o marcado error, continuar con el siguiente
            startIdx = Math.min(numbers.length, ci);
          } else {
            // si estaba "sending" u otro estado, reintentar el actual
            startIdx = Math.max(0, ci - 1);
          }
        }
      }
      if (startIdx > 0) {
        logger.info({ userId, startIdx }, 'Reanudando campaña desde índice calculado');
        try { await setProgress(userId, { resumeFrom: startIdx, status: 'resuming' }); } catch { }
        try { await addEvent(userId, 'resume', { resumeFrom: startIdx }); } catch { }
      }
    } catch { }

    // Marca inicio de job
    try { await addEvent(userId, 'job_started', { total: numbers.length, startIdx, templateCount: templates.length }); } catch { }

    // Activar flag de campaña activa para evitar cooldowns durante envío
    if (manager && typeof manager.setActiveCampaign === 'function') {
      manager.setActiveCampaign(true);
      logger.info({ userId }, 'Flag de campaña activa establecido');
    }

    let sent = 0;
    const requireHeartbeat = String(process.env.HEARTBEAT_REQUIRED || 'true').toLowerCase() === 'true';
    for (let i = startIdx; i < numbers.length; i++) {
      if (await isCanceled(userId)) {
        logger.warn({ userId, index: i }, 'Cancelación detectada durante campaña; abortando');
        break;
      }
      if (requireHeartbeat) {
        const alive = await hasHeartbeat(userId);
        if (!alive) {
          logger.warn({ userId, index: i }, 'Heartbeat ausente (posible refresh). Cancelando campaña y limpiando lista');
          await markCanceled(userId);
          if (campaignId) {
            try { await metricsStore.setCampaignStatus(userId, campaignId, 'canceled'); } catch { }
          }
          try { if (typeof addEvent === 'function') await addEvent(userId, 'job_canceled', { reason: 'no_heartbeat_refresh' }); } catch { }
          await clearList(userId);
          break;
        }
      }
      const entry = numbers[i];
      const number = typeof entry === 'string' ? entry : entry.number;
      const variables = typeof entry === 'object' && entry.variables ? entry.variables : {};

      // LÓGICA DE ROTACIÓN DE TEMPLATES
      const templateIndex = i % templates.length;
      const currentTemplate = templates[templateIndex];

      logger.debug({
        lineIndex: i + 1,
        templateIndex: templateIndex + 1,
        totalTemplates: templates.length,
        number
      }, 'Usando template para línea');

      try { await setProgress(userId, { currentIndex: i + 1, total: numbers.length, number, status: 'sending' }); } catch { }
      try { await addEvent(userId, 'message', { number, status: 'sending' }); } catch { }
      if (campaignId) {
        try {
          await metricsStore.recordRecipientStatus(userId, campaignId, entry, 'sending', { templateIndex: templateIndex + 1 });
        } catch { }
      }

      const processedMessage = processMessageVariables(currentTemplate, variables || {});
      const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;

      let retries = 0;
      const MAX_RETRIES = 3;
      let success = false;

      while (retries <= MAX_RETRIES && !success) {
        try {
          // renovar ownership periódicamente
          try { await sessOwner.renewOwner(userId, sessOwner.getOwnerTtl()); } catch { }
          // Rate limit deshabilitado por solicitud del cliente
          // if (manager && typeof manager.waitForRateLimit === 'function') {
          //   await manager.waitForRateLimit();
          // }

          // Verificar que la conexión está activa
          if (!client || !client.user || !manager || !manager.isReady) {
            throw new Error('Connection not ready');
          }

          // Audio primero si existe
          if (convertedAudio) {
            const buf = await s3.getObjectBuffer(convertedAudio.s3Key);
            // PTT requiere solo audio y ptt:true, sin mimetype ni fileName
            await client.sendMessage(jid, { audio: buf, ptt: true });
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
          try { await setProgress(userId, { currentIndex: i + 1, total: numbers.length, number, status: 'sent' }); } catch { }
          try { await addEvent(userId, 'message', { number, status: 'sent' }); } catch { }
          if (campaignId) {
            try {
              await metricsStore.recordRecipientStatus(userId, campaignId, entry, 'sent', {
                templateIndex: templateIndex + 1,
                attempts: retries + 1,
                timestamp: Date.now(),
              });
            } catch { }
          }
          success = true;

        } catch (err) {
          retries++;
          const isConnectionError = err?.message?.includes('Connection') || err?.message?.includes('Socket') || err?.message?.includes('not ready');

          if (isConnectionError && retries <= MAX_RETRIES) {
            logger.warn(`Error de conexión enviando a ${number} (intento ${retries}/${MAX_RETRIES}): ${err?.message}. Reintentando en 5s...`);
            await sleep(5000); // Esperar 5 segundos antes de reintentar

            // Intentar reconectar si es necesario
            if (manager && typeof manager.ensureConnection === 'function') {
              try {
                await manager.ensureConnection();
              } catch (reconErr) {
                logger.error(`Error al reconectar: ${reconErr?.message}`);
              }
            }
          } else {
            // Error definitivo o máximo de reintentos alcanzado
            logger.warn(`Error enviando a ${number} (${retries} intentos): ${err?.message}`);
            await incField(userId, 'errors', 1);
            try { await setProgress(userId, { currentIndex: i + 1, total: numbers.length, number, status: 'error', message: err?.message }); } catch { }
            try { await addEvent(userId, 'message', { number, status: 'error', message: err?.message }); } catch { }
            if (campaignId) {
              try {
                await metricsStore.recordRecipientStatus(userId, campaignId, entry, 'error', {
                  errorMessage: err?.message || 'Error desconocido',
                  templateIndex: templateIndex + 1,
                  attempts: retries,
                  timestamp: Date.now(),
                });
              } catch { }
            }
            break;
          }
        }
      }

      await sleep(SEND_BETWEEN_MS);
    }

    if (await isCanceled(userId)) {
      await markCanceled(userId);
      if (campaignId) {
        try { await metricsStore.setCampaignStatus(userId, campaignId, 'canceled'); } catch { }
      }
      try { await addEvent(userId, 'job_canceled', { reason: 'canceled_during_run' }); } catch { }
    } else {
      await markCompleted(userId);
      if (campaignId) {
        try { await metricsStore.setCampaignStatus(userId, campaignId, 'completed'); } catch { }
      }
      try { const r = getRedis(); const sentCnt = Number((await r.hget(statusKey(userId), 'sent')) || 0); await addEvent(userId, 'job_completed', { sent: sentCnt }); } catch { }
    }

    // Desactivar flag de campaña activa
    if (manager && typeof manager.setActiveCampaign === 'function') {
      manager.setActiveCampaign(false);
      logger.info({ userId }, 'Flag de campaña activa desactivado');
    }

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
    } catch { }
  } finally {
    // Asegurar que el flag de campaña activa se desactive SIEMPRE
    if (manager && typeof manager.setActiveCampaign === 'function') {
      manager.setActiveCampaign(false);
    }

    try { await clearCancel(userId); } catch { }
    try { await clearProgress(userId); } catch { }
    try { await clearList(userId); } catch { }
    await unlock();
  }
}

// Worker
const worker = new Worker(QUEUE_NAME, async (job) => {
  if (job.name === 'campaign') {
    return await processCampaign(job);
  }
}, { connection, concurrency: WORKER_CONCURRENCY });

worker.on('completed', (job) => logger.info({ jobId: job.id }, 'Job completed'));
worker.on('failed', async (job, err) => {
  logger.warn({ jobId: job?.id, err: err?.message }, 'Job failed');

  if (job?.data?.userId && job?.data?.campaignId) {
    try { await metricsStore.setCampaignStatus(job.data.userId, job.data.campaignId, 'failed'); } catch { }
  }

  // Limpiar datos de Redis si el job falla completamente
  if (job?.data?.userId) {
    try {
      await cleanupUserData(job.data.userId);
      logger.info({ userId: job.data.userId }, 'Datos limpiados tras fallo de job');
    } catch (cleanupError) {
      logger.error({ userId: job.data.userId, error: cleanupError.message }, 'Error limpiando datos tras fallo');
    }
  }
});

async function closeWorker() {
  await worker.close();
}

/**
 * Scan for orphan Redis keys — keys belonging to users with no active session
 * and no recent heartbeat. Returns list of orphan keys grouped by userId.
 */
async function scanOrphanKeys() {
  const r = getRedis();
  const prefixes = ['ms:status:', 'ms:progress:', 'ms:cancel:', 'ms:lock:campaign:',
    'ms:list:', 'ms:hb:', 'ms:events:', 'ms:contacts:', 'ms:campaigns:'];

  const userKeys = new Map(); // userId -> [keys]

  // Scan all ms:* keys
  try {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await r.scan(cursor, 'MATCH', 'ms:*', 'COUNT', 200);
      cursor = nextCursor;
      for (const key of keys) {
        // Extract userId from key patterns like ms:prefix:{userId} or ms:prefix:sub:{userId}
        let uid = null;
        for (const prefix of prefixes) {
          if (key.startsWith(prefix)) {
            uid = key.slice(prefix.length);
            break;
          }
        }
        // Handle ms:session:{userId}
        if (!uid && key.startsWith('ms:session:')) {
          uid = key.slice('ms:session:'.length);
        }
        // Handle ms:metrics:*:{userId} patterns
        if (!uid && key.startsWith('ms:metrics:')) {
          const parts = key.split(':');
          if (parts.length >= 4) {
            uid = parts[parts.length - 1];
          }
        }
        // Handle ms:contacts:idmap:{userId}
        if (!uid && key.startsWith('ms:contacts:idmap:')) {
          uid = key.slice('ms:contacts:idmap:'.length);
        }

        if (uid) {
          if (!userKeys.has(uid)) userKeys.set(uid, []);
          userKeys.get(uid).push(key);
        }
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.error({ err: err?.message }, 'Error scanning ms:* keys for orphan detection');
    throw err;
  }

  // Also scan wa:* keys
  try {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await r.scan(cursor, 'MATCH', 'wa:*', 'COUNT', 200);
      cursor = nextCursor;
      for (const key of keys) {
        let uid = null;
        if (key.startsWith('wa:owner:')) {
          uid = key.slice('wa:owner:'.length);
        } else if (key.startsWith('wa:auth:')) {
          // wa:auth:{userId}:suffix
          const rest = key.slice('wa:auth:'.length);
          const colonIdx = rest.indexOf(':');
          uid = colonIdx > 0 ? rest.slice(0, colonIdx) : rest;
        } else if (key.startsWith('wa:lock:connect:')) {
          uid = key.slice('wa:lock:connect:'.length);
        }

        if (uid) {
          if (!userKeys.has(uid)) userKeys.set(uid, []);
          userKeys.get(uid).push(key);
        }
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.error({ err: err?.message }, 'Error scanning wa:* keys for orphan detection');
  }

  // Check each userId for active session or recent activity
  const orphans = [];
  const active = [];
  const ORPHAN_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

  for (const [uid, keys] of userKeys) {
    try {
      // Check if user has an active session token
      const sessionData = await r.get(`ms:session:${uid}`);
      if (sessionData) {
        active.push({ userId: uid, keyCount: keys.length, reason: 'has_session' });
        continue;
      }

      // Check if user has a recent heartbeat
      const hb = await r.get(heartbeatKey(uid));
      if (hb) {
        active.push({ userId: uid, keyCount: keys.length, reason: 'has_heartbeat' });
        continue;
      }

      // Check status updatedAt — if recent, not orphan
      const updatedAt = await r.hget(statusKey(uid), 'updatedAt');
      if (updatedAt && (Date.now() - Number(updatedAt)) < ORPHAN_THRESHOLD_MS) {
        active.push({ userId: uid, keyCount: keys.length, reason: 'recent_activity' });
        continue;
      }

      // Orphaned
      orphans.push({ userId: uid, keys, keyCount: keys.length });
    } catch (err) {
      logger.warn({ uid, err: err?.message }, 'Error checking user activity for orphan scan');
    }
  }

  logger.info({ orphanUsers: orphans.length, activeUsers: active.length }, 'Orphan key scan complete');
  return { orphans, active, totalUsersScanned: userKeys.size };
}

/**
 * Delete orphan keys for a specific list of userIds.
 * Called after scanOrphanKeys to actually remove them.
 */
async function deleteOrphanKeys(orphanEntries) {
  const r = getRedis();
  let totalDeleted = 0;
  const results = [];

  for (const entry of orphanEntries) {
    try {
      if (entry.keys && entry.keys.length > 0) {
        await r.del(entry.keys);
        totalDeleted += entry.keys.length;
        results.push({ userId: entry.userId, deleted: entry.keys.length });
      }
    } catch (err) {
      logger.warn({ userId: entry.userId, err: err?.message }, 'Error deleting orphan keys');
      results.push({ userId: entry.userId, deleted: 0, error: err?.message });
    }
  }

  logger.info({ totalDeleted, users: results.length }, 'Orphan keys deleted');
  return { totalDeleted, results };
}

/**
 * Get Redis key statistics — count of keys by pattern.
 */
async function getRedisKeyStats() {
  const r = getRedis();
  const patterns = {
    'ms:status:*': 0,
    'ms:progress:*': 0,
    'ms:cancel:*': 0,
    'ms:lock:campaign:*': 0,
    'ms:list:*': 0,
    'ms:hb:*': 0,
    'ms:events:*': 0,
    'ms:session:*': 0,
    'ms:contacts:*': 0,
    'ms:campaigns:*': 0,
    'ms:metrics:*': 0,
    'wa:owner:*': 0,
    'wa:auth:*': 0,
    'wa:lock:*': 0,
  };

  for (const pattern of Object.keys(patterns)) {
    try {
      let count = 0;
      let cursor = '0';
      do {
        const [nextCursor, keys] = await r.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = nextCursor;
        count += keys.length;
      } while (cursor !== '0');
      patterns[pattern] = count;
    } catch (err) {
      logger.warn({ pattern, err: err?.message }, 'Error counting keys for pattern');
    }
  }

  // Get total DB size
  let dbSize = 0;
  try {
    dbSize = await r.dbsize();
  } catch { }

  return { patterns, dbSize };
}

module.exports = {
  enqueueCampaign,
  getStatus,
  getStatusDetailed,
  cancelCampaign,
  saveList,
  clearList,
  cleanupUserData,
  removeUserJobs,
  touchHeartbeat,
  closeWorker,
  scanOrphanKeys,
  deleteOrphanKeys,
  getRedisKeyStats,
  // Admin helpers (expuestos por rutas si se requiere)
  async cleanQueue(type = 'completed', graceSec = 3600, limit = 1000) {
    try {
      const ms = Math.max(0, Number(graceSec) || 0) * 1000;
      const lim = Math.max(1, Number(limit) || 1);
      const cleaned = await queue.clean(ms, lim, type);
      return { cleaned: cleaned?.length || 0, type };
    } catch (e) {
      logger.warn({ err: e?.message, type }, 'Queue clean failed');
      return { cleaned: 0, type, error: e?.message };
    }
  },
  async obliterateQueue(force = true) {
    try {
      await queue.obliterate({ force: !!force, count: 1000 });
      return { ok: true };
    } catch (e) {
      logger.warn({ err: e?.message }, 'Queue obliterate failed');
      return { ok: false, error: e?.message };
    }
  }
};
