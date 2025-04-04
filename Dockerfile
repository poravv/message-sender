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

# Crear directorios necesarios
RUN mkdir -p uploads bot_sessions && chown -R node:node /app

# Usar usuario no root
USER node

EXPOSE ${PORT:-3000}

# Usar tini como entry point
ENTRYPOINT ["/usr/bin/tini", "--"]

# Comando principal
CMD ["node", "app.js"]
