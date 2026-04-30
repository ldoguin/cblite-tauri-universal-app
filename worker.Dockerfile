# Shared Dockerfile for all Node.js workers.
# Build arg WORKER selects which worker to build (e.g. email-worker).
#
# Usage:
#   docker build --build-arg WORKER=email-worker -f worker.Dockerfile -t email-worker .

ARG WORKER=email-worker

FROM node:20-slim AS base
RUN npm install -g pnpm@latest
WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/worker-core/package.json ./packages/worker-core/
ARG WORKER
COPY ${WORKER}/package.json ./${WORKER}/

# Install all workspace deps (worker-core + selected worker)
RUN pnpm install --frozen-lockfile --filter @cblite-uni-app/worker-core --filter ${WORKER}

# Copy source
COPY packages/worker-core/src ./packages/worker-core/src
COPY packages/worker-core/tsconfig.json ./packages/worker-core/
COPY ${WORKER}/src ./${WORKER}/src
COPY ${WORKER}/tsconfig.json ./${WORKER}/

# Build worker-core then the selected worker
RUN pnpm --filter @cblite-uni-app/worker-core build && \
    pnpm --filter ${WORKER} build

FROM node:20-slim AS runtime
RUN npm install -g pnpm@latest
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/worker-core/package.json ./packages/worker-core/
ARG WORKER
COPY ${WORKER}/package.json ./${WORKER}/

RUN pnpm install --frozen-lockfile --prod --filter @cblite-uni-app/worker-core --filter ${WORKER}

COPY --from=base /app/packages/worker-core/dist ./packages/worker-core/dist
COPY --from=base /app/${WORKER}/dist ./${WORKER}/dist

WORKDIR /app/${WORKER}
CMD ["node", "dist/index.js"]
