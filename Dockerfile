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
# 子 DSH CLI：安装到 /opt/dsh-image 作为镜像内置的基线版本（垫片通过
# `#!/usr/bin/env node` 启动；每个子进程的端口转发由编排器在进程内处理）。
# 运行时的真实查找路径是 /opt/dsh（见 PATH 与 entrypoint）：
# 挂载卷覆盖 /opt/dsh 后，内网更新 dsh 只需替换挂载目录内容，
# 无需重建 / 重传镜像。清空挂载目录再重启即可回退到镜像基线版本。
ARG DSH_VERSION=latest
RUN npm install --prefix /opt/dsh-image @deepseek-ai/dsh@${DSH_VERSION}
ENV NODE_ENV=production \
    DSH_ADMIN_HOST=0.0.0.0 \
    DSH_ADMIN_PORT=3080 \
    DSH_ADMIN_DATA_ROOT=/var/lib/dsh-admin
ENV PATH=/opt/dsh/node_modules/.bin:$PATH
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/lib ./lib
COPY web ./web
COPY package.json ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
VOLUME ["/var/lib/dsh-admin"]
EXPOSE 3080
# 子 DSH 端口范围需单独发布，例如：
#   docker run -p 3080:3080 -p 40000-40100:40000-40100 ...
# （请将 DSH_ADMIN_DSH_PORT_MIN/MAX 设置为相同的范围）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.DSH_ADMIN_PORT||3080)+'/login.html').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# 首次启动时向 /opt/dsh 播种基线版本，随后 exec 保持 node 为 PID 1
# （终止时会杀死子 DSH 进程并接收 SIGTERM）。
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
