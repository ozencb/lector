# Stage 1: Install deps and build client
FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json client/
COPY server/package.json server/
COPY shared/package.json shared/

RUN pnpm install --frozen-lockfile

COPY shared/ shared/
COPY client/ client/
COPY server/ server/
COPY tsconfig.json ./

RUN pnpm --filter client build

# Stage 2: Production image
FROM node:22-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json client/
COPY server/package.json server/
COPY shared/package.json shared/

RUN pnpm install --frozen-lockfile

COPY shared/ shared/
COPY server/ server/
COPY --from=builder /app/client/dist client/dist

ENV NODE_ENV=production

EXPOSE 3000

CMD ["pnpm", "--filter", "server", "exec", "tsx", "src/index.ts"]
