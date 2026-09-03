# 打包 @deepseek-ai/dsh（含全部依赖，linux 平台）为 dsh-cli.tgz。
# 将其拷贝到内网服务器并解压到 bind mount 目录（./dsh-cli -> /opt/dsh），
# 即可在不重建、不重传镜像的情况下更新 dsh。
# 用法：powershell -File scripts\pack-dsh.ps1 [-Version <npm 版本号|latest>]
# 持久缓存卷 dsh-npm-cache 保留下载产物，重复构建命中缓存，仅首次全量下载。
# 必须用 --prefer-online：--prefer-offline 会跳过元数据新鲜度校验，
# 新发布的版本不在缓存的 registry 元数据里时会误报 ETARGET；
# prefer-online 仅重新校验元数据（304，开销极小），tarball 仍走缓存。
param([string]$Version = "latest")
$ErrorActionPreference = "Stop"
# 必须与运行时基础镜像 / node 大版本一致，以保证二进制兼容。
$image = "node:22-bookworm-slim"
$inner = 'npm install --no-audit --no-fund --prefer-online --prefix /tmp/s @deepseek-ai/dsh@' + $Version + ' && tar -czf /out/dsh-cli.tgz -C /tmp/s node_modules'
docker run --rm -v "${PWD}:/out" -v dsh-npm-cache:/root/.npm $image bash -c $inner
if ($LASTEXITCODE -ne 0) { Write-Error "打包失败（退出码 $LASTEXITCODE）"; exit $LASTEXITCODE }
Write-Host "dsh-cli.tgz 已生成。在内网服务器上（docker-compose.yml 同级目录）执行："
Write-Host "  rm -rf dsh-cli/node_modules && tar -xzf dsh-cli.tgz -C dsh-cli"
Write-Host "  docker compose restart"
