# 插件/技能离线市场 — 管理员收录，用户一键安装

dsh-admin 部署在内网，容器不能访问 GitHub/npm，因此市场采用**离线镜像**模式：
管理员在有网机器上下载插件仓库归档（.tar.gz），上传到 dsh-admin 收录；用户在
桌面「管理插件 → 插件市场」一键安装/更新/卸载，服务端把内容装进该用户自己的
DSH home。类型判定与安装管线遵循 [STANDARD.md](../STANDARD.md)（DSH 插件市场
收录规范）的对应子集。

## 支持的类型与落盘位置

| 类型 | 判定特征（按此顺序） | 安装位置（每用户） |
|---|---|---|
| cordis-plugin | `package.json` 声明 `dsh` 字段或 `@deepseek-ai/*` 依赖 | `home/profiles/web/node_modules/<包名>` + 注册 `home/profiles/web/cordis.patch.yml` |
| agent-preset | 根目录同时有 `preset.yml` + `agent.cordis.yml` | `home/.agent-presets/<名称>/` |
| skill | 根目录 `SKILL.md`（大小写不敏感；frontmatter `name:` 优先作为名称） | `home/skills/<名称>/` |
| script | 根目录 `install.ps1` / `install.sh` | **不支持**（本平台不执行第三方脚本，导入时 422 拒绝） |

无上述任何特征的仓库（纯 README）同样被拒绝（`no_market_signature`）。

## 管理员流程

1. 有网机器上获取归档，任选其一：
   - GitHub 仓库页 → **Code → Download ZIP** 不行（只支持 tar.gz）；
   - 直接下载 codeload 归档：
     `https://codeload.github.com/<owner>/<repo>/tar.gz/refs/heads/main`
     （分支/tag/commit sha 均可）；
   - Release 页的 "Source code (tar.gz)"。
2. 桌面 → 「插件市场」→ 选择 .tar.gz → 导入。服务端解包（排除 `.git/`、
   防 tar-slip 路径穿越、2 GiB 膨胀上限）、判定类型、抽取元数据并做静态检查。
3. 同 kind+name+version 重复导入 = 覆盖更新；新版本（version 不同）作为新条目，
   已装用户会在市场页看到「更新」按钮。

静态检查产生的**警告**（不阻断安装，卡片上如实展示）：

- 宿主接口包（`@deepseek-ai/*`、`dsh-llm` 等）被声明为普通 `dependencies`
  （STANDARD §6.6：旧副本遮蔽宿主会打挂工具调用）；
- 含任何运行时 `dependencies`：**离线安装不执行 `npm install`**，请确认包内
  自带构建产物（产物型）且依赖均为 peer；
- `main` 入口不在包内（疑似源码型，市场安装不执行构建）。

## 用户流程

桌面 → 「管理插件」→ 「插件市场」Tab：浏览收录条目（类型/版本/描述/警告），
安装 / 更新 / 卸载。安装的是 cordis 插件且 DSH 正在运行时会提示「重启生效」
（复用 `/api/dsh/restart` 交接闭环；未运行则下次启动自然生效）。

设计说明：市场安装走 **profile patch 注册**（`cordis.patch.yml` 幂等加行），
**不写** `package.json` 的 `dsh.profile.bundles`，与 dsh-admin 自己的按文件夹
`--patch` overlay 是两条独立通道——同名包已在 bundles 里时安装会被拒绝
（409 `conflicts_with_profile_bundle`），避免双注册导致 webserver 重复路由
崩溃（STANDARD §6.4）。

## API 面

| 路由 | 权限 | 说明 |
|---|---|---|
| `GET /api/admin/market` | admin | 收录条目列表（含安装数） |
| `POST /api/admin/market/import` | admin | multipart 上传 .tar.gz 导入 |
| `DELETE /api/admin/market/:id` | admin | 删除条目（用户安装记录级联消失；已装进用户 home 的文件不动） |
| `GET /api/me/market` | user | 可装条目 + 自己的安装记录（含可更新标记） |
| `POST /api/me/market/:id/install` | user | 安装/更新 |
| `POST /api/me/market/uninstall` | user | 卸载（`{name}`） |

所有操作写审计日志（`market_import` / `market_delete` / `plugin_install` /
`plugin_uninstall`）。

## 存储与限制

- 收录内容存 `<dataRoot>/market/<uuid>/`（SQLite 记路径），备份 `dsh-data` 时
  一并包含。
- script 型、源码型构建、依赖安装均不在离线市场能力范围内——作者侧应发布
  产物型包（STANDARD §2.2）。
- 技能/预设无版本概念（STANDARD §8）：重复导入即覆盖，用户重装即更新。

冒烟测试：`npm run smoke:market`（四种形态 fixture：插件/技能/预设/脚本拒绝 →
导入 → 安装落盘与 patch 注册 → 更新 → 卸载清理 → 删除级联）。
