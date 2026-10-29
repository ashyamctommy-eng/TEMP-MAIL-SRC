FROM node:24-alpine

WORKDIR /app

# dumb-init keeps signal handling sane for graceful shutdown
RUN apk add --no-cache dumb-init

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY server ./server
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app

USER node
ENV NODE_ENV=production
EXPOSE 3000 25

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server/index.js"]
