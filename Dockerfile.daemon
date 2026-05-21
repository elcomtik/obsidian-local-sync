FROM node:22-alpine AS build

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

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist-daemon ./dist-daemon

USER node

ENTRYPOINT ["node", "dist-daemon/main.js"]
