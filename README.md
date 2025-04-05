# WhatsApp Message Sender

Sistema de envío masivo de mensajes por WhatsApp con gestión de cola, manejo de sesiones y reinicio seguro.

## Características Técnicas

- Sistema de cola con procesamiento ordenado
- Gestión de sesiones WhatsApp (Baileys)
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
RESTART_PASSWORD=tu_clave_secreta   # Clave para reinicio/deshabilitación
ALLOWED_ORIGINS=http://dominio.com  # CORS permitidos
NODE_ENV=production                 # Entorno
```

### 3. Instalación de dependencias
```bash
npm install --legacy-peer-deps
```

### 4. Iniciar en desarrollo
```bash
npm start
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
- Cola de procesamiento ordenado
- Sistema de reintentos automáticos
- Monitoreo en tiempo real del progreso

### Gestión de Conexión
- Reconexión automática
- Detección de inactividad (30 minutos)
- Cierre seguro de sesiones
- Monitoreo de estado de conexión
- QR dinámico para reconexión

### Interfaz de Usuario
- Panel de control intuitivo
- Visualización de estado de conexión
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
