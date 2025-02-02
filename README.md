# Pasos para habilitar PM2 en el proyecto
## El pm2 usamos para habilitar el reinicio del servicio

Envio de mensajes masivos desde whatsapp web.

Como observacion, cuando el mensaje es solo textos, envia 500 mensajes en 10 segundos

Cuando el mensaje es texto con Imagen, envia 500 mensajes en 8 minutos


#### Para rellenar el .env
Crea el .env 

```
RESTART_PASSWORD=12345
RAILWAY_STATIC_URL=http://localhost
PUBLIC_URL=http://localhost
PORT=3009
```


### Instalamos pm2
```
npm install -g pm2
```
### inicializamos 
pm2 start app.js --name mi-servidor


