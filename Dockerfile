FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=10000

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

EXPOSE 10000

CMD ["node", "server.js"]
