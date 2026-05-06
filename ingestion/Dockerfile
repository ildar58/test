FROM node:20-alpine

WORKDIR /app

# Use npm to keep the image self-contained (no workspace lockfile needed)
COPY package.json ./
RUN npm install --omit=optional --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

RUN mkdir -p /app/data

EXPOSE 3001
CMD ["node", "dist/server.js"]
