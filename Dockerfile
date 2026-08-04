# Cerviz Back Office — single container: API, web interface and database.
#
# SQLite lives on a mounted volume rather than inside the image, so the data
# survives every deploy. Litestream streams a continuous copy to object storage
# when it is configured, which is what makes a single-machine database safe.

# ---------- build ----------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Native module compilation needs a toolchain; the runtime image does not.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Reinstall production dependencies only, so the runtime image carries no
# build tooling or test framework.
RUN npm ci --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim

# sqlite3 is here for operational work (inspecting a backup, running a query
# during an incident); curl is for the health check.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates sqlite3 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV MIGRATIONS_DIR=/app/migrations
ENV PORT=8080

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server-dist ./server-dist
COPY --from=build /app/web-dist ./web-dist
COPY --from=build /app/core/db/migrations ./migrations
COPY --from=build /app/package.json ./package.json

# The database and evidence files live on the volume, never in the image.
RUN mkdir -p /data/documents /data/backups && chown -R node:node /data /app

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "server-dist/index.js"]
