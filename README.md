# dsh-admin

面向局域网（Docker 部署）的多租户 DSH 托管平台 —— 部署到一台内网服务器后，多个用户注册并经管理员审核，各自获得一套**相互隔离**的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）环境，通过 `http://<内网IP>:<端口>` 访问。

> 以 [DSH 插件市场](https://github.com/bradeGithub/DSH-Plugins-Marketplace) 的 cordis-plugin 形态分发，遵守 [STANDARD.md](STANDARD.md)。

## 它解决什么

DSH 本身是单用户本地工具，没有认证、没有多租户隔离、Web 远程访问缺认证层。`dsh-admin` 在其之上补一层**服务端登录 + 多租户编排**：管理员审核注册用户，每个用户落到自己的文件桌面，按文件夹启动 DSH、选择启用哪些插件，在局域网内访问，且彼此文件隔离（已适配手机端）。

## 核心能力

- **登录与审核**：管理员先行（`bootstrap-admin`），用户注册后需管理员审核通过；独立管理台 UI。
- **每用户隔离的 DSH 环境**：主 DSH 负责正常工作；崩溃时**按需拉起一次守护 DSH** 修复并自动重启；装插件重启时守护执行主 DSH 给出的 post-restart 命令。
- **登录桌面**：文件资源管理器（文件/文件夹上传含目录结构、新建、重命名、移动、删除、预览[文本/图片/音视频/PDF]、下载）；按文件夹启动 DSH；每文件夹独立勾选启用的插件（自动检测该用户 profile 中已安装的插件，持久化并注入 cordis patch）。
- **内网直连访问**：`DSH_ADMIN_PUBLIC_HOST=<内网IP>` + 固定子 DSH 端口段，Docker 直接发布端口；每实例内置 forwarder（剥 Origin / 注入 `randomUUID` polyfill / 改写 loopback 门 / per-instance 访问令牌门禁）保证非安全上下文可用且不绕过登录。
- **共享模型配置**：管理员统一维护提供方与凭据，用户在桌面一键接收，叶子级合并进自己的 `settings.yaml` / `.credentials.yaml`。
- **硬隔离**（Linux）：每用户独立 OS 账号（`setuid` 降权），`0700` 目录真正隔离跨用户读。

## 架构总览

```
用户浏览器 → http://<内网IP>:3080 → 编排服务(Fastify + SQLite，单进程)
                                      ├─ 认证 / 审核 / 桌面 / 共享配置 API
                                      └─ http://<内网IP>:<子端口> → forwarder → 子 DSH(127.0.0.1)
每用户子 DSH（主 + 按需守护）只绑回环端口，由 per-instance forwarder 发布到容器 eth0。
```

编排服务以 `child_process` 按用户 spawn DSH 子进程，端口随机分配、崩溃自动重启。完整设计见 [docs/blueprint.md](docs/blueprint.md)。

## 快速开始

```sh
npm install
npm run build                                        # tsc → lib/
node lib/cli.js bootstrap-admin --username admin --password '<强密码>' --db ./dev.local.db
node lib/cli.js --port 3080 --db ./dev.local.db
```

访问 `http://127.0.0.1:3080/`：登录 / 注册 / 管理台 / 桌面（Docker 内网部署流程见 [docs/deployment-docker.md](docs/deployment-docker.md)）。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DSH_ADMIN_PORT` | `3080` | 编排服务绑定端口 |
| `DSH_ADMIN_DATA_ROOT` | `~/.dsh-admin` | 每用户 home/workspace 根（生产 `/var/lib/dsh-admin`） |
| `DSH_ADMIN_DSH_BIN` | `dsh` | 子 DSH 启动命令；支持带双引号的命令串（Windows 用 `node "<dsh 路径>"`，见 troubleshooting） |
| `DSH_ADMIN_ISOLATION_MODE` | `soft` | `soft` 软隔离 / `account` 账号级硬隔离（Linux，需 root） |
| `DSH_ADMIN_BASE_UID` | `100000` | 账号级隔离的 uid 基数 |
| `DSH_ADMIN_PUBLIC_HOST` | 空 | 内网 IP；设置后 DSH 链接生成为 `http://<内网IP>:<子端口>/?dsh_token=<实例令牌>` |
| `DSH_ADMIN_DSH_PORT_MIN/MAX` | `0` | 子 DSH 端口段（Docker 端口映射范围需一致） |
| `DSH_ADMIN_PORT_GUARD` | `false` | 回环端口守卫（iptables OUTPUT owner-match，Linux + root，防跨用户直连子 DSH） |
| `DSH_ADMIN_TRUST_PROXY` | `false` | 仅当部署在自控反向代理后设 `true`（否则 `X-Forwarded-For` 可伪造 rate-limit 键）；也可传代理 CIDR 列表 |
| `DSH_ADMIN_MAX_FILE` | `1073741824` | 单个上传文件上限（字节，默认 1 GiB）；上传走 multipart 流式，不受 JSON body 限制 |
| `DSH_ADMIN_PREVIEW_MAX` | `262144` | 文本预览最多读取的字节数（超出截断并提示） |

其余可调项（`dshCommand`、`spawnAsUserCommand`、`restartBackoffMs`、`sessionTtlSeconds`、`maxUploadBytes` 等）见 `src/config.ts` 与各文档。

## 文档

- [docs/blueprint.md](docs/blueprint.md) — 技术设计（拓扑 / 数据模型 / API / 双 DSH）
- [docs/deployment-docker.md](docs/deployment-docker.md) — Docker 内网部署（端口规划 / 数据卷 / 运维）
- [docs/shared-config.md](docs/shared-config.md) — 共享模型配置（提供方 / 凭据引用 / 模型输入模态）
- [docs/hard-isolation.md](docs/hard-isolation.md) — 账号级硬隔离教程
- [docs/troubleshooting.md](docs/troubleshooting.md) — 常见问题排查（502 / 404 / 403 / 端口冲突 / Windows 启动）

## 开发与测试

```sh
npm run build          # tsc → lib/
npm run typecheck      # 仅类型检查
npm run smoke          # 端到端冒烟（fake-dsh 模拟子 DSH）
npm run smoke:dsh-crash        # 崩溃残留清理 + 自动重启
npm run smoke:shared-config    # 共享配置合并 / 删除同步 / 凭据不下发
# 其余：smoke:auth / smoke:admin / smoke:fs / smoke:plugins / smoke:watchdog / smoke:isolation
```

### 代码约定

- **请求路径文件 IO 一律用 `node:fs/promises`**（`statSync`/`mkdirSync`/`writeFileSync` 只允许出现在启动/CLI 冷路径）；SQLite 沿用 better-sqlite3 的同步模式。
- 每用户目录布局统一从 `src/fs/workspace.ts` 取（`workspaceRoot` / `userHomeDir` / `ensureUserDir`），不要手拼 `users/<id>/…` 路径。
- 路由 prologue 统一用 `resolveUserPath()`（`src/web/middleware/fs-guard.ts`）：workspace 根 + 越界防护一步完成。
- 冒烟脚本的 `assert` / `json` / `sleep` / `cleanup` 从 `scripts/helpers.mjs` 导入，勿再复制。
- 前端桌面页的窗口拖拽/缩放/任务栏逻辑在 `web/window-manager.js`，文件资源管理器（表格/对话框/上传/预览）在 `web/file-explorer.js`；插入用户可控文本必须过 `esc()` 转义。

## 安全

默认**软隔离**（每用户 `$DSH_HOME` + session `cwd` + 沙箱写隔离）。Linux 部署建议开启**账号级硬隔离**（每用户 OS 账号，闭合同 UID 越权读）。详见 [docs/hard-isolation.md](docs/hard-isolation.md)。

## 二次开发声明

本项目（dsh-admin）基于以下项目二次开发而来，面向 **Docker + 局域网** 部署场景重构与增强，感谢上游项目的开源贡献：

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — DSH 本体（单用户本地工具）
- [pointer-a/dsh-server-login](https://github.com/pointer-a/dsh-server-login) — 服务端登录 + 多租户编排层

## 许可证

[MIT](LICENSE)
