FROM node:20-slim

# Install poppler (for pdftoppm)
RUN apt-get update && apt-get install -y poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better caching)
COPY package*.json ./
RUN npm install

# Copy app source
COPY . .

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]