# syntax=docker/dockerfile:1

# ---- 构建阶段：基于与运行时完全相同的 node 版本编译 TS 及原生模块 ----
FROM node:22-bookworm-slim AS build
# 工具链兜底：以防 better-sqlite3 在该平台没有预编译二进制文件。
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts 跳过 `prepare` 钩子（tsc 需要 src/，而此时
# 尚未复制）；rebuild 仅重新执行 better-sqlite3 的原生安装脚本。
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- 运行时阶段 ----
FROM node:22-bookworm-slim AS runtime
# 子 DSH CLI：`dsh`（Linux 垫片通过 `#!/usr/bin/env node` 启动）。
# （每个子进程的端口转发由编排器在进程内处理。）
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
# 子 DSH 端口范围需单独发布，例如：
#   docker run -p 3080:3080 -p 40000-40100:40000-40100 ...
# （请将 DSH_ADMIN_DSH_PORT_MIN/MAX 设置为相同的范围）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.DSH_ADMIN_PORT||3080)+'/login.html').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# 使用 exec 形式，使 node 成为 PID 1 并接收 SIGTERM（终止时会杀死子 DSH 进程）。
ENTRYPOINT ["node", "lib/cli.js"]
