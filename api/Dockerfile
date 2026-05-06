FROM node:20-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libnss3 \
    libgbm1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxkbcommon0 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    libasound2 \
    libxshmfence1 \
    libxss1 \
    fonts-liberation \
    ca-certificates \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS deps

COPY api/package.json api/package-lock.json* ./api/
COPY remotion/package.json remotion/package-lock.json* ./remotion/

RUN cd remotion && npm install --omit=dev --no-audit --no-fund
RUN cd api && npm install --no-audit --no-fund

FROM deps AS build

COPY remotion ./remotion
COPY api ./api

WORKDIR /app/api
RUN npm run build

FROM base AS runtime

WORKDIR /app

COPY --from=build /app/remotion ./remotion
COPY --from=deps /app/api/node_modules ./api/node_modules
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/api/package.json ./api/package.json
COPY --from=build /app/api/scripts ./api/scripts
COPY --from=build /app/api/src ./api/src
COPY --from=build /app/api/tsconfig.json ./api/tsconfig.json

WORKDIR /app/api

ENV NODE_ENV=production
ENV REMOTION_BUNDLE_DIR=/app/remotion
ENV WORK_DIR=/app/work
ENV SQLITE_PATH=/app/data/api.db

RUN mkdir -p /app/data /app/work

EXPOSE 3001

CMD ["node", "dist/src/server.js"]
