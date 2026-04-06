FROM node:20-bookworm-slim

# Install system dependencies for Puppeteer + git for npm
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libgbm-dev \
    libasound2 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Configure git to use HTTPS instead of SSH for GitHub
# (needed for libsignal and eslint-config which use git+ssh:// URLs)
RUN git config --global url."https://github.com/".insteadOf "git@github.com:" && \
    git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000
CMD ["node", "server.js"]
