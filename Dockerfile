# syntax=docker/dockerfile:1.7

# ---- Build stage: compile TypeScript and resolve production deps -----------
FROM node:22-alpine AS builder

# Native deps for better-sqlite3 build
RUN apk add --no-cache python3 make g++

WORKDIR /app
RUN corepack enable

# pnpm 10+ macht "ignored build scripts" zum fatalen Fehler. Der einzige
# zuverlässige Weg in nicht-interaktiven Docker-Builds ist --ignore-scripts
# plus expliziter rebuild des einen nativen Moduls, das die Runtime braucht.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm rebuild better-sqlite3

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

RUN pnpm prune --prod --ignore-scripts \
 && pnpm rebuild better-sqlite3

# ---- Runtime stage: minimal image, non-root user ---------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /data \
    && chown -R app:app /data

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/package.json ./package.json
COPY --chown=app:app config ./config

USER app

ENV NODE_ENV=production \
    DB_PATH=/data/social-to-chat.db \
    CONFIG_PATH=/app/config/platforms.yaml

VOLUME ["/data"]

CMD ["node", "dist/src/main.js"]
