# WhatsApp Message Sender

Sistema de envío masivo de mensajes por WhatsApp con gestión de cola y soporte para imágenes.

## Características

- Envío masivo de mensajes desde archivo CSV
- Soporte para envío de imágenes (individual o múltiple)
- Sistema de cola con reintentos automáticos
- Interfaz web amigable
- Gestión de sesiones de WhatsApp
- Despliegue con Docker
- Monitoreo de estado de conexión

## Requisitos Previos

- Node.js >= 18
- Docker y Docker Compose (para despliegue con contenedores)
- NPM o Yarn

## Instalación y Configuración

### 1. Clonar el repositorio
```bash
git clone <url-del-repositorio>
cd message-sender
```

### 2. Configurar variables de entorno
Copia el archivo `.env.example` a `.env`:
```bash
cp .env.example .env
```
Edita el archivo `.env` con tus configuraciones.

### 3. Instalación de dependencias
```bash
npm install
```

## Ejecución

### Desarrollo
```bash
npm start
```

### Producción con Docker

1. Construir la imagen:
```bash
docker build -t message-sender .
```

2. Ejecutar con docker-compose:
```bash
docker-compose up -d
```

## Configuración del Dominio

Para configurar el dominio de tu aplicación y asegurar que los endpoints funcionen correctamente:

1. Modifica las siguientes variables en tu archivo `.env`:
```bash
RAILWAY_STATIC_URL=https://tudominio.com   # URL base para recursos estáticos
PUBLIC_URL=https://tudominio.com           # URL pública del servidor
ALLOWED_ORIGINS=https://tudominio.com      # Dominios permitidos para CORS
```

2. Si necesitas permitir múltiples dominios o subdominios, puedes agregarlos en ALLOWED_ORIGINS separados por comas:
```bash
ALLOWED_ORIGINS=https://tudominio.com,https://api.tudominio.com,https://admin.tudominio.com
```

3. Después de modificar las variables, reconstruye y reinicia el contenedor:
```bash
docker compose down
docker compose up -d --build
```

### Propósito de cada variable

- `RAILWAY_STATIC_URL`: Define la URL base para cargar recursos estáticos
- `PUBLIC_URL`: Define la URL base para las peticiones del frontend
- `ALLOWED_ORIGINS`: Define los dominios permitidos para realizar peticiones (CORS)

## Uso

1. Accede a la interfaz web: `http://localhost:<PORT>`
2. Escanea el código QR con WhatsApp
3. Prepara tu archivo CSV con los números (formato: 5959XXXXXXXX)
4. Envía tus mensajes

## Estructura de archivos CSV

El archivo CSV debe contener una columna con números de teléfono:
```
5959xxxxxxxx
5959xxxxxxxx
```

## Estadísticas de Rendimiento

- Mensajes de texto: ~500 mensajes/10 segundos
- Mensajes con imagen: ~500 mensajes/8 minutos

## Mantenimiento

### Logs
Los logs se encuentran en:
- `baileys.log`: Logs de conexión WhatsApp
- `core.class.log`: Logs del núcleo
- `queue.class.log`: Logs de la cola de mensajes

### Directorios importantes
- `/uploads`: Archivos temporales de imágenes
- `/bot_sessions`: Datos de sesión de WhatsApp

## Solución de Problemas

1. Error de conexión:
   - Verifica tu conexión a internet
   - Asegúrate de que el QR esté actualizado
   - Reinicia el servidor si es necesario

2. Mensajes no enviados:
   - Verifica el formato de los números
   - Revisa los logs para más detalles
   - Considera los límites de WhatsApp

## Seguridad

- Cambia la contraseña de administrador en el .env
- No compartas tus archivos de sesión
- Mantén actualizadas las dependencias

## Limitaciones

- Respeta las políticas de uso de WhatsApp
- Evita envíos masivos agresivos
- Considera los límites de la API

## Contribuir

1. Haz un Fork del repositorio
2. Crea una rama para tu feature
3. Haz commit de tus cambios
4. Envía un pull request

## Licencia

ISC License
