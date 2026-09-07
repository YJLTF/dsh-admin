# 插件/技能离线市场 — 管理员收录，用户一键安装

dsh-admin 部署在内网，容器不能访问 GitHub/npm，因此市场采用**离线镜像**模式：
管理员在有网机器上下载插件仓库归档（.tar.gz），上传到 dsh-admin 收录；用户在
桌面「管理插件 → 插件市场」一键安装/更新/卸载，服务端把内容装进该用户自己的
DSH home。类型判定与安装管线遵循 [STANDARD.md](../STANDARD.md)（DSH 插件市场
收录规范）的对应子集。

导入期为每个条目采集三类增量元数据（均不阻断导入，卡片如实展示）：

- **披露徽章**（STANDARD §9 最小子集）：cordis 插件读 package.json 的
  `disclosure` 字段、技能读 SKILL.md frontmatter（snake_case）。`cloud: false`
  → 「本地 · 无云端依赖 ✓」；`cloud: true` → 「云端依赖 ⚠」（悬停显示端点与
  保留策略）；未声明 → 「披露未声明」。内网环境里这是判断「该不该装」的第一依据。
- **沙箱启动探测**（仅 cordis 插件）：临时 home 里先空 profile 启动一次
  `dsh --profile web` 建基线（launchToken 行打印 = 就绪），再装进插件重启一次；
  启动即崩（模块加载失败 / 非法插件导出形态 / 双注册类启动崩溃）→「✗ 校验失败」。
  dsh CLI 不可用或环境起不来 →「未校验」（跳过，不阻断）。已知边界：插件自带
  bundle patch 的延迟解析错误在 rc.1 上拦不住。管理台可对单条目手动重跑
  （`POST /api/admin/market/:id/validate`），dsh CLI 升级后结论可能翻转。
  注意 `--dump-config` 只组合配置树、不加载第三方插件模块，拦不住插件侧问题
  （实测），因此不做 dump 级校验。
- **打包元数据**：导入时可选附带 offline-packager 的 `*.meta.json`（第二个文件
  part `meta`），加上导入时对 `bundledDependencies` 的静态判定，卡片显示
  「自包含（离线可装）/ 打包时 dsh 版本 / 来源」。

## 支持的类型与落盘位置

| 类型 | 判定特征（按此顺序） | 安装位置（每用户） |
|---|---|---|
| cordis-plugin | `package.json` 声明 `dsh` 字段或 `@deepseek-ai/*` 依赖 | `home/profiles/web/node_modules/<包名>` + 注册 `home/profiles/web/cordis.patch.yml` |
| agent-preset | 根目录同时有 `preset.yml` + `agent.cordis.yml` | `home/.agent-presets/<名称>/` |
| skill | 根目录 `SKILL.md`（大小写不敏感；frontmatter `name:` 优先作为名称） | `home/skills/<名称>/` |
| script | 根目录 `install.ps1` / `install.sh` | **不支持**（本平台不执行第三方脚本，导入时 422 拒绝） |

无上述任何特征的仓库（纯 README）同样被拒绝（`no_market_signature`）。

**多包仓库 / 技能合集**：根目录未命中时按 STANDARD §1 顺序 5/8/9 扫描深度 3
内的子目录（预设 → 插件 → 技能；命中目录不再下钻；`.git` / 点目录 /
`node_modules` / `upstream` / `vendor` 跳过），一次导入产生多条目，各自拥有
独立存储目录（删除单条目不影响同批其他条目）。

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
- 含未 bundle 的运行时 `dependencies`：**离线安装不执行 `npm install`**，
  请确认产物自带（`bundledDependencies` 覆盖全部运行时依赖时卡片显示
  「自包含」且不告警）；
- `main` 入口不在包内（疑似源码型，市场安装不执行构建）。

## 用户流程

桌面 → 「管理插件」→ 「插件市场」Tab：浏览收录条目（类型/版本/描述/披露
徽章/校验结论/警告），安装 / 更新 / 卸载。

**生效语义**（dsh ≥0.1.2-rc.1）：web profile 模板默认 `patchReload: "live"`，
实时监视 profile 级与 home 级 patch 文件——cordis 插件的装/卸/更新写完
`cordis.patch.yml` 即被运行中的实例热重载，**无需重启**（安装响应
`reload: 'hot'`）；旧版 dsh 或技能/预设类仍提示重启（`reload: 'restart'`），
复用 `/api/dsh/restart` 交接闭环。

设计说明：市场安装走 **profile patch 注册**（`cordis.patch.yml` 幂等加行），
**不写** `package.json` 的 `dsh.profile.bundles`，与 dsh-admin 自己的按文件夹
`--patch` overlay 是两条独立通道——同名包已在 bundles 里时安装会被拒绝
（409 `conflicts_with_profile_bundle`），避免双注册导致 webserver 重复路由
崩溃（STANDARD §6.4）。

## 管理员推送全员（shared）

收录的**技能 / agent 预设**可标记「推送全员」（市场管理表格里的按钮，或
`POST /api/admin/market/:id/shared`）：平台立即装进所有可用用户的 home，
之后每次用户 launch 前自动补齐/升级（版本变化才重装，见
`src/fs/shared-sync.ts`）。推送语义：

- 推送条目在用户侧显示「已推送」徽章，**不能自行卸载**（`user_plugins.source`
  标记为 `shared`，卸载返回 409 `managed_by_shared`）；用户自装/升级会保持
  shared 来源。
- 取消推送后安装记录降级为自装（`user`），已装文件保留、用户可自行卸载。
- cordis 插件**刻意不支持**推送：插件注册走 profile 级 patch，强推会与用户
  自主安装的双通道冲突（STANDARD §6.4）。共享列表查询也按此过滤。

## 管理员共享 patch 层（home 级 cordis.patch.yml）

dsh 的配置叠加顺序是 `bundles → profile patch → home patch → --patch`。
市场安装写 **profile 级**，而管理台「系统设置 → 共享插件层」维护 **home 级**
`$DSH_HOME/cordis.patch.yml` —— 两者正交。适合全员调参 / 禁用某插件
（`- disable: <id>`）等治理动作；**勿 insert 市场已安装的插件**（与市场注册
重复加载，STANDARD §6.4）。行为：

- 保存前两道校验：YAML 形状（顶层 patch ops 数组，元素为映射）+ **沙箱启动
  探测**（复用导入期的 boot probe：坏 patch 会让 `loadOptionalPatches`
  fail loud、打挂全员 DSH 启动，必须挡在保存前；dsh CLI 不可用时降级为
  skipped 放行并明示）。
- 保存即同步所有可用用户（平台拥有该文件，整体原子重写）；运行中的实例经
  rc.1 live 重载即时生效；清空保存则删除各用户的该文件。
- 用户 launch 前也会自动补写（覆盖新注册/文件丢失的场景）。

## API 面

| 路由 | 权限 | 说明 |
|---|---|---|
| `GET /api/admin/market` | admin | 收录条目列表（含安装数/校验/披露/打包元数据/推送标志） |
| `POST /api/admin/market/import` | admin | multipart 上传 .tar.gz（可选 `meta` part：offline-packager 的 .meta.json）；多包仓库一次导入多条目 |
| `POST /api/admin/market/:id/validate` | admin | 手动重跑沙箱启动探测（仅 cordis 插件） |
| `POST /api/admin/market/:id/shared` | admin | 推送全员开关（仅技能/预设；`{shared: boolean}`，开启即同步全员） |
| `GET /api/admin/shared-patch` | admin | 读取共享 patch 层（home 级 cordis.patch.yml） |
| `PUT /api/admin/shared-patch` | admin | 保存共享 patch（形状 + 沙箱启动校验 → 全员同步；清空 = 删除） |
| `DELETE /api/admin/market/:id` | admin | 删除条目（用户安装记录级联消失；已装进用户 home 的文件不动） |
| `GET /api/me/market` | user | 可装条目 + 自己的安装记录（含可更新标记/安装来源） |
| `POST /api/me/market/:id/install` | user | 安装/更新（响应含 `reload: hot\|restart\|none`） |
| `POST /api/me/market/uninstall` | user | 卸载（`{name}`；shared 来源返回 409 `managed_by_shared`） |

所有操作写审计日志（`market_import` / `market_delete` / `market_validate` /
`plugin_install` / `plugin_uninstall`）。

## 存储与限制

- 收录内容存 `<dataRoot>/market/<uuid>/`（SQLite 记路径），备份 `dsh-data` 时
  一并包含。
- script 型、源码型构建、依赖安装均不在离线市场能力范围内——作者侧应发布
  产物型包（STANDARD §2.2）。
- 技能/预设无版本概念（STANDARD §8）：重复导入即覆盖，用户重装即更新。

冒烟测试：`npm run smoke:market`（四种形态 fixture：插件/技能/预设/脚本拒绝 →
导入 → 安装落盘与 patch 注册 → 更新 → 卸载清理 → 删除级联）。
