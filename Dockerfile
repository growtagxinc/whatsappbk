# Use Node.js as the base image
FROM node:18-bullseye-slim

# Install Google Chrome and necessary dependencies for Puppeteer/WhatsApp Web
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set up the working directory inside the container
WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy all the application files
COPY . .

# Hugging Face Spaces exposes port 7860 by default
EXPOSE 7860
ENV PORT=7860

# Start the Node.js backend
CMD ["node", "server.js"]
