FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    TZ=America/Toronto \
    DB_PATH=/data/game.db
RUN apk add --no-cache tzdata
WORKDIR /app
COPY server.js prices.csv hints.json ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
