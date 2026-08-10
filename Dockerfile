FROM node:20-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --omit=dev

COPY qbittorrent-server.js ./server.js
COPY public ./public

ENV NODE_ENV=production
ENV CACHE_DIR=/data/cache
VOLUME ["/data"]
EXPOSE 3000

CMD ["npm", "start"]
