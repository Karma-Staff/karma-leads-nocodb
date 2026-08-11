# The domain API + static front end — used by Render (see render.yaml) and
# docker-compose.prod.yml. Dev runs `node server/index.js` on the host
# instead — same code, no image.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# --omit=dev keeps sqlite3 (only the local ETL needs it) out of the image
RUN npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY migrations ./migrations
COPY public ./public
EXPOSE 8080
# migrations first, then serve — a failed migration stops the deploy loudly
CMD ["sh", "-c", "node server/migrate.js && node server/index.js"]
