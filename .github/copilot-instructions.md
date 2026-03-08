# WhatsApp Message Sender - Instrucciones para Copilot

## Descripción del Proyecto

Sistema profesional de envío masivo de mensajes por WhatsApp con arquitectura multi-cliente, gestión de cola inteligente y deployment automatizado.

## Stack Tecnológico

- **Backend**: Node.js 20+ con Express
- **WhatsApp**: @whiskeysockets/baileys 7.0.0-rc.9 (WebSocket-based)
- **Base de datos**: PostgreSQL 16 con persistencia Longhorn
- **Caché/Colas**: Redis 7.2 con BullMQ para job processing
- **Almacenamiento**: MinIO/S3 para archivos multimedia
- **Autenticación**: Keycloak con JWT (bypass en desarrollo)
- **Frontend**: Vanilla JS modularizado con Bootstrap
- **Containerización**: Docker con multi-stage builds
- **Orquestación**: Kubernetes con GitHub Actions CI/CD

## Estructura del Proyecto

```
src/
├── routes.js          # Endpoints Express (API REST)
├── manager.js         # WhatsAppManager - conexión Baileys
├── sessionManager.js  # Gestión de sesiones multi-usuario
├── queueRedis.js      # Cola BullMQ para procesamiento
├── auth.js            # Middleware JWT Keycloak
├── metricsStore.js    # Abstracción métricas (PG/Redis)
├── redisClient.js     # Singleton Redis (ioredis)
├── postgresClient.js  # Pool PostgreSQL
└── storage/s3.js      # Cliente MinIO/S3

public/js/
├── core.js            # Configuración y utilidades
├── main.js            # Entry point, inicialización
├── whatsapp.js        # Conexión y estado WA
├── messages.js        # Envío de mensajes
├── contacts.js        # Gestión de contactos
└── dashboard.js       # Métricas y estadísticas
```

## Convenciones de Código

### Backend (Node.js)

1. **Logger**: Usar `require('./logger')` (pino) para logging, nunca `console.log`
2. **Errores**: Envolver operaciones async en try-catch, loguear con contexto
3. **Config**: Variables de entorno via `require('./config')`
4. **Redis**: Usar `getRedis()` de `redisClient.js` para singleton
5. **PostgreSQL**: Usar pool de `postgresClient.js`, no crear conexiones directas

### Patrones Importantes

```javascript
// ✅ Correcto - logging estructurado
logger.info({ userId, action: 'send_message' }, 'Message sent');

// ❌ Incorrecto
console.log('Message sent for user:', userId);

// ✅ Correcto - manejo de Redis
const redis = getRedis();
if (!redis || redis.status === 'end') {
  logger.warn('Redis unavailable');
  return null;
}

// ✅ Correcto - rate limiting check
if (this.messageCount >= this.maxMessagesPerMinute) {
  await this._delay(60000 / this.maxMessagesPerMinute);
}
```

### WhatsApp/Baileys

1. **Reconexión**: Manejar `DisconnectReason` de Baileys correctamente
2. **Rate limiting**: Respetar límites de 15 msgs/min para evitar bans
3. **QR**: Generar con `qrcode` library, almacenar temporalmente en Redis
4. **Auth state**: Usar `redisAuthState.js` para persistencia multi-pod

### Frontend

1. **Módulos**: Cada archivo JS es un módulo con responsabilidad única
2. **Estado**: Polling via `/connection-status` para actualizaciones
3. **Fetch**: Incluir token JWT en headers para producción

## Variables de Entorno Críticas

```env
# Core
PORT=3000
NODE_ENV=production|development

# Auth (requerido en producción)
KEYCLOAK_URL=https://auth.example.com
KEYCLOAK_REALM=message-sender
KEYCLOAK_AUDIENCE=message-sender-api

# Redis (requerido)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=...

# PostgreSQL (requerido en producción)
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=sender
POSTGRES_PASSWORD=...
POSTGRES_DB=sender

# S3/MinIO
MINIO_ENDPOINT=s3.example.com
MINIO_ACCESS_KEY=...
MINIO_SECRET_KEY=...
MINIO_BUCKET=sender
```

## Comandos Frecuentes

```bash
# Desarrollo
npm run dev              # nodemon

# Docker
npm run docker:compose   # docker-compose up -d
npm run docker:logs      # logs del contenedor

# Scripts útiles
npm run reset-auth       # Limpiar estado de auth Baileys
node scripts/check-queue.js   # Ver estado de la cola
node scripts/job-logs.js      # Ver logs de jobs
```

## Kubernetes

Los manifiestos están en `k8s/`:
- `backend-deployment.yaml` - Deployment con HPA
- `configmap.yaml` - Variables de entorno
- `ingress.yaml` - Routing nginx
- `keda-scaledobject.yaml` - Auto-scaling basado en cola

## Testing

- No hay tests automatizados actualmente
- Probar manualmente con archivo `test-audio.js`
- Usar `scripts/` para debugging de cola y sesiones

## Consideraciones de Seguridad

1. Siempre validar `AUTHORIZED_PHONES` antes de procesar
2. JWT requerido en producción (bypass solo en development)
3. Sanitizar números de teléfono con `normalizeParaguayanNumber()`
4. No exponer credenciales en logs (usar scrubbing en pino)
