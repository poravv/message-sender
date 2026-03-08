---
name: redis-bullmq
description: 'Desarrollo con Redis y BullMQ. Usar cuando: crear/modificar jobs de cola, debugging de workers, métricas de jobs, persistencia en Redis, caching, pub/sub, o cualquier operación con ioredis y BullMQ.'
---

# Redis y BullMQ

## Cuándo Usar

- Crear nuevos tipos de jobs para la cola
- Debugging de jobs fallidos o estancados
- Ver estado de la cola y métricas
- Implementar caching con Redis
- Persistencia de sesiones y auth state
- Rate limiting basado en Redis
- Pub/sub para notificaciones

## Arquitectura

```
redisClient.js
├── getRedis()              # Singleton connection
└── createRedisClient()     # Factory con retry logic

queueRedis.js (BullMQ)
├── messageQueue           # Queue instance
├── messageWorker          # Worker procesador
├── addJob()               # Agregar mensaje a cola
├── getQueueStatus()       # Estado actual
└── getJobLogs()           # Logs de jobs

metricsStoreRedis.js
├── incrementMetric()      # Contadores
├── getMetrics()           # Lectura de métricas
└── resetMetrics()         # Reset por periodo
```

## Conexión Redis

```javascript
// redisClient.js - Singleton pattern
const Redis = require('ioredis');

let redisInstance = null;

function getRedis() {
  if (!redisInstance || redisInstance.status === 'end') {
    redisInstance = createRedisClient();
  }
  return redisInstance;
}

function createRedisClient() {
  const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB, 10) || 0,
    retryDelayOnFailover: 100,
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
  
  redis.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
  });
  
  return redis;
}
```

## BullMQ - Crear Job

```javascript
const { Queue, Worker } = require('bullmq');

// queueRedis.js
const messageQueue = new Queue('whatsapp-messages', {
  connection: getRedis(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

// Agregar job
async function addMessageJob(userId, payload) {
  const job = await messageQueue.add(
    'send-message',
    {
      userId,
      phone: payload.phone,
      message: payload.message,
      mediaUrl: payload.mediaUrl,
      timestamp: Date.now(),
    },
    {
      priority: payload.priority || 0,
      delay: payload.delay || 0,
    }
  );
  
  logger.info({ jobId: job.id, userId }, 'Job added to queue');
  return job;
}
```

## BullMQ - Worker

```javascript
const messageWorker = new Worker(
  'whatsapp-messages',
  async (job) => {
    const { userId, phone, message, mediaUrl } = job.data;
    
    logger.info({ jobId: job.id, phone }, 'Processing job');
    
    // Obtener sesión del usuario
    const session = await sessionManager.getSession(userId);
    if (!session?.isReady) {
      throw new Error('WhatsApp session not ready');
    }
    
    // Enviar mensaje
    await session.sendMessage(phone, message, mediaUrl);
    
    // Actualizar progreso
    await job.updateProgress(100);
    
    return { sent: true, timestamp: Date.now() };
  },
  {
    connection: getRedis(),
    concurrency: 1, // ¡Importante! Evitar rate limiting
    limiter: {
      max: 15,
      duration: 60000, // 15 msgs por minuto
    },
  }
);

// Eventos del worker
messageWorker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, result }, 'Job completed');
});

messageWorker.on('failed', (job, err) => {
  logger.error({ jobId: job.id, err }, 'Job failed');
});
```

## Scripts de Debugging

### Ver Estado de Cola
```bash
node scripts/check-queue.js
```

```javascript
// scripts/check-queue.js
const { getQueueStatus } = require('../src/queueRedis');

async function main() {
  const status = await getQueueStatus();
  console.log('Queue Status:', JSON.stringify(status, null, 2));
  // { waiting: 5, active: 1, completed: 100, failed: 2 }
}
```

### Ver Logs de Job
```bash
node scripts/job-logs.js <jobId>
```

### Remover Job
```bash
node scripts/remove-job.js <jobId>
```

## Patrones Redis Comunes

### Caching con TTL
```javascript
async function getCachedData(key, fetchFn, ttlSeconds = 3600) {
  const redis = getRedis();
  const cached = await redis.get(key);
  
  if (cached) {
    return JSON.parse(cached);
  }
  
  const data = await fetchFn();
  await redis.setex(key, ttlSeconds, JSON.stringify(data));
  return data;
}
```

### Rate Limiting
```javascript
async function checkRateLimit(userId, maxPerMinute = 15) {
  const redis = getRedis();
  const key = `rate:${userId}`;
  
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 60);
  }
  
  return count <= maxPerMinute;
}
```

### Distributed Lock
```javascript
// redisLock.js
async function acquireLock(key, ttlMs = 30000) {
  const redis = getRedis();
  const lockKey = `lock:${key}`;
  const token = crypto.randomUUID();
  
  const acquired = await redis.set(lockKey, token, 'PX', ttlMs, 'NX');
  return acquired ? token : null;
}

async function releaseLock(key, token) {
  const redis = getRedis();
  const lockKey = `lock:${key}`;
  
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  
  return redis.eval(script, 1, lockKey, token);
}
```

## Troubleshooting

### Problema: Jobs estancados en "active"
```javascript
// Worker crashed, jobs quedaron activos
const activeJobs = await messageQueue.getActive();
for (const job of activeJobs) {
  await job.moveToFailed(
    new Error('Worker restarted'),
    true
  );
}
```

### Problema: Redis se desconecta
```javascript
// Verificar antes de usar
const redis = getRedis();
if (!redis || redis.status === 'end') {
  logger.warn('Redis unavailable');
  return null; // Fallback behavior
}
```

### Problema: Jobs duplicados
```javascript
// Usar jobId determinístico
await messageQueue.add('send-message', payload, {
  jobId: `${userId}-${phone}-${Date.now()}`,
});
```

## Archivos del Proyecto

- [redisClient.js](../../src/redisClient.js) - Singleton Redis
- [queueRedis.js](../../src/queueRedis.js) - BullMQ queue y worker  
- [redisLock.js](../../src/redisLock.js) - Distributed locking
- [metricsStoreRedis.js](../../src/metricsStoreRedis.js) - Métricas en Redis
- [scripts/check-queue.js](../../scripts/check-queue.js) - Ver estado cola
- [scripts/job-logs.js](../../scripts/job-logs.js) - Ver logs de jobs
