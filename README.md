# WhatsApp Message Sender

Sistema profesional de envío masivo de mensajes por WhatsApp con arquitectura multi-cliente, gestión de cola inteligente y deployment automatizado. Implementado con Baileys y diseñado para producción.

## 🚀 Características Principales

### 📨 **Envío de Mensajes**
- **Envío masivo** desde archivos CSV con orden preservado
- **Mensajes de texto** con soporte para emojis
- **Imágenes individuales** con caption personalizado
- **Múltiples imágenes** por mensaje
- **Mensajes de voz** (audio MP3/M4A con conversión automática a Opus)
- **Sistema de cola** con procesamiento ordenado y reintentos automáticos
- **Limpieza automática** de archivos de audio después del envío

### 🔧 **Arquitectura Técnica**
- **Backend**: Node.js 20+ con Express
- **WhatsApp Integration**: @whiskeysockets/baileys (socket-based)
- **Autenticación**: Keycloak con bypass para desarrollo
- **Frontend**: Bootstrap con emoji picker y actualizaciones en tiempo real
- **Containerización**: Docker con multi-stage builds
- **CI/CD**: GitHub Actions para deployment automático

### 🏢 **Multi-Cliente**
- **Arquitectura de ramas**: Una rama por cliente (`cliente-3000`, `cliente-3011`, etc.)
- **Configuración independiente**: Cada cliente con su `.env` y puerto específico
- **Deployment aislado**: GitHub Actions deploy por rama automáticamente
- **Nginx Proxy Manager**: Compatible para gestión de dominios

## 📋 Requisitos

- **Node.js**: >= 20 (requerido por Baileys)
- **Docker & Docker Compose**: Para deployment en producción
- **Git**: Para manejo de ramas por cliente
- **Nginx Proxy Manager**: Recomendado para gestión de dominios

## 🛠️ Instalación y Configuración

### 1. **Setup de Desarrollo**
```bash
git clone https://github.com/poravv/message-sender.git
cd message-sender
npm install --legacy-peer-deps
cp .env.example .env
npm start
```

### 2. **Variables de Entorno (.env)**
```env
# Configuración del servidor
PORT=3000
NODE_ENV=production
PUBLIC_URL=http://localhost
ALLOWED_ORIGINS=http://localhost:3000,http://localhost

# Configuración de Seguridad y Rendimiento
MAX_RETRIES=3
BATCH_SIZE=100
INACTIVITY_TIMEOUT=1800000
AUTHORIZED_PHONES=595992756462,595976947110
FILE_RETENTION_HOURS=24
MESSAGE_DELAY_MS=2000

# Keycloak Configuration (OBLIGATORIO para producción)
KEYCLOAK_URL=https://kc.mindtechpy.net
KEYCLOAK_REALM=message-sender
KEYCLOAK_AUDIENCE=message-sender-api
```

## 🏗️ Deployment en Producción

### **Arquitectura Multi-Cliente**
```
/home/elporavv/workspaceandre/clientes/
├── cliente-3000/message-sender/  # Cliente A (Puerto 3000)
├── cliente-3011/message-sender/  # Cliente B (Puerto 3011)
└── cliente-3012/message-sender/  # Cliente C (Puerto 3012)
```

### **Setup Manual por Cliente (Una sola vez)**
```bash
# En el servidor de producción
CLIENT_ID="3000"  # Cambiar por el ID del cliente
mkdir -p /home/elporavv/workspaceandre/clientes/cliente-${CLIENT_ID}
cd /home/elporavv/workspaceandre/clientes/cliente-${CLIENT_ID}

# Clonar rama específica del cliente
git clone -b cliente-${CLIENT_ID} https://github.com/poravv/message-sender.git message-sender
cd message-sender

# Configurar .env específico del cliente
cat > .env << EOF
PORT=${CLIENT_ID}
NODE_ENV=production
PUBLIC_URL=http://localhost
KEYCLOAK_URL=https://kc.mindtechpy.net
KEYCLOAK_REALM=message-sender
KEYCLOAK_AUDIENCE=message-sender-api
ALLOWED_ORIGINS=http://localhost:${CLIENT_ID},http://localhost
MAX_RETRIES=3
BATCH_SIZE=100
INACTIVITY_TIMEOUT=1800000
FILE_RETENTION_HOURS=24
MESSAGE_DELAY_MS=2000
EOF

# Crear directorios necesarios
mkdir -p uploads bot_sessions temp logs

# Iniciar servicio
docker compose up -d
```

### **GitHub Actions - Deployment Automático**

**Configurar Secrets en GitHub:**
```
SSH_HOST=tu-servidor.com
SSH_USER=elporavv
SSH_KEY=-----BEGIN OPENSSH PRIVATE KEY-----...
SSH_PORT=22
```

**Flujo automático:**
```bash
# Hacer cambios en código
git checkout cliente-3000
# ... realizar modificaciones ...
git add .
git commit -m "feat: nueva funcionalidad"
git push origin cliente-3000

# 🚀 GitHub Actions se ejecuta automáticamente:
# ✅ Detecta rama cliente-3000 → CLIENT_ID=3000
# ✅ Busca /home/elporavv/workspaceandre/clientes/cliente-3009/message-sender
# ✅ Preserva .env local
# ✅ Actualiza código (git pull)
# ✅ Redeploya con Docker Compose
# ✅ Verifica estado y muestra logs
```

## 🌐 Configuración con Nginx Proxy Manager

```bash
# Ejemplo de configuración por cliente:
Domain Name: cliente3009.tudominio.com
Scheme: http
Forward Hostname/IP: localhost
Forward Port: 3000

# SSL: Activar Force SSL y HTTP/2 Support
# Certificado: Let's Encrypt automático
```

## 📊 Características Funcionales

### **Gestión de Mensajes**
- ✅ **CSV Processing**: Carga y valida números desde CSV
- ✅ **Queue Management**: Cola FIFO con manejo de errores
- ✅ **Retry Logic**: 3 reintentos automáticos con backoff exponencial
- ✅ **Progress Tracking**: Monitoreo en tiempo real del progreso
- ✅ **Audio Processing**: Conversión automática a formato Opus
- ✅ **File Cleanup**: Eliminación automática de archivos temporales

### **Conexión WhatsApp**
- ✅ **Baileys Integration**: Socket-based connection con Node.js 20
- ✅ **Session Management**: Persistencia de sesiones en bot_sessions/
- ✅ **QR Generation**: Generación automática de QR para autenticación
- ✅ **Auto Reconnection**: Reconexión automática con exponential backoff
- ✅ **User Info Capture**: Captura de número y nombre del usuario conectado
- ✅ **Inactivity Management**: Desconexión automática después de 30 minutos

### **Frontend Interactivo**
- ✅ **Responsive Design**: Bootstrap 5 con diseño mobile-first
- ✅ **Emoji Picker**: 9 categorías de emojis con búsqueda
- ✅ **Real-time Updates**: Polling cada 15 segundos para estado
- ✅ **Progress Bar**: Visualización del progreso de envío en tiempo real
- ✅ **Error Handling**: Manejo elegante de errores con alertas
- ✅ **Keycloak Integration**: Autenticación empresarial opcional

## 📁 Estructura de Archivos CSV

```csv
595992756462
595976947110
595984123456
```

- **Formato**: Un número por línea
- **Prefijo**: Incluir código de país (595 para Paraguay)
- **Sin símbolos**: Solo números, sin + ni espacios

## ⚡ Rendimiento y Límites

| Tipo de Mensaje | Velocidad | Límite |
|-----------------|-----------|---------|
| Texto | ~500/10 segundos | WhatsApp API |
| Imagen | ~500/8 minutos | Tamaño: 16MB |
| Audio | ~300/10 minutos | Duración: 2min |
| Reconexiones | 5 intentos | Backoff exponencial |
| Reintentos | 3 por mensaje | Cola automática |

## 🔧 Monitoreo y Logs

### **Logs del Sistema**
```bash
# Ver logs en tiempo real
docker compose logs -f

# Logs específicos por contenedor
docker compose logs audio-sender

# Logs de deployment
# Se muestran automáticamente en GitHub Actions
```

### **Directorios Importantes**
- 📁 `/uploads/`: Archivos temporales (auto-limpieza)
- 📁 `/bot_sessions/`: Datos de sesión WhatsApp (persistente)
- 📁 `/temp/`: Archivos de audio convertidos (auto-limpieza)
- 📁 `/logs/`: Logs de aplicación (rotación automática)

## 🔒 Seguridad

- 🔐 **Keycloak Authentication**: Autenticación empresarial obligatoria en producción
- 🛡️ **CORS Protection**: Orígenes permitidos configurables
- 📝 **Input Validation**: Validación de archivos y números de teléfono
- 🧹 **Auto Cleanup**: Limpieza automática de archivos sensibles
- 🔄 **Session Management**: Manejo seguro de sesiones WhatsApp
- 🚫 **Rate Limiting**: Protección contra abuso (configurable)

## 🐛 Solución de Problemas

### **Problemas de Conexión**
```bash
# Verificar estado del contenedor
docker compose ps

# Ver logs detallados
docker compose logs --tail=50

# Reiniciar servicio
docker compose restart

# Verificar conectividad
curl http://localhost:3000/connection-status
```

### **Problemas de Audio**
- ✅ **Formatos soportados**: MP3, M4A, WAV, OGG
- ✅ **Conversión automática**: A formato Opus para WhatsApp
- ✅ **Limpieza automática**: Archivos eliminados después del envío
- ❌ **Error común**: Verificar permisos de directorio `/temp/`

### **Problemas de Deployment**
```bash
# Error: Directorio no existe
# Solución: Ejecutar setup manual primero

# Error: .env no encontrado  
# Solución: Crear .env con variables requeridas

# Error: Puerto en uso
# Solución: Verificar conflictos con netstat -tuln | grep :3000
```

## 🔄 Mantenimiento

### **Tareas Regulares**
- 📅 **Monitoring**: Verificar estado de contenedores diariamente
- 🧹 **Cleanup**: Los archivos temporales se limpian automáticamente
- 🔄 **Updates**: Deployment automático via GitHub Actions
- 💾 **Backups**: Respaldar `/bot_sessions/` semanalmente

### **Comandos Útiles**
```bash
# Estado de todos los clientes
for dir in /home/elporavv/workspaceandre/clientes/*/message-sender; do
    echo "=== $(basename $(dirname $dir)) ==="
    cd "$dir" && docker compose ps
done

# Logs de todos los clientes
for dir in /home/elporavv/workspaceandre/clientes/*/message-sender; do
    echo "=== $(basename $(dirname $dir)) ==="
    cd "$dir" && docker compose logs --tail=10
done
```

## 📞 Soporte

**Desarrollado por**: Andrés Vera  
**WhatsApp**: +595 992 756462  
**Website**: mindtechpy.net  
**GitHub**: poravv/message-sender

---

## 📄 Licencia

ISC License - Ver archivo LICENSE para más detalles.
