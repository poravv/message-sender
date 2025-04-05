# Build stage
FROM node:18-bullseye-slim as builder
WORKDIR /app

# Copiar solo los archivos necesarios para instalar dependencias
COPY package*.json ./

# Instalar todas las dependencias incluyendo devDependencies para nodemon
RUN npm install --legacy-peer-deps

# Copiar el resto de archivos de la aplicación
COPY . .

# Production stage
FROM node:18-bullseye-slim
WORKDIR /app

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
