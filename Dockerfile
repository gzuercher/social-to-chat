# syntax=docker/dockerfile:1.7

# ---- Build stage: compile TypeScript and resolve production deps -----------
FROM node:25-alpine AS builder

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
FROM node:25-alpine AS runtime

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
    STATE_DB_PATH=/data/social-to-chat.db \
    CONFIG_PATH=/app/config/platforms.yaml \
    PLATFORMS_TEMPLATE_PATH=/app/config/platforms.yaml.example

VOLUME ["/data"]

# Erkennt „Prozess lebt, aber Poll-Loop hängt": der health-Subcommand prüft,
# dass der letzte Lauf (metadata.last_run_at) jünger als 15 min ist.
HEALTHCHECK --interval=2m --timeout=15s --start-period=2m --retries=2 \
  CMD ["node", "dist/src/main.js", "health"]

CMD ["node", "dist/src/main.js"]
