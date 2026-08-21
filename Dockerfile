# syntax=docker/dockerfile:1

# ---- build stage: compile TS + native modules against the exact runtime node ----
FROM node:22-bookworm-slim AS build
# Toolchain fallback in case better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts skips the `prepare` hook (tsc needs src/ which is not
# copied yet); rebuild re-runs only better-sqlite3's native install script.
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ----
FROM node:22-bookworm-slim AS runtime
# The child DSH CLI: `dsh` (Linux shim spawns via `#!/usr/bin/env node`).
# (Per-child port forwarding is handled in-process by the orchestrator.)
RUN npm install -g @deepseek-ai/dsh
ENV NODE_ENV=production \
    DSH_ADMIN_HOST=0.0.0.0 \
    DSH_ADMIN_PORT=3080 \
    DSH_ADMIN_DATA_ROOT=/var/lib/dsh-admin
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/lib ./lib
COPY web ./web
COPY package.json ./
VOLUME ["/var/lib/dsh-admin"]
EXPOSE 3080
# Publish the child-DSH port range separately, e.g.
#   docker run -p 3080:3080 -p 40000-40100:40000-40100 ...
# (set DSH_ADMIN_DSH_PORT_MIN/MAX to the same range).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.DSH_ADMIN_PORT||3080)+'/login.html').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# exec form so node is PID 1 and receives SIGTERM (teardown kills child DSHs).
ENTRYPOINT ["node", "lib/cli.js"]
