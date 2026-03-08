---
name: whatsapp-baileys
description: 'Desarrollo WhatsApp con Baileys. Usar cuando: crear/modificar funciones de envío de mensajes, debugging de conexión WhatsApp, manejo de QR codes, rate limiting, reconnection logic, auth state, multimedia messages, o cualquier integración con @whiskeysockets/baileys.'
---

# WhatsApp Baileys Integration

## Cuándo Usar

- Crear nuevas funciones de envío de mensajes (texto, imagen, audio, video)
- Debugging de problemas de conexión WhatsApp
- Manejar códigos QR y autenticación
- Implementar rate limiting para evitar bans
- Trabajar con reconexión automática
- Persistencia de auth state en Redis
- Conversión de audio a formato Opus

## Arquitectura de Conexión

```
WhatsAppManager (manager.js)
├── makeWASocket()           # Crear socket Baileys
├── authState                # Credenciales (Redis)
├── connectionState          # 'disconnected'|'connecting'|'qr_ready'|'connected'
├── isReady                  # Boolean - listo para enviar
└── messageQueue             # Cola local de mensajes

sessionManager.js
├── sessions: Map<userId, WhatsAppManager>
├── getSessionByToken(req)   # Obtener sesión por JWT
└── createSession(userId)    # Crear nueva sesión
```

## Ciclo de Vida de Conexión

1. **Desconectado** → usuario llama `/connect`
2. **Connecting** → Baileys establece WebSocket
3. **QR Ready** → Se genera QR, usuario escanea
4. **Connected** → `isReady = true`, puede enviar mensajes
5. **Disconnect** → Manejar según `DisconnectReason`

## DisconnectReason Handling

```javascript
const { DisconnectReason } = require('@whiskeysockets/baileys');

// Razones críticas que requieren re-auth
const NEEDS_REAUTH = [
  DisconnectReason.loggedOut,      // 401 - sesión cerrada
  DisconnectReason.badSession,     // 500 - sesión corrupta
];

// Razones que permiten reconexión automática
const CAN_RECONNECT = [
  DisconnectReason.connectionLost,  // 408
  DisconnectReason.connectionClosed, // 428
  DisconnectReason.timedOut,        // 408
  DisconnectReason.restartRequired, // 515
];

// Manejar desconexión
async function handleDisconnect(lastDisconnect) {
  const reason = lastDisconnect?.error?.output?.statusCode;
  
  if (NEEDS_REAUTH.includes(reason)) {
    await this._clearRedisAuth();
    this.connectionState = 'unauthorized';
    return false; // No reconectar
  }
  
  if (CAN_RECONNECT.includes(reason)) {
    await this._delay(3000);
    await this.connect();
    return true;
  }
}
```

## Rate Limiting

```javascript
// Configuración por defecto
this.maxMessagesPerMinute = 15;
this.messageCount = 0;
this.lastMessageTime = 0;

// Antes de cada mensaje
async function checkRateLimit() {
  const now = Date.now();
  const elapsed = now - this.lastMessageTime;
  
  // Reset contador cada minuto
  if (elapsed > 60000) {
    this.messageCount = 0;
  }
  
  // Esperar si excedemos límite
  if (this.messageCount >= this.maxMessagesPerMinute) {
    const waitTime = 60000 - elapsed;
    await this._delay(waitTime);
    this.messageCount = 0;
  }
  
  this.messageCount++;
  this.lastMessageTime = now;
}
```

## Envío de Mensajes

### Texto
```javascript
await sock.sendMessage(jid, { text: 'Hola!' });
```

### Imagen con Caption
```javascript
await sock.sendMessage(jid, {
  image: { url: '/path/to/image.jpg' },
  caption: 'Mi imagen'
});
```

### Audio (Opus requerido para voice note)
```javascript
// Convertir a opus primero con ffmpeg
await sock.sendMessage(jid, {
  audio: { url: '/path/to/audio.opus' },
  mimetype: 'audio/ogg; codecs=opus',
  ptt: true // push-to-talk (voice note)
});
```

### Múltiples Imágenes
```javascript
for (const img of images) {
  await sock.sendMessage(jid, {
    image: { url: img.path },
    caption: img === images[0] ? caption : undefined
  });
  await this._delay(1000); // Evitar spam
}
```

## Auth State en Redis

```javascript
// stores/redisAuthState.js
const authState = await useRedisAuthState(redis, userId);

// authState contiene:
// - state: { creds, keys }
// - saveCreds: async function
// - clearAll: async function

// Uso en makeWASocket
const sock = makeWASocket({
  auth: {
    creds: authState.state.creds,
    keys: authState.state.keys,
  },
  printQRInTerminal: false,
});

// Guardar credenciales cuando cambien
sock.ev.on('creds.update', authState.saveCreds);
```

## Debugging Común

### Problema: QR no se genera
```javascript
// Verificar que no hay auth existente
const redis = getRedis();
const keys = await redis.keys(`wa:auth:${userId}:*`);
if (keys.length > 0) {
  // Limpiar auth corrupto
  await authState.clearAll();
}
```

### Problema: Conexión se cae constantemente
```javascript
// Agregar logging de eventos
sock.ev.on('connection.update', (update) => {
  logger.info({ 
    userId, 
    update,
    qrCount: this.qrAttempts
  }, 'Connection update');
});
```

### Problema: Mensajes no se envían
```javascript
// Verificar que isReady es true
if (!this.isReady) {
  throw new Error('WhatsApp not connected');
}

// Verificar formato de JID
const jid = number.includes('@') 
  ? number 
  : `${number}@s.whatsapp.net`;
```

## Archivos del Proyecto

- [manager.js](../../src/manager.js) - WhatsAppManager principal
- [sessionManager.js](../../src/sessionManager.js) - Multi-sesión
- [redisAuthState.js](../../src/stores/redisAuthState.js) - Persistencia auth
- [utils.js](../../src/utils.js) - normalizeParaguayanNumber, etc.
