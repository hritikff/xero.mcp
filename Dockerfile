# Node 24 runs .ts natively - no tsc, no build step, no dist/ to go stale.
# Same discipline as the main repo's Dockerfile; the image is the source tree.
FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src
COPY netlify ./netlify
COPY server.ts ./server.ts

# Cloud Run sets PORT; server.ts already reads it (process.env.PORT ?? 8080).
EXPOSE 8080
CMD ["node", "server.ts"]
