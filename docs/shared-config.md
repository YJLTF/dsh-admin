# 共享模型配置 — 管理员统一维护，用户按需接收

DSH 的模型提供方配置存在每个用户自己的 `$DSH_HOME` 里（互相隔离），普通用户不一定会配。
本功能让管理员维护**一份全局配置**，用户在桌面点一下「接收」，服务端把它合并进该用户自己的 DSH home。

## 数据形态

管理员配置存 SQLite（`shared_config` 表，版本号自增），两部分：

```yaml
# providers：路由名 → 提供方档案（写入用户 settings.yaml 的 llm-pi-ai.providers 下）
providers:
  deepseek:
    displayName: DeepSeek
    baseURL: https://api.deepseek.com
    api: openai        # DSH 的 api 适配类型
    apiKeyEnv: DEEPSEEK_KEY   # 凭据引用名（不是 key 本身）
    models:            # 模型清单（可选）
      - id: deepseek-chat
        input: [text]  # 该模型接受的输入模态
    defaultInput: [text, image]   # 目录未描述的模型的回退（至少一项）
    modelOverrides:    # 目录提供方按模型 id 收窄模态（可选）
      claude-sonnet-4-5: { input: [text] }
    headers: { X-Custom: value }  # 额外请求头（可选）

# credentials：引用名 → API key 明文（写入用户 .credentials.yaml）
credentials:
  DEEPSEEK_KEY: sk-xxxx
```

### 模型额外参数（输入模态）

来自 DSH 官方提供方文档，用于让图片输入（粘贴截图等）路由到支持它的模型：

| 字段 | 位置 | 作用 |
|---|---|---|
| `models[].input` | 模型级 | 声明该模型接受 `[text]` / `[text, image]` |
| `defaultInput` | 路由级 | 提供方目录没描述到的模型的回退；至少一项 |
| `modelOverrides` | 路由级（目录提供方） | 按模型 id 覆盖目录默认，如把某多模态目录里的文本模型收窄为 `input: [text]` |

## 安全模型

- 凭据**明文只对管理员接口返回**（`GET /api/admin/shared-config`）；用户接口
  （`GET /api/me/shared-config`）只暴露提供方名与凭据**引用名**，key 永不下发到用户浏览器。
- 合并写入用户 `.credentials.yaml` 时文件权限 `0600`、临时文件原子 rename。
- 管理端 UI（admin / 桌面管理台）输入凭据后仅显示引用名，不回显明文。

## 接收与合并

用户点「接收」（`POST /api/me/shared-config/accept`）时，服务端在**服务端侧**完成合并
（不经过浏览器），用的是 DSH 同款 `yaml` Document API：

- 只动共享的路由 / 引用：管理员后来删掉的路由或引用会从用户文件里**同步撤掉**，
  用户自己加的提供方、凭据、注释与格式**原样保留**（叶子级合并）。
- 先写 `settings.yaml` 再写 `.credentials.yaml`——运行中的 DSH 若在中间热重载，
  看到的也是一致的最终组合。
- DSH 用 chokidar 监视这两个文件，**外部写入会热重载**，无需重启子 DSH。

每次管理员保存配置 version 自增；`shared_config_state` 记录每个用户已接受的版本，
用于差量合并（知道用户上次拿了什么，才能算出「这次该删什么」）。

## API 面

| 路由 | 权限 | 说明 |
|---|---|---|
| `GET /api/admin/shared-config` | admin | 读配置（含凭据明文） |
| `PUT /api/admin/shared-config` | admin | 保存配置（version 自增） |
| `GET /api/me/shared-config` | user | 当前配置摘要（仅引用名）+ 是否有可接收的新版本 |
| `POST /api/me/shared-config/accept` | user | 接收并合并进自己的 DSH home |

冒烟测试：`npm run smoke:shared-config`（校验合并、删除同步、凭据不下发）。
