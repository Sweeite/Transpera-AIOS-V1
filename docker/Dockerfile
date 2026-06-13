# AIOS sealed engine — single image, built once, run identically for every client.
# Per-client difference is ONLY env + data (one Supabase project per client) — never the code.
# See AIOS_Brief.md §8.2 (sealed core + plugins) and §8.1a (deployment topology).

# ---- build ----
FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY plugins ./plugins
RUN pnpm install --frozen-lockfile && pnpm -r build

# ---- runtime ----
FROM node:20-slim AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /app ./
# The engine resolves its tenant + plugins from env at boot (TENANT_ID), then serves API + worker.
# TODO: choose process model — single container running api+worker, or separate services.
CMD ["node", "packages/api/dist/server.js"]
