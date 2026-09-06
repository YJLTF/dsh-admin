# AGENTS.md — 面向编码代理的项目指南

本文件供 AI 编码代理（及新加入的贡献者）快速建立对 dsh-admin 的准确心智模型。改动前请通读，提交前遵守「验证」一节。

## 项目是什么

面向局域网（Docker 部署）的**多租户 DSH 托管平台**：管理员审核注册用户，每个用户获得相互隔离的 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 环境。单进程 Fastify + SQLite 编排服务负责认证、文件桌面与按用户拉起/监管 DSH 子进程。

- 上游与规范：插件形态遵循 [STANDARD.md](STANDARD.md)；完整设计见 [docs/blueprint.md](docs/blueprint.md)。
- 部署形态是**内网离线**：插件市场只收 tgz 归档，不 clone、不跑 npm install。

## 目录地图

```
src/
  cli.ts                  # 入口：服务器 / bootstrap-admin / uid-for-user
  config.ts               # 全部可调参数（env + overrides → ServerConfig）
  isolation.ts            # account 模式的确定性 uid 派生
  db/
    connection.ts         # 打开 SQLite（WAL + 外键）
    schema.ts             # 版本化迁移（V1..V8，只增不改历史）
    prepared.ts           # 预处理语句缓存（热路径必经）
    repo.ts               # 全部 SQL 数据访问（显式传 db，参数化）
  fs/
    workspace.ts          # 每用户目录布局的唯一事实来源
    market.ts             # 插件市场域逻辑（tgz 解包/判型/安装/卸载）
    shared-settings.ts    # 共享配置合并进用户 settings.yaml/.credentials.yaml
    mime.ts  storage.ts  plugins.ts
  supervisor/
    orchestrator.ts       # 每用户主 DSH + 按需看门狗的生命周期（内存态）
    forwarder.ts          # 内网模式反向代理（令牌门 / Origin 剥除 / 垫片注入）
    spawn.ts  patch.ts  firewall.ts
  web/
    server.ts             # Fastify 组装（限流 → multipart → 路由 → 静态）
    auth.ts               # scrypt 密码哈希、会话令牌、cookie
    middleware/           # requireAuth/requireAdmin、路径守卫、限流
    routes/               # auth / admin / fs / dsh / plugins / shared-config / ops / market
web/                      # 无构建步骤的静态前端（vanilla JS）
  common.js               # DshCommon：esc / fmtSize / fmtDateTime / KIND_LABEL
  window-manager.js       # 桌面窗口拖拽/缩放/任务栏
  file-explorer.js        # 文件资源管理器 + 桌面网格（initFileExplorer({api,esc})）
  admin-extras.js  account.js  market.js  shared-config-editor.js
  desktop.html  login.html  register.html  index.html  design.css
scripts/pack-dsh.ps1      # dsh CLI 离线打包（内网更新工作流）
docs/                     # 部署 / 隔离 / 市场 / 共享配置 / 排障文档
```

## 常用命令

```sh
npm run typecheck   # tsc --noEmit（改动 TS 后必跑）
npm run build       # tsc → lib/（lib/ 与 node_modules/ 均被 gitignore）
npm run dev         # node lib/cli.js 本地起服务（默认 127.0.0.1:3080）
```

联调流程：`node lib/cli.js bootstrap-admin --username admin --password '<强密码>' --db ./dev.local.db` → `npm run dev` → 注册/审核/桌面全流程在 UI 里验证。测试数据目录与 db 不要提交（已被 gitignore）。

## 硬性约定（违反即 review 打回）

1. **路径安全**：任何面向用户文件的处理器先过 `resolveUserPath()`（`src/web/middleware/fs-guard.ts`），绝不手拼 `users/<id>/…` 或信任客户端绝对路径；目录布局只从 `src/fs/workspace.ts` 取。
2. **文件 IO**：请求路径一律 `node:fs/promises`；同步 API 只允许出现在启动/CLI 冷路径。写文件用「临时文件 + 原子 rename」模式（上传、fs/write、shared-settings 均如此）。
3. **SQL**：全部经 `repo.ts` + `prepared.ts`，参数化，显式传 `db`；不把 SQL 写进路由。
4. **迁移**：改表结构 = 在 `schema.ts` 新增 `V<N>_SCHEMA` 并登记 `MIGRATIONS`；历史迁移文本永远不改。
5. **前端转义**：插入用户可控文本必须过 `esc()`（`web/common.js` 的 `DshCommon.esc`）；新增桌面模块沿用现有注入模式（`initXxx({ api, esc, ... })`），不要直接引全局单例以外的隐式依赖。
6. **配置**：新可调项进 `config.ts`（env + override + 校验），不硬编码散落。
7. **审计**：管理员/用户敏感动作（审核、改密、删用户、市场导入/安装等）都要 `audit()` 落账。

## 容易踩的坑

- 子 DSH 一律绑环回；对外发布走 `publicHost` + per-instance forwarder（`forwarder.ts`），别把子端口直接暴露。DSH ≥0.1.2-alpha.5 的 web 首页有 launchToken 门，转发器负责交接——改 forwarder 时先读其文件头注释。
- `dsh web` 打印的 launchToken 从 stdout 异步捕获；`/api/dsh/status` 的 `url` 为空 = 尚未就绪，前端会快轮询，不要改成阻塞等待。
- 崩溃自动重启有指数退避 + 熔断（`maxAutoRestarts`）；实例状态刻意只存内存（`orchestrator.ts`），不要往库里写。
- better-sqlite3 是同步的：认证热路径已用单次 JOIN + 语句缓存 + `last_used_at` 60s 节流回写，别引入每请求多次 prepare 的写法。
- 前端无打包器：保持 vanilla JS + IIFE 模块 + `web/` 静态直出；新增共享工具放 `web/common.js`。
- Docker 里 `dsh` CLI 挂载在 `/opt/dsh`（热更新替换），Windows 开发用 `DSH_ADMIN_DSH_BIN='node "<路径>/bin.js"'`（见 docs/troubleshooting.md）。

## 验证清单（提交前）

- [ ] `npm run typecheck` 通过。
- [ ] 改了 schema：新库 + 旧库各启动一次，迁移无报错。
- [ ] 改了路由/前端：桌面 UI 走一遍受影响流程（登录 → 桌面 → 对应窗口）。
- [ ] 新增用户可控输出已 `esc()`；新路由有 `requireAuth`/`requireAdmin` + 必要时 schema 校验。
