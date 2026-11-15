# Stage 1: build the static site with Vite
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY . .
RUN npm run build

# Stage 2: one Node process serves dist/ and hosts the WebSocket relay
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY server/ server/
COPY --from=build /app/dist dist/

USER node
EXPOSE 8080
CMD ["node", "server/index.js"]
