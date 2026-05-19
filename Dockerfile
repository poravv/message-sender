###########
# Deps stage (prod deps only)
###########
FROM node:20-bullseye-slim AS deps
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps

###########
# Builder stage (compiles Tailwind CSS, then discarded)
###########
FROM node:20-bullseye-slim AS builder
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY tailwind.config.js ./
COPY src/styles ./src/styles
COPY public ./public
RUN npm run build:css

############
# Runtime
############
FROM node:20-bullseye-slim
WORKDIR /app

# Paquetes mínimos para runtime (tini para señales, ffmpeg para audio, wget para healthcheck de compose)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg tini ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000

# Copiar sólo lo necesario
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package*.json ./
COPY app.js ./
COPY public ./public
COPY src ./src
# Inyectar CSS compilado desde el stage builder
COPY --from=builder /app/public/css/tw.css ./public/css/tw.css
# Crear directorios de trabajo y permisos
RUN mkdir -p uploads bot_sessions temp && chown -R node:node /app
USER node

EXPOSE ${PORT}
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node", "app.js"]
