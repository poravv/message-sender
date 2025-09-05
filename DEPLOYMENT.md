# 🚀 WhatsApp Message Sender - Production Deployment

## 📋 Requisitos Previos

- Docker y Docker Compose instalados
- Al menos 2GB de RAM disponible
- Puerto 3010 disponible (configurable)

## ⚡ Inicio Rápido

### 1. Configuración del Entorno

```bash
# Clonar el repositorio
git clone <your-repo-url>
cd message-sender

# Copiar archivo de configuración
cp .env.example .env

# Editar configuración (obligatorio)
nano .env
```

### 2. Configurar Variables de Entorno

Edita el archivo `.env` con tus datos:

```bash
PORT=3010
NODE_ENV=production
RAILWAY_STATIC_URL=https://tu-dominio.com
PUBLIC_URL=https://tu-dominio.com
```

### 3. Iniciar en Producción

```bash
# Opción 1: Script automático
npm run prod:start

# Opción 2: Docker Compose manual
docker-compose up -d
```

## 📊 Comandos de Gestión

```bash
# Ver logs en tiempo real
npm run prod:logs

# Reiniciar servicio
npm run docker:restart

# Parar servicio
npm run prod:stop

# Reconstruir e iniciar
docker-compose up -d --build
```

## 🏥 Health Check

La aplicación incluye health checks automáticos:
- **URL**: `http://localhost:3010/`
- **Intervalo**: 30 segundos
- **Timeout**: 10 segundos

## 📁 Estructura de Volúmenes

```
./uploads/     → Archivos subidos (imágenes, audio)
./bot_sessions/ → Sesiones de WhatsApp
./temp/        → Archivos temporales
```

## 🔧 Configuración Avanzada

### Proxy Reverso (Nginx)

Si usas Nginx como proxy reverso, usa `nginx.conf.example` como base:

```bash
# Copiar configuración
cp nginx.conf.example /etc/nginx/sites-available/whatsapp-sender
ln -s /etc/nginx/sites-available/whatsapp-sender /etc/nginx/sites-enabled/

# Editar con tu dominio
sudo nano /etc/nginx/sites-available/whatsapp-sender

# Reiniciar Nginx
sudo systemctl reload nginx
```

### SSL/HTTPS

Para producción con HTTPS:

1. Obtén certificados SSL (Let's Encrypt recomendado)
2. Configura Nginx con los certificados
3. Actualiza `PUBLIC_URL` con `https://`

### Escalabilidad

Para mayor rendimiento:

```yaml
# En docker-compose.yml
deploy:
  replicas: 2
  resources:
    limits:
      cpus: '1.0'
      memory: 1G
    reservations:
      memory: 512M
```

## 🐛 Troubleshooting

### Problema: Container no inicia
```bash
# Ver logs detallados
docker-compose logs audio-sender

# Verificar permisos de volúmenes
sudo chown -R 1000:1000 uploads bot_sessions temp
```

### Problema: Error de permisos de archivos
```bash
# Dentro del container
docker exec -it audio-sender chown -R node:node /app
```

### Problema: QR no se genera
```bash
# Verificar que Chrome está instalado en el container
docker exec -it audio-sender which chromium
```

## 📈 Monitoreo

### Logs Estructurados
Los logs están limitados a 10MB x 3 archivos rotados automáticamente.

### Métricas de Sistema
```bash
# CPU y memoria del container
docker stats audio-sender

# Espacio en disco de volúmenes
du -sh uploads/ bot_sessions/ temp/
```

## 🔐 Seguridad

### Variables de Entorno Sensibles
- Nunca commitees el archivo `.env`
- Usa secretos de Docker en producción real
- Rota las claves regularmente

### Firewall
```bash
# Permitir solo puerto necesario
sudo ufw allow 3010/tcp
sudo ufw enable
```

## 🚀 Deployment en la Nube

### Railway/Heroku
```bash
# Build pack configurado automáticamente
# Solo necesitas configurar variables de entorno en la plataforma
```

### VPS/Servidor Dedicado
```bash
# Instalar Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Instalar Docker Compose
sudo apt install docker-compose-plugin

# Clonar y ejecutar
git clone <repo>
cd message-sender
cp .env.example .env
# Editar .env con tus datos
./start-prod.sh
```

## 📞 Soporte

**Desarrollado por**: Andrés Vera  
**WhatsApp**: +595 992 756462  
**Website**: mindtechpy.net  
**Instagram**: @_vienecadames_  

---

💡 **Tip**: Mantén siempre backups de las carpetas `bot_sessions` y `uploads` para preservar las sesiones de WhatsApp y archivos subidos.