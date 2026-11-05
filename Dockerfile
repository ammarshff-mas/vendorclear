FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY . .

ENV PORT=5000
ENV DB_PATH=/app/data/vendorclear.db
RUN mkdir -p /app/data

EXPOSE 5000

CMD ["node", "server.js"]
