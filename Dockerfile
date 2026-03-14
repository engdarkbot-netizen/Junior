# Use a slim Node base and let playwright install its own Chromium.
# This avoids version mismatches between the npm package and the Docker image.
FROM node:22-slim

# System dependencies required by Chromium
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    libxss1 \
    lsb-release \
    wget \
    xdg-utils \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# Install all npm deps (including playwright)
RUN npm ci --omit=dev

# Download Chromium that matches the installed playwright version
RUN npx playwright install chromium

COPY server.js    ./
COPY grocery.html ./

EXPOSE 3000

CMD ["node", "server.js"]
