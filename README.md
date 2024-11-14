# Chatbot

Envio de mensajes masivos desde whatsapp web.

Como observacion, cuando el mensaje es solo textos, envia 500 mensajes en 10 segundos

Cuando el mensaje es texto con Imagen, envia 500 mensajes en 8 minutos



#### Para rellenar el .env
|  **NAME**                 | Value           |
|-------------------------------|--------------------------|





## Para levantar con PM2
```
pm2 start app.js --name "sender"
```

## Ver el estado
```
pm2 status
```

##Ver los logs
```
pm2 logs sender
```

## Activar para que se reinicie y siga funcionando 
```
pm2 startup
```

```
pm2 save
```