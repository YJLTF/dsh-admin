# Docker 内网部署（局域网 IP 访问，无域名）

面向内网服务器：用户通过 `http://<内网IP>:3080` 访问，不使用域名/DNS/TLS。

## 原理与关键配置

无域名时子域名模式不可用，子路径代理又与 DSH SPA 的绝对路径资源不兼容（见
[troubleshooting.md](troubleshooting.md) §404）。内网模式改为**直连子 DSH 端口**：

- `DSH_ADMIN_PUBLIC_HOST=<内网IP>`：DSH 链接生成为 `http://<内网IP>:<子端口>/`
- `DSH_ADMIN_DSH_PORT_MIN/MAX`：把子 DSH 端口固定在一个范围内，供 Docker 映射
- `DSH_ADMIN_HOST=0.0.0.0`（镜像默认已设）：容器内监听全部网卡

实现细节：DSH CLI 出于安全拒绝绑定 `0.0.0.0`（只听回环），而 Docker 端口映射 DNAT
到容器 eth0。内网模式下编排服务会为每个运行中的 DSH 在 eth0 上起一个**内置 HTTP/WS
反向代理**（转发到该实例的回环端口，随启动/停止/崩溃重启自动管理），它会：

1. **剥掉 Origin/Referer 等头** —— 否则 DSH 的浏览器信任栅栏对任何带 Origin 的请求
   返回 403（页面能开但功能 API 全挂）；
2. **向 HTML 响应注入 `crypto.randomUUID` polyfill** —— `http://<内网IP>` 是非安全
   上下文，浏览器不暴露 `crypto.randomUUID`（`crypto.subtle` 同理），而 DSH 前端
   插件用它生成 RPC id，缺失时报 `crypto.randomUUID is not a function`（如选择
   工作区目录时）。polyfill 用 `crypto.getRandomValues`（非安全上下文可用）实现；
3. **改写连接插件里的 loopback 门** —— DSH 把「页面 hostname 是回环地址」当作
   settings 可用的前提（"settings RPCs are loopback-only"），非回环来源直接报
   `settings are unavailable in this browser`（如配置模型时报「加载提供方目录
   失败」）。`location.hostname` 在浏览器里不可覆写（LegacyUnforgeable），因此
   forwarder 对 `dsh-client-connection` 的 client.js 做字节级改写，把
   `isLoopbackHostname(pageLocation.hostname)` 替换为 `(true)`。转发路径本身
   就是回环（浏览器 → forwarder → 子 DSH 的 127.0.0.1），原安全不变量仍成立；
4. **访问令牌门禁** —— 已发布的端口在内网对任何主机可达，因此每个实例持有
   随机令牌（随每次启动/重启轮换）：编排服务返回的链接携带 `?dsh_token=`，
   首次导航后由 HttpOnly cookie（`dshfwd`）接管，HTTP 与 WS 升级同样校验，
   无令牌请求一律 401。这把「谁能用这个 DSH」关回 dsh-admin 的登录/授权门后。

> ⚠️ 版本耦合提醒：第 3 点的正则针对当前 DSH 版本的调用形态；DSH 升级后若改写
> 失效，症状会回归（配置模型报 loopback 错误），需同步更新
> `src/supervisor/forwarder.ts` 的 `LOOPBACK_GATE_RE`。

## ⚠️ 安全须知（务必阅读）

子 DSH 端口在内网可达，但**不会绕过编排服务的登录认证**：forwarder 对每个
实例做令牌门禁（见上第 4 点），无令牌的直连请求一律 401。令牌只通过已认证的
API（launch/restart/status 返回的 url）交付给属主，且随实例重启轮换 —— 局域网
内扫描 `40000+` 端口拿不到有效令牌，无法使用他人的 DSH。

另：soft 隔离模式下容器内所有用户的子 DSH 以同一 uid（root）运行。要更强的隔离，
可用 `account` 模式（容器需 root + `setpriv`，配 `DSH_ADMIN_BASE_UID`）。

## 部署步骤

```sh
# 1. 改 docker-compose.yml：
#    - DSH_ADMIN_PUBLIC_HOST = 服务器内网 IP（建议静态 IP 或 DHCP 保留）
#    - 端口范围按最大同时在线用户数调整（每用户 1 端口），compose 的
#      ports 映射范围必须与 PORT_MIN/MAX 一致

# 2. 构建并启动
docker compose up -d --build

# 3. 创建管理员（首次）
docker compose exec dsh-admin node lib/cli.js bootstrap-admin \
  --username admin --password <密码>

# 4. 浏览器访问 http://<内网IP>:3080 注册/审核/登录
```

## 数据持久化

bind mount `./dsh-data`（容器内 `/var/lib/dsh-admin`）存放 SQLite 数据库、
每用户 home/workspace 与插件市场收录目录（`market/`）。**备份它**。
`./dsh-cli`（容器内 `/opt/dsh`）是 dsh CLI 的运行时安装位置（见下方升级）。

容器健康检查探测 `GET /healthz`（含实例计数与 uptime 的最小探活端点）；
实例是否真正可用以 `docker ps` 的 health 状态为准。

## 升级 / 日常运维

```sh
docker compose up -d --build          # 升级镜像（数据在 bind mount 中不受影响）
docker compose logs -f                # 日志（含子 DSH stdout/stderr）
docker compose restart                # 注意：重启会停掉所有运行中的子 DSH
```

### 只更新 dsh CLI（不重建镜像）

镜像内置一份基线 dsh（`/opt/dsh-image`），首次启动时播种到 `./dsh-cli`。之后
更新 dsh 无需重建 / 重传镜像：

1. 有网机器上打包（linux 平台依赖；持久缓存卷 `dsh-npm-cache` 让重复构建
   只剩 tar 压缩耗时）：
   ```powershell
   powershell -File scripts\pack-dsh.ps1 -Version <npm 版本号|latest>
   ```
2. 把 `dsh-cli.tgz` 传到服务器上 docker-compose.yml 同级目录，执行：
   ```sh
   rm -rf dsh-cli/node_modules && tar -xzf dsh-cli.tgz -C dsh-cli
   docker compose restart
   ```
3. 清空 `dsh-cli/` 再重启即可回退到镜像内置基线版本。

注意：**不能**直接拷贝 Windows 全局安装的 dsh 包 —— 原生依赖（sharp /
node-pty / node-addon-require-builtin）是平台相关的，Windows 装的是 win32
二进制，容器内加载即失败。

## 端口规划核对清单

- `3080`：编排服务（登录/桌面/管理台）
- `40000-40100`：子 DSH（示例范围；每端口=一个用户的 DSH 实例）
- 防火墙放行上述范围；范围应 ≥ 预期最大同时在线用户数
