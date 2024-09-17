FROM node:18-bullseye as bot
WORKDIR /app
COPY package*.json ./
RUN npm i --legacy-peer-deps
COPY . .
ARG RAILWAY_STATIC_URL
ARG PUBLIC_URL
ARG PORT
CMD ["npm", "start"]

# Construir la imagen Docker
#sudo docker build -t message-sender-laura .

# Ejecutar el contenedor Docker
#sudo docker run -e RAILWAY_STATIC_URL=http://localhost -e PUBLIC_URL=http://localhost -e PORT=3009 -p 3009:3000 --name message-sender-laura01 message-sender-laura

