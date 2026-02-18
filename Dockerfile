FROM node:20-bullseye

Install poppler (pdftoppm) + minimal runtime deps

RUN apt-get update && apt-get install -y –no-install-recommends
poppler-utils && rm -rf /var/lib/apt/lists/*

WORKDIR /app

Install node deps first (better caching)

COPY package*.json ./ RUN npm ci –omit=dev || npm install

Copy app source

COPY . .

ENV NODE_ENV=production EXPOSE 3000

CMD [“node”, “server.js”]
