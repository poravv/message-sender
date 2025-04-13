# Build stage
FROM node:18-bullseye-slim as builder
WORKDIR /app

# Establecer variable para evitar la descarga de Chromium durante la instalación
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Copiar solo los archivos necesarios para instalar dependencias
COPY package*.json ./

# Instalar todas las dependencias incluyendo devDependencies para nodemon
RUN npm install --legacy-peer-deps

# Copiar el resto de archivos de la aplicación
COPY . .

# Production stage
FROM node:18-bullseye-slim
WORKDIR /app

# Instalación de dependencias del sistema necesarias para Puppeteer (Chrome) y FFmpeg
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

# Configurar Chromium como navegador para Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROME_BIN=/usr/bin/chromium

# Instalar nodemon globalmente en la imagen de producción
RUN npm install -g nodemon

# Copiar solo los archivos necesarios desde el builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/app.js ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/nodemon.json ./
COPY --from=builder /app/.env ./.env

# Crear directorio para uploads y bot_sessions
RUN mkdir -p uploads bot_sessions && chown -R node:node /app

# Usar usuario no root
USER node

EXPOSE ${PORT:-3000}

# Usar nodemon en lugar de node directamente
CMD ["nodemon", "app.js"]
