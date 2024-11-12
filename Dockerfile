FROM node:20-bullseye as bot
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
EXPOSE 3009
CMD ["npm", "start"]
