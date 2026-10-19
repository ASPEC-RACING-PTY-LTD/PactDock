# PactDock Server image. Build from the repository root:
#   docker build -f server/Dockerfile -t pactdock-server .
# Base image pinned by digest (node 24.22.0, Alpine 3.24, multi-arch index).
ARG NODE_IMAGE=node:24.22.0-alpine3.24@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY server/src ./server/src
COPY server/tsconfig.json ./server/
RUN npx tsc -p server/tsconfig.json

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PACTDOCK_DATA_DIR=/data \
    PACTDOCK_PORT=8080
WORKDIR /app
# No runtime dependencies: only compiled JavaScript, static assets and package.json (ESM).
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/server/dist ./server/dist
COPY server/static ./server/static
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["node", "/app/server/dist/server/src/main.js"]
CMD ["serve"]
