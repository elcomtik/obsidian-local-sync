FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json esbuild.daemon.config.mjs ./
COPY src ./src
COPY src-core ./src-core
COPY src-daemon ./src-daemon

RUN npm run build:daemon
RUN npm prune --omit=dev

FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist-daemon ./dist-daemon

USER node

ENTRYPOINT ["node", "dist-daemon/main.js"]
