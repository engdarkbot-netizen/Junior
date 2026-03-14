FROM node:22-slim

# Needed by playwright install --with-deps
RUN apt-get update && apt-get install -y \
    ca-certificates \
    wget \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

# Install Chromium + all its OS-level dependencies automatically
RUN npx playwright install --with-deps chromium

COPY server.js    ./
COPY grocery.html ./

EXPOSE 3000

CMD ["node", "server.js"]
