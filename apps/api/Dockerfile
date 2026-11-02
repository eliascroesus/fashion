# Build from the repo root: docker build -f apps/api/Dockerfile .
# Node runs the TypeScript sources directly (type stripping), so there is no build step.
FROM node:22.23-slim AS base
RUN npm install -g pnpm@11.20.0
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter @outfitly/api...

FROM base
ENV NODE_ENV=production
COPY --from=deps /app ./
COPY packages/shared/src packages/shared/src
COPY packages/db/src packages/db/src
COPY packages/db/scripts packages/db/scripts
COPY packages/db/migrations packages/db/migrations
COPY apps/api/src apps/api/src
USER node
WORKDIR /app/apps/api
EXPOSE 8080
CMD ["node", "--import", "./src/instrument.ts", "src/server.ts"]
