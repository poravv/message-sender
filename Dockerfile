###########
# Deps stage
###########
FROM node:20-bullseye-slim AS deps
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps

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
COPY nodemon.json ./nodemon.json

# Crear directorios de trabajo y permisos
RUN mkdir -p uploads bot_sessions temp && chown -R node:node /app
USER node

EXPOSE ${PORT}
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node", "app.js"]
