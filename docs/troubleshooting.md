# 常见问题排查 — DSH 服务端登录插件

按「现象 → 根因 → 修法」组织，都是实际部署中踩过的坑。

## 502：启动 DSH 后打不开

- **现象**：桌面显示「运行中」，但打开 DSH 链接连不上 / 超时。
- **根因**：子 DSH 没在编排服务分配的回环端口上监听——要么还在冷启动，要么 spawn 即崩；或 forwarder 没起来（编排服务 stderr 里找 `[dsh-forwarder]`）。
- **排查**：
  ```sh
  ps aux | grep dsh            # 有没有子进程
  ss -tulpn | grep <端口>      # 有没有监听
  ```
- **冷启动**：真实 DSH 冷启动 ~4s（源码启动）。状态在子进程端口真正接受连接后才转「running」（此前为「starting」，UI 显示"启动中…"），前端会 1s 轮询直到就绪。若长时间停在「starting」，再查 `ss` / 子进程 stderr。
- **spawn 即崩**：看编排服务终端的子进程 stderr（stderr 会被 pipe 过去）。

## 启动 DSH 报 `spawn dsh ENOENT`

- **现象**：`/api/dsh/status` 显示 `status: "crashed"`、`lastError: "spawn dsh ENOENT"`；`ps` 里没有任何 dsh 子进程。
- **根因（Linux）**：systemd 的 PATH 精简，`dsh`（只装在 nvm 下）解析不到。`dsh` 脚本内部也是 `#!/usr/bin/env node`，同样需要 nvm 在 PATH。
- **修法（Linux）**：
  1. env 里 `DSH_ADMIN_DSH_BIN=/root/.nvm/versions/node/v22.23.2/bin/dsh`（绝对路径，版本按 `ls ~/.nvm/versions/node/` 改）。
  2. systemd 单元加 `Environment=PATH=/root/.nvm/versions/node/v22.23.2/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`。
  3. `systemctl daemon-reload && systemctl restart dsh-admin`，再先 stop 再 launch。

## Windows 上启动 DSH 报错（.cmd shim 无法 spawn）

- **现象**：Windows 开发机上启动 DSH，`lastError` 报 `spawn dsh ENOENT` 或 `spawn ... UNKNOWN`。
- **根因**：npm 在 Windows 装的全局命令是 `.cmd`/`.ps1` shim，Node 的 `spawn()` 不能直接执行它们。
- **修法**：`DSH_ADMIN_DSH_BIN` 支持带双引号的**命令串**（自动切分 argv），用 node 直接拉 dsh 的 js 入口：
  ```powershell
  $env:DSH_ADMIN_DSH_BIN = 'node "C:\Users\<你>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\bin\dsh.js"'
  ```
  （`parseCommandString` 见 `src/config.ts`；含空格的路径必须加双引号。）

## 崩溃后的行为（自动重启 / 残留清理）

- 子 DSH 崩溃后状态变 `crashed`（`lastError` 带退出码与 stderr 尾部），编排服务按 `restartBackoffMs`（默认 1s）自动重拉；崩溃重启会换一个新端口（forwarder 随之重建）。
- `starting`/`running` 之外的条目只是崩溃循环残留，**再点「启动」即可**——launch 会先清掉残留与挂起的重启定时器，不会报「已有运行中的 DSH」。

## 编排服务起不来：better-sqlite3 报 ERR_DLOPEN_FAILED / ABI 版本不匹配

- **现象**：`journalctl -u dsh-admin` 里 `ERR_DLOPEN_FAILED`、`was compiled against ... NODE_MODULE_VERSION ... This version requires ...`；systemd 反复重启失败。
- **根因**：`npm install` 用 nvm Node 编译了 `better-sqlite3` 原生模块，但 systemd 的 `ExecStart=/usr/bin/env node` 解析到**另一个 Node 版本**，ABI 对不上。
- **修法**：`ExecStart` 用 nvm node 绝对路径（如 `/root/.nvm/versions/node/v22.23.2/bin/node lib/cli.js`），并 `npm rebuild better-sqlite3` 用同一个 node。

## 端口冲突：子 DSH 和编排服务抢 3080

- **现象**：手动跑 `dsh web` 报 `EADDRINUSE 0.0.0.0:3080`。
- **根因**：编排服务默认绑 3080，子 DSH（harness）默认也绑 3080。
- **关键机制**（读 harness 源码确认）：harness 的 web 服务端口读 **`--port` 这个 CLI flag**（`web-startup` 插件解析 → `webStartup` 服务 → webserver），**不是** env、**不是** patch。`--cwd` 也不是合法 flag。
- **修法**：spawn 子 DSH 用 `dsh --profile web --host 127.0.0.1 --port <随机端口>`（已内置）。

## 打开 DSH 显示 "dsh web authentication required; reopen the URL printed by dsh web."

- **现象**：桌面点「打开 DSH」，页面显示这条英文 401 文本（dsh CLI ≥0.1.2-alpha.5）。
- **根因**：新版 dsh 的 web 首页自带浏览器认证门（`dsh-client-connection` 的 `authorizeIndex`）——只有携带该进程 launchToken（`dsh web` 启动时打印在 stdout 的 URL 里 `?token=…`）的首导航能换来 DSH 的会话 cookie，否则一律 401。
- **现状**：已内置适配——
  - **内网模式**：编排服务从子进程 stdout 捕获 launchToken，forwarder 把携带 `?dsh_token=` 的首导航改写为携带它，DSH 直接向浏览器种下会话 cookie（303 到干净 `/`）。令牌打印前点开会看到自动重试页（"DSH 正在启动"），就绪后自动进入。
  - **回环 dev 模式**：status 返回的 url 等令牌捕获后自动带上 `?token=`，桌面「打开 DSH」按钮就绪后才出现。
  - **老版 dsh（无此门）**：forwarder/状态层探测首页非 401 时原样直连，行为不变。
- **手动应急**：在编排服务日志里找该实例打印的 `dsh web: http://127.0.0.1:<端口>/?token=<令牌>`，把它接到内网链接上开一次：`http://<内网IP>:<端口>/?dsh_token=<实例令牌>&token=<令牌>`。每次重启令牌都会换。

## 404：打开 DSH 后静态资源全 404

- **现象**：HTML 能加载，但 `/assets/*`、`/favicon.svg`、`/manifest.webmanifest` 全 404。
- **根因**：DSH 的 SPA（Vite）资源用**绝对路径**（`/assets/*`、`/api/*`），假设自己挂在域名根 `/`。历史上曾用子路径 `/u/<id>/dsh/*` 反代，绝对路径会打到编排服务自己的路由 → 404。**子路径方案与这个 SPA 从根上不兼容，已移除**。
- **现状**：内网模式直连子 DSH 自己的端口（`http://<内网IP>:<端口>/`），或本地 dev 直连 `http://127.0.0.1:<port>/`，SPA 挂在自己端口根，绝对路径天然成立。

## 403：DSH 功能请求报 transport failure / HTTP 403（如 /api/settings.describe）

- **现象**：DSH 页面能加载，但功能 API（`/api/settings.describe`、`/api/host.describe` 等）返回 403，前端报 "transport failure for /api/xxx: HTTP 403"。
- **根因**：harness 的 `/api` 浏览器信任栅栏（`api-request-trust.ts`）检查 Origin——`origin.host` 必须等于 `host.host`。内网页面 origin 是 `http://<内网IP>:3080` 而子 DSH 监听回环 → 不匹配 → 403。
- **修法**：代理到 DSH 时剥掉 `origin` / `referer` / `sec-fetch-*` / `x-forwarded-*`，只保留 loopback `host`（已内置在 [forwarder.ts](../src/supervisor/forwarder.ts) 的 `STRIP_HEADERS`）。

## 设置页「加载提供方目录失败: settings are unavailable in this browser」

- **现象**：DSH 能打开，但设置 → 模型（或通用设置）报这条错误。
- **根因**：DSH 把设置 RPC 限制在"页面源为环回"的浏览器里（连接脚本里的 `isLoopbackHostname(pageLocation.hostname)` 门）。经内网 IP 访问时页面源不是环回，门判 false → 设置文档存储不创建 → 提供方目录拿不到。
- **修法**：forwarder 把连接脚本里的这个门改写为 `true`（转发器本身就是环回路径，网络不变量成立）。dsh ≥0.1.2-alpha.5 起该脚本改经 `/plugins/??<id>/client.js,…` 组合端点整批加载，改写已同时覆盖单文件与组合路径。
- **注意**：脚本 URL 带 `rev` 缓存参数，浏览器可能缓存旧的未改写副本——部署新版后强刷一次（Ctrl+Shift+R）即可。

## 编排服务日志在哪

- 有 systemd 单元：`journalctl -u dsh-admin -f`。
- 手动跑（`node lib/cli.js`）：日志（含子 DSH 的 stdout/stderr，已被 pipe）在那个终端里。

## SEO 警告：`<html lang>` / `<title>` / `viewport` 缺失

- **现象**：Lighthouse 报这三条。
- **根因**：来自 **DSH 自己的聊天界面 SPA**（harness 前端），不是本插件页面（本插件的 login/desktop/admin 都写了这些）。
- **处理**：无害、不影响功能。要修需改 harness 前端或由 runtime 插件 `tapIndex` 注入，暂缓。
