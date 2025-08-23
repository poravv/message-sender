# =========================
# Build stage
# =========================
FROM node:18-bullseye-slim AS builder
WORKDIR /app

# Evitar descarga de Chromium en instalación
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Instalar dependencias
COPY package*.json ./
RUN npm install --legacy-peer-deps

# Copiar el resto del proyecto (incluye src/, public/, etc.)
COPY . .

# =========================
# Runtime stage (producción)
# =========================
FROM node:18-bullseye-slim
WORKDIR /app

# Dependencias del sistema para Chromium y FFmpeg (whatsapp-web.js)
RUN apt-get update && apt-get install -y \
    chromium \
    ffmpeg \
    gconf-service \
    libasound2 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgcc1 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    ca-certificates \
    fonts-liberation \
    libnss3 \
    lsb-release \
    xdg-utils \
    wget \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Configurar Chromium para Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROME_BIN=/usr/bin/chromium

# Copiar artefactos desde el builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/app.js ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/public ./public
# (opcional) variables por defecto dentro de la imagen
# COPY --from=builder /app/.env ./.env
# (opcional) nodemon.json si lo usas en dev dentro del contenedor
# COPY --from=builder /app/nodemon.json ./

# Directorios usados en runtime
RUN mkdir -p uploads bot_sessions && chown -R node:node /app

# Usuario no root
USER node

# Puerto (honra PORT si viene del entorno)
EXPOSE ${PORT:-3010}

# Arranque en producción: usa node (no nodemon)
CMD ["node", "app.js"]