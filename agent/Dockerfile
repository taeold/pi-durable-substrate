FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.ts ./

RUN mkdir -p /workspace

EXPOSE 80

CMD ["node", "server.ts"]
