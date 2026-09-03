# 技术蓝图 — DSH 服务端登录插件

多租户托管平台，让用户在局域网内（Docker 部署 + 内网 IP 直连）安全访问自己的 DeepSeek Harness（DSH）实例。本文是权威技术设计；实现与本文冲突时以本文为准，并同步回改。

## 1. 运行拓扑

```
用户浏览器
   ├─(HTTP)─> http://<内网IP>:3080        → 编排服务 Fastify（认证/管理/桌面/共享配置，/api/*）
   └─(HTTP)─> http://<内网IP>:<子端口>    → per-instance forwarder → 该用户 DSH 的 127.0.0.1 回环端口
```

- **编排服务端口**：编排服务自己的登录 / 管理台 / 桌面 / API。
- **每用户子端口**：DSH CLI 拒绝绑定 `0.0.0.0`，子 DSH 只绑回环端口；编排服务为每个运行中的实例在容器 eth0 上起一个内置 HTTP/WS forwarder（剥 Origin、注入 `crypto.randomUUID` polyfill、改写 loopback 门、交接 dsh ≥0.1.2-alpha.5 web 首页的 launchToken 认证门——见 [deployment-docker.md](deployment-docker.md)），端口固定在 `DSH_PORT_MIN/MAX` 段内供 Docker 映射。
- 编排服务是独立 Node 进程，`child_process.spawn('dsh --profile web --host 127.0.0.1 --port <段内端口>', ...)` 拉起每用户 DSH（主 + 按需守护）。

## 2. 打包与启动

- **主入口**：独立 `dsh-admin` bin（`node lib/cli.js`）直接跑 Fastify + SQLite + 进程编排。
- **市场识别**：根 `package.json` 的 `dsh` 字段（`plugin`/`kind`/`bundle.patch`）+ `cordis.patch.yml`；不 import 任何 `@deepseek-ai/*` 宿主包，peerDependencies 为空，规避宿主包遮蔽。
- **cordis 入口 `apply()` 是带守卫空操作**：默认无副作用，装进任意 profile 都不起服务器。
- **源码型分发**：仓库不含 `lib/` 构建产物（.gitignore 排除）；`prepare` = `npm run build`，git 安装时自构建（市场侧按源码型弹构建确认，见 [STANDARD.md](../STANDARD.md) §2.2）。

## 3. spawn 每用户 DSH

```ts
// 主实例（端口取自 DSH_PORT_MIN/MAX 段；--patch 仅在 enablePatch 时传入）：
spawn(dshCommand, ['--profile', 'web', '--host', '127.0.0.1', '--port', String(port), ...patchArgs], {
  cwd: workspacePath,
  env: { ...scrubEnv(process.env), HOME: workspacePath, DSH_HOME: homeDir },
  stdio: ['ignore', 'pipe', 'pipe'],
})
// 看门狗：一次性 headless 实例，任务以位置参数传入。
spawn(dshCommand, ['--profile', 'headless', WATCHDOG_TASK], { /* 同上 */ })
```

- env 擦除镜像 harness 的 `scrubbedParentEnv`/`SENSITIVE_ENV_PATTERN` 思路：从允许列表重建子进程环境，再注入解析好的每用户取值（`HOME` 指向工作区、`DSH_HOME` 指向状态目录）。
- 进程树 teardown 自行实现：SIGTERM → 5s 宽限 → SIGKILL（Windows 下信号均映射为进程终止）。
- **dsh CLI 版本探测**：`Supervisor.dshVersion()` 运行 `<dshCommand> --version` 取首个非空行（stdout/stderr 合并，退出码不敏感；4s 超时；失败为 null，不影响状态接口）。dsh 二进制支持免重建热更新（bind mount 替换），因此结果按 60s TTL 缓存 + 并发去重，而非进程启动时探测一次；`/api/dsh/status` 与 `/api/admin/instances` 均携带 `dshVersion` 字段供前端展示。

## 4. 双 DSH「共享对话 + 崩溃接管」

**共享状态 = 每用户 `$DSH_HOME` 里的持久会话日志**（append-only；`session-persistence` 落盘）。

- **主 DSH** 独占实时会话并持续 append；绑定回环端口对外服务。
- **守护 DSH** 是**按需拉起的一次性 headless DSH**（不常驻）：主 DSH 崩溃时、或需执行 post-restart 命令时，编排服务才 spawn 一次；它与主 DSH 同 home/同 workspace，通过 `loadStoredFrom(id, fromSeq)` 读同一日志，修复/resume 后退出。

**崩溃接管闭环**（主 DSH 崩溃时，编排服务拉起一次守护 DSH 并自动重启主 DSH）：

> 当前进度：编排层闭环（拉起守护 + 自动重启主实例 + 交接命令执行）已完成；下面 1–2 步的
> 会话日志修复依赖 harness 内部机制（`interruptedTurnClosers` / `session-persistence`），
> 随与真实 harness 集成接入。

1. **诊断**：读退出码 + stderr 尾部 + 会话日志尾部，判定崩溃点。
2. **修复会话日志**：`interruptedTurnClosers`（`packages/core/session/src/repair.ts`）+ `session-persistence.load`/`commitRepair` 把中断 turn 合成 `tool/result`/`step/end`/`turn/end{interrupted}`，产出可恢复的合法转录。
3. **修复根因**：守护 DSH 以 agent 身份（对共享 workspace 有工具权限）修文件/配置、摘坏插件、杀卡死子进程。
4. **接手会话**：`ctx.sessionPersistence.prepare`/`load`（或 `ctx.sessions.create({seed})`）恢复修复后的日志，接续对话成为新主 DSH；随后可选重拉 fresh 主 DSH 并退回守护位。

**计划内重启（装插件）**：主 DSH 退出前把「post-restart 自动命令」写成 JSON 落到 `users/<id>/handoff.json`（刻意放在 `$DSH_HOME` 之外——修复流程可能清空 home），守护 DSH 在重启后读取并执行。

**关键澄清**：「接手」= 顺序 failover（恢复同一持久日志续接对话），非两个活体同时驱动同一 turn——这是 harness 的 resume 语义，无需自建双向活体通道。

## 5. 数据模型（SQLite，migration v1）

- v1 使用：`users`、`sessions`、`workspaces`、`folder_plugins`、`audit_log`。v3 增：`shared_config` / `shared_config_state`（共享模型配置）。v4 删：`credential_vault`（每用户密钥库）。v5 删：`domains`（域名/nginx 部署已移除）。v6 删：`dsh_instances` 幽灵表与 `users.api_key_ref` 残留列（实例状态按设计仅存内存）。v7 增：`sessions.last_used_at`（设备管理）、`app_settings`（注册开关/邀请码）、`market_items` / `user_plugins`（离线插件市场），删 `folder_plugins.description` 死列。

字段与约束见 `src/db/schema.ts`。

## 6. API 面

| 组 | 路由 | 脚手架状态 |
|---|---|---|
| Auth | `POST /api/auth/register\|login\|logout`、`GET /api/auth/me`、`GET /api/meta`（注册门禁状态）、`POST /api/me/password`、`GET /api/me/sessions`、`DELETE /api/me/sessions/:id` | 已实现（P1/P8） |
| Admin | `GET /api/admin/users`、`POST /api/admin/users/:id/approve\|disable\|enable\|reset-password\|delete`、`GET/PUT /api/admin/settings`、`GET /api/admin/audit` | 已实现（P1/P8） |
| Ops | `GET /healthz`、`GET /api/admin/instances`（含 dsh CLI 版本行）、`POST /api/admin/instances/:userId/stop`、`GET /api/admin/storage` | 已实现（P8） |
| Desktop/FS | `GET /api/desktop/tree`、`POST /api/fs/mkdir\|create\|upload(multipart)\|delete\|rename\|move\|write`、`GET /api/fs/read`（文本预览）、`GET /api/fs/raw`（下载/内联流，支持 Range）、`GET /api/fs/zip`（目录打包）、`GET /api/fs/search`（全工作区搜索） | 已实现（P2/P8；上传为 multipart 流式，文件夹上传保留相对路径） |
| DSH | `POST /api/dsh/launch\|stop\|restart`、`GET /api/dsh/status`（含连续重启计数/熔断态 + dsh CLI 版本行） | 已实现（P3/P5/P8，内网直连 + forwarder；main+watchdog 编排层） |
| Plugin | `GET /api/plugins`、`POST /api/plugins/select` | 已实现（P4） |
| Market | `GET/POST/DELETE /api/admin/market*`、`GET /api/me/market`、`POST /api/me/market/:id/install`、`POST /api/me/market/uninstall` | 已实现（P8，见 [plugins-market.md](plugins-market.md)） |
| SharedConfig | `GET/PUT /api/admin/shared-config`、`GET /api/me/shared-config`、`POST /api/me/shared-config/accept` | 已实现（[shared-config.md](shared-config.md)） |
| 静态 | `GET /*`（`web/` 下的桌面 SPA：`desktop.html` + `window-manager.js` + `file-explorer.js` + `shared-config-editor.js` + `account.js` + `market.js` + `admin-extras.js`） | 已接 |

## 7. 安全模型

默认软隔离（每用户 `$DSH_HOME` + session `cwd` + 沙箱写隔离）；Linux 部署建议开启账号级硬隔离（每用户 OS 账号）。详见 [hard-isolation.md](hard-isolation.md)。

## 8. 分阶段路线

P1–P7 已完成：登录审核、桌面/FS、单 DSH 启动、每文件夹插件、守护/双 DSH、硬隔离、共享模型配置（域名/nginx 与每用户密钥库已随内网-only 瘦身移除）。

**P8（v0.2.0）已完成**：账号与会话安全（自助改密/设备管理/审计日志/删用户/注册门禁）、运维面板（全局实例视图与单停、磁盘统计、`/healthz`、崩溃熔断 + 指数退避）、文件管理器增强（在线文本编辑、目录 zip 下载、排序与全工作区搜索）、插件/技能离线市场（管理员 tgz 收录 → 用户安装/更新/卸载，见 [plugins-market.md](plugins-market.md)）。
