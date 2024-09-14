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
#sudo docker build -t chatbot-universidad-01 .

# Ejecutar el contenedor Docker
#sudo docker run -e RAILWAY_STATIC_URL=http://localhost -e PUBLIC_URL=http://localhost -e PORT=3005 -p 3005:3000 --name chat-universidad-01 chatbot-universidad-01

