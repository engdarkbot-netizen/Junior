FROM node:22-slim

# System deps for Chromium (wget used by HEALTHCHECK too)
RUN apt-get update && apt-get install -y \
    ca-certificates \
    wget \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Layer: dependencies (cached unless package.json changes)
COPY package*.json ./
RUN npm ci --omit=dev

# Layer: install Chromium + OS-level deps (cached unless Playwright version changes)
RUN npx playwright install --with-deps chromium

# Layer: application code
COPY server.js grocery.html ./

EXPOSE 3000

# Health check — waits 60s for browser to warm up, then checks every 30s
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health | grep -q '"status":"ok"' || exit 1

CMD ["node", "server.js"]
