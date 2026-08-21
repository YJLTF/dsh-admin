#!/bin/sh
# /opt/dsh 是 dsh CLI 的运行时安装位置（PATH 中的 node_modules/.bin）。
# 挂载卷为空（或未挂载）时，用镜像内置的 /opt/dsh-image 基线版本播种，
# 使容器开箱即用；更新 dsh 只需替换挂载目录内容后重启容器。
set -e
if [ ! -e /opt/dsh/node_modules/.bin/dsh ]; then
  echo "[entrypoint] /opt/dsh 为空，从镜像内置基线版本初始化" >&2
  mkdir -p /opt/dsh
  cp -a /opt/dsh-image/. /opt/dsh/
fi
# 防御：tgz 若经非 Linux 文件系统中转丢失可执行位，这里补回。
chmod +x /opt/dsh/node_modules/.bin/* 2>/dev/null || true
exec node lib/cli.js "$@"
