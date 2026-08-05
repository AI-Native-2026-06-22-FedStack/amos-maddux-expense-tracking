# syntax=docker/dockerfile:1.7

FROM node:24-trixie-slim AS build

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package-lock.json ./apps/api/
COPY packages/shared-schemas/package.json ./packages/shared-schemas/
COPY apps/web/package.json ./apps/web/
COPY services/tivs-acl/package.json ./services/tivs-acl/

RUN npm ci --workspace @expenseflow/api --include-workspace-root

COPY tsconfig.json ./
COPY config ./config
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json ./apps/api/
COPY apps/api/src ./apps/api/src
COPY apps/api/healthcheck.js ./apps/api/healthcheck.js
COPY packages/shared-schemas ./packages/shared-schemas

RUN npm --workspace @expenseflow/api run build
RUN chmod 0755 apps/api/healthcheck.js

FROM node:24-trixie-slim AS production-deps

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package-lock.json ./apps/api/
COPY packages/shared-schemas/package.json ./packages/shared-schemas/
COPY apps/web/package.json ./apps/web/
COPY services/tivs-acl/package.json ./services/tivs-acl/

RUN npm ci --omit=dev --workspace @expenseflow/api --include-workspace-root

FROM gcr.io/distroless/nodejs24-debian13 AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=production-deps /workspace/node_modules ./node_modules
COPY --from=build /workspace/dist/apps/api/src ./dist/apps/api/src
COPY --from=build /workspace/apps/api/package.json ./package.json
COPY --from=build /workspace/apps/api/healthcheck.js ./healthcheck.js
COPY --from=build /workspace/packages/shared-schemas ./packages/shared-schemas
COPY --from=build /workspace/config ./dist/config

USER nonroot
EXPOSE 3000

HEALTHCHECK --start-period=30s --interval=10s --timeout=3s --retries=3 CMD ["/nodejs/bin/node", "./healthcheck.js"]
CMD ["dist/apps/api/src/server.js"]
