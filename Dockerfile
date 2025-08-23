# ---------- Build stage ----------
FROM node:18-bullseye-slim as builder
WORKDIR /app

# Evitar descarga de Chromium en npm i
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Instalar dependencias
COPY package*.json ./
RUN npm install --legacy-peer-deps

# Copiar todo (incluye /src, /public, etc.)
COPY . .

# ---------- Runtime stage ----------
FROM node:18-bullseye-slim
WORKDIR /app

# Paquetes del sistema para Chromium + ffmpeg
RUN apt-get update && apt-get install -y \
    chromium ffmpeg gconf-service libasound2 libatk1.0-0 libc6 libcairo2 libcups2 \
    libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 \
    libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 \
    libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 \
    libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates \
    fonts-liberation libnss3 lsb-release xdg-utils wget \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROME_BIN=/usr/bin/chromium

# Nodemon (si quieres hot-reload en contenedor)
RUN npm install -g nodemon

# Copiar artefactos desde builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/app.js ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/public ./public
COPY --from=builder /app/nodemon.json ./
COPY --from=builder /app/.env ./.env

# Directorios de trabajo
RUN mkdir -p uploads bot_sessions && chown -R node:node /app

USER node
EXPOSE ${PORT:-3000}

CMD ["nodemon", "app.js"]