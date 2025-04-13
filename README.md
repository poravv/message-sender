# WhatsApp Message Sender

Sistema de envío masivo de mensajes por WhatsApp con gestión de cola, manejo de sesiones y reinicio seguro. Implementado con whatsapp-web.js.

## Características Técnicas

- Sistema de cola con procesamiento ordenado
- Gestión de sesiones WhatsApp (whatsapp-web.js)
- Soporte para mensajes de voz (audio MP3)
- Envío de imágenes simples y múltiples
- Generación y refresco automático de QR
- Reinicio seguro del servidor
- Manejo de conexiones persistentes
- Sistema de reconexión automática
- Monitoreo de estado en tiempo real
- Despliegue con Docker
- Gestión de inactividad automática

## Requisitos

- Node.js >= 18
- Docker y Docker Compose (para despliegue con contenedores)
- NPM o Yarn

## Instalación

### 1. Clonar el repositorio
```bash
git clone <url-del-repositorio>
cd message-sender
```

### 2. Configurar variables de entorno
```bash
cp .env.example .env
```

Variables importantes en `.env`:
```env
PORT=3009                           # Puerto del servidor
RAILWAY_STATIC_URL=http://localhost # URL base
PUBLIC_URL=http://localhost         # URL pública
ALLOWED_ORIGINS=http://dominio.com  # CORS permitidos
NODE_ENV=production                 # Entorno
AUTHORIZED_PHONES=595992756462     # Números telefónicos autorizados (sin +)
FILE_RETENTION_HOURS=24            # Horas antes de eliminar archivos temporales
```

### 3. Instalación de dependencias
```bash
npm install whatsapp-web.js qrcode-terminal express multer csv-parser fluent-ffmpeg @ffmpeg-installer/ffmpeg dotenv
```

### 4. Iniciar en desarrollo
```bash
npm start
```

### 5. Instalación de dependencias adicionales para entornos sin interfaz gráfica
En servidores o entornos sin GUI (como algunos servidores Linux), es posible que necesites instalar dependencias adicionales para Chrome:

**Ubuntu/Debian:**
```bash
sudo apt-get install -y gconf-service libasound2 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils wget
```

**macOS:**
```bash
brew install --cask google-chrome
```

## Despliegue con Docker

1. Construir imagen:
```bash
docker build -t message-sender .
```

2. Ejecutar con docker-compose:
```bash
docker-compose up -d
```

## Sistema de Reinicio

El sistema implementa un mecanismo de reinicio seguro que:

1. Cierra correctamente las conexiones HTTP
2. Limpia los recursos de Baileys
3. Desconecta WhatsApp de forma segura
4. Reinicia el proceso completo

Para reiniciar manualmente:
1. Usar el botón "Deshabilitar" en la interfaz
2. Ingresar la clave de administrador
3. El sistema se reiniciará automáticamente

## Características Funcionales

### Gestión de Mensajes
- Envío masivo desde CSV
- Soporte para mensajes de texto
- Envío de imágenes individuales con texto
- Envío de múltiples imágenes
- **Envío de mensajes de voz (audio)** 
- Cola de procesamiento ordenado
- Sistema de reintentos automáticos
- Monitoreo en tiempo real del progreso

### Gestión de Conexión
- Implementación con whatsapp-web.js
- Reconexión automática mejorada
- Detección de inactividad (30 minutos)
- Cierre seguro de sesiones
- Monitoreo de estado de conexión
- Generación y refresco de códigos QR
- Optimización para entornos sin interfaz gráfica

### Interfaz de Usuario
- Panel de control intuitivo
- Visualización de estado de conexión
- Botón para refrescar código QR cuando expire
- Indicadores visuales de estado
- Cambio dinámico según el estado de conexión
- Modo autenticado con interfaz simplificada
- Barra de progreso para envío de mensajes

## Solución de Problemas

### Problemas con el código QR
Si el código QR no aparece o expira rápidamente:
1. Haz clic en el botón "Refrescar código QR"
2. Asegúrate de que tu conexión a internet sea estable
3. Si persiste, reinicia el servidor con el botón "Deshabilitar"

### Problemas con el envío de audio
Para garantizar que los mensajes de audio funcionen correctamente:
1. Asegúrate de que el formato de audio sea compatible (mp3, m4a, etc.)
2. El sistema convertirá automáticamente los archivos a MP3 para mejor compatibilidad
3. La duración máxima recomendada es de 2 minutos

### Errores en entornos sin interfaz gráfica
Si estás ejecutando en un servidor sin GUI y experimentas problemas:
1. Instala todas las dependencias de Chrome mencionadas en la sección de instalación
2. Configura Puppeteer para usar un navegador pre-instalado:
   ```
   CHROME_BIN=/ruta/a/chrome npm start
   ```
3. Aumenta la memoria disponible si es necesario:
   ```
   NODE_OPTIONS=--max_old_space_size=512 npm start
   ```
- Progreso de envío en tiempo real
- Estadísticas de envío
- Gestión de sesión WhatsApp

## Estructura de Archivos CSV

El archivo debe contener una columna con números de teléfono:
```csv
5959XXXXXXXX
5959XXXXXXXX
```

## Rendimiento y Límites

- Mensajes de texto: ~500/10 segundos
- Mensajes con imagen: ~500/8 minutos
- Tamaño máximo de imagen: 10MB
- Reconexiones automáticas: 5 intentos
- Reintentos por mensaje: 3 intentos
- Tamaño de lote: 100 mensajes

## Logs y Monitoreo

### Archivos de Log
- `baileys.log`: Conexión WhatsApp
- `core.class.log`: Núcleo del sistema 
- `queue.class.log`: Cola de mensajes

### Directorios Importantes
- `/uploads`: Archivos temporales
- `/bot_sessions`: Datos de sesión
- `/public`: Interfaz web

## Seguridad

- Protección con contraseña para reinicio
- Validación de origen de peticiones (CORS)
- Límite de tamaño de archivos
- Limpieza automática de archivos temporales
- Cierre seguro de sesiones

## Solución de Problemas

1. Error de conexión:
   - Verificar conexión a internet
   - Comprobar estado en panel de control
   - Usar botón "Deshabilitar" y volver a habilitar
   - Revisar logs para detalles

2. Mensajes no enviados:
   - Verificar formato de números: 5959XXXXXXXX
   - Comprobar estado de conexión WhatsApp
   - Revisar límites de envío
   - Consultar logs de errores

## Mantenimiento

1. Monitoreo regular:
   - Revisar logs periódicamente
   - Verificar espacio en /uploads
   - Monitorear uso de recursos

2. Reinicio preventivo:
   - Recomendado cada 24-48 horas
   - Usar botón "Deshabilitar" para reinicio seguro
   - Verificar recuperación automática

## Licencia

ISC License
