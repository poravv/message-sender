# Build stage
FROM node:18-bullseye-slim as builder
WORKDIR /app

# Copiar solo los archivos necesarios para instalar dependencias
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .

# Production stage
FROM node:18-bullseye-slim
WORKDIR /app

# Instalar tini y curl para healthcheck
RUN apt-get update && apt-get install -y tini curl && rm -rf /var/lib/apt/lists/*

# Copiar archivos necesarios desde el builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/app.js ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/.env ./.env

# Crear directorios necesarios y establecer permisos
RUN mkdir -p uploads bot_sessions && \
    chown -R node:node /app && \
    chmod 755 /app/bot_sessions

# Inicializar archivos JSON necesarios para Baileys
RUN echo '{"chats":[],"contacts":{},"messages":{}}' > /app/bot_sessions/baileys_store.json && \
    echo '{"creds":{},"keys":{}}' > /app/bot_sessions/creds.json && \
    chown node:node /app/bot_sessions/*.json

# Crear script de inicio
COPY --chown=node:node <<'EOF' /app/start.sh
#!/bin/bash
# Verificar y crear archivos JSON si no existen
if [ ! -f /app/bot_sessions/baileys_store.json ]; then
    echo '{"chats":[],"contacts":{},"messages":{}}' > /app/bot_sessions/baileys_store.json
fi
if [ ! -f /app/bot_sessions/creds.json ]; then
    echo '{"creds":{},"keys":{}}' > /app/bot_sessions/creds.json
fi
# Iniciar la aplicación
exec node app.js
EOF

RUN chmod +x /app/start.sh

# Usar usuario no root
USER node

EXPOSE ${PORT:-3000}

# Usar tini como entry point con la opción -s
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]

# Comando principal usando el script de inicio
CMD ["/app/start.sh"]
