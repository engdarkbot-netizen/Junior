# Use Playwright's official image — Chromium + all system deps included
FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install Node dependencies (Playwright browser is already in the base image)
RUN npm ci --omit=dev

# Copy source files
COPY server.js   ./
COPY grocery.html ./

# Tell Playwright to use the pre-installed browser in the image
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 3000

CMD ["node", "server.js"]
