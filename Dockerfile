# The domain API + static front end, for docker-compose.prod.yml.
# Dev runs `node server/index.js` on the host instead — same code, no image.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# the API needs only express/pg/xlsx/workos — the heavyweight nocodb package
# stays out of the image on purpose
RUN npm install --omit=dev --no-audit --no-fund express pg xlsx @workos-inc/node
COPY server ./server
COPY migrations ./migrations
COPY public ./public
EXPOSE 8080
# migrations first, then serve — a failed migration stops the deploy loudly
CMD ["sh", "-c", "node server/migrate.js && node server/index.js"]
