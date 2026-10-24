# One POS web image (Next.js, self-contained build). Built by deploy/release.sh with context = web/.
# The browser only talks to this app; /api/* and the live hub /hubs/* are proxied to the environment's API container. The web address
# prefix (/onepos, /onepos-test) and that API's name are built in, so release.sh makes one web image per environment from the same source.

FROM node:22-alpine AS build
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG BASE_PATH=""
ARG API_URL=http://api:8080
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_STANDALONE=1 NEXT_PUBLIC_BASE_PATH=$BASE_PATH ONEPOS_API_URL=$API_URL
RUN npx next build

FROM node:22-alpine
WORKDIR /app
ARG BASE_PATH=""
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 BASE_PATH=$BASE_PATH
COPY --from=build --chown=node:node /web/.next/standalone ./
COPY --from=build --chown=node:node /web/.next/static ./.next/static
COPY --from=build --chown=node:node /web/public ./public
ARG VERSION=dev
ENV ONEPOS_VERSION=$VERSION
LABEL org.opencontainers.image.title="onepos-web" org.opencontainers.image.version=$VERSION
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 CMD wget -qO- "http://127.0.0.1:3000${BASE_PATH}/login" >/dev/null || exit 1
CMD ["node", "server.js"]
