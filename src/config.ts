/**
 * 随部署环境变化的配置。所有可调参数都是这里经过校验的字段
 * （或从环境变量读取），绝不以硬编码常量的形式散落在应用内部。
 * @module dsh-admin/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 隔离级别。`soft` = 每用户主目录/工作区 + 沙箱（同一 OS 用户）；
 * `account` = 通过 setuid 包装器为每用户分配独立 OS 账户（Linux，需 root）。 */
export type IsolationMode = 'soft' | 'account'

/** 解析后不可变的运行时配置。 */
export interface ServerConfig {
  /** 编排器 HTTP 服务器的绑定主机。 */
  host: string
  /** 绑定端口；`0` 表示请求一个临时端口。 */
  port: number
  /** SQLite 数据库路径。 */
  dbPath: string
  /** 用户主目录（`users/<id>/home`）与工作区所在的根目录。 */
  dataRoot: string
  /** 拉起子 DSH 的 argv；第一个元素是可执行文件。 */
  dshCommand: string[]
  /** Pino 日志级别。 */
  logLevel: string
  /** 会话有效期（秒）。 */
  sessionTtlSeconds: number
  /** JSON 请求体最大字节数（全局 bodyLimit；上传已改为 multipart 流式）。 */
  maxUploadBytes: number
  /** 单个上传文件的最大字节数（multipart limits.fileSize 强制）。 */
  maxFileBytes: number
  /** 文本预览最多读取的字节数（超出截断并标记 truncated）。 */
  previewBytes: number
  /** 崩溃的子 DSH 自动重启前的延迟（毫秒）。 */
  restartBackoffMs: number
  /** 隔离级别（见 {@link IsolationMode}）。 */
  isolationMode: IsolationMode
  /** 用于降权的 argv 前缀；其中的 `{UID}`/`{GID}` 会被替换。 */
  spawnAsUserCommand: string[]
  /** 确定性每用户 uid 的基准 uid。 */
  baseUid: number
  /** 是否向子 DSH 传递 `--patch`（需要 dsh CLI 支持）。 */
  enablePatch: boolean
  /** 用户在浏览器中输入以访问本服务器的主机名/IP（例如 Docker 端口
   * 映射背后的局域网 IP）。设置后，DSH 链接使用
   * `http://<publicHost>:<childPort>/` —— 直接发布子端口。 */
  publicHost: string
  /** 子 DSH 端口的闭区间范围；`0` = 由 OS 分配临时端口。
   * 设置固定范围（如 40000–40100）以便 Docker 发布。 */
  dshPortMin: number
  dshPortMax: number
  /** 启用环回 OUTPUT owner 匹配端口守卫（Linux + root）。 */
  portGuard: boolean
  /** 信任 `X-Forwarded-*` 头（仅当部署在你自己控制的反向代理之后；
   * 否则 `request.ip` —— 以及限流桶 —— 将可被伪造）。 */
  trustProxy: boolean | string
}

/** 从 argv / 环境变量收集的未类型化覆盖项。 */
export interface ConfigOverrides {
  host?: string
  port?: string | number
  dbPath?: string
  dataRoot?: string
  dshCommand?: string[]
  logLevel?: string
  sessionTtlSeconds?: number | string
  maxUploadBytes?: number | string
  maxFileBytes?: number | string
  previewBytes?: number | string
  restartBackoffMs?: number | string
  isolationMode?: IsolationMode | string
  spawnAsUserCommand?: string[]
  baseUid?: number | string
  enablePatch?: boolean
  publicHost?: string
  dshPortMin?: number | string
  dshPortMax?: number | string
  portGuard?: boolean
  trustProxy?: boolean | string
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3080
const DEFAULT_DSH_COMMAND = ['dsh']
const DEFAULT_LOG_LEVEL = 'info'
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024 * 1024
const DEFAULT_PREVIEW_BYTES = 256 * 1024
const DEFAULT_RESTART_BACKOFF_MS = 1000
const DEFAULT_ISOLATION_MODE: IsolationMode = 'soft'
const DEFAULT_SPAWN_AS_USER_COMMAND = [
  'setpriv',
  '--reuid',
  '{UID}',
  '--regid',
  '{GID}',
  '--inh-caps=-all',
  '--clear-groups',
  '--',
]
const DEFAULT_BASE_UID = 100000
const DEFAULT_ENABLE_PATCH = false

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === 'true' || value === '1'
}

/** 把命令字符串切分为 argv 词元，支持双引号包裹的片段
 * （例如 `"node C:/Program Files/dsh/bin.js"` → 2 个词元）。让 Windows
 * 开发环境可以 `node <绝对路径>` 方式启动 npm shim 包装的 CLI —— 因为
 * spawn() 无法执行 npm 在那里安装的 .cmd/.ps1 shim。 */
export function parseCommandString(value: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(value)) !== null) tokens.push(match[1] ?? match[2])
  return tokens.length > 0 ? tokens : [value]
}

/** 解析 isolation-mode 值，拒绝 `soft`/`account` 之外的任何取值，
 * 这样环境变量里的拼写错误会在启动时大声报错，而不是静默回退到
 * `soft` 隔离。 */
function toIsolationMode(value: string | undefined): IsolationMode | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'soft' || normalized === 'account') return normalized
  throw new Error(`无效的隔离模式 "${value}"（应为 "soft" 或 "account"）`)
}

function toTrustProxy(value: string | undefined): boolean | string {
  if (value === undefined || value === '') return false
  if (value === 'true' || value === '1') return true
  // 其余取值被视为交给 Fastify 的显式代理列表/CIDR。
  return value
}

/**
 * 在默认值之上叠加 argv/环境变量覆盖项。`dataRoot` 默认为
 * `~/.dsh-admin`（开发环境始终可写）；生产环境设置
 * `DSH_ADMIN_DATA_ROOT=/var/lib/dsh-admin`。
 */
export function resolveConfig(overrides: ConfigOverrides = {}): ServerConfig {
  const dataRoot =
    overrides.dataRoot ?? process.env.DSH_ADMIN_DATA_ROOT ?? join(homedir(), '.dsh-admin')
  const port = overrides.port ?? process.env.DSH_ADMIN_PORT ?? DEFAULT_PORT
  const dshBin = process.env.DSH_ADMIN_DSH_BIN
  const isolationMode =
    toIsolationMode(overrides.isolationMode) ??
    toIsolationMode(process.env.DSH_ADMIN_ISOLATION_MODE) ??
    DEFAULT_ISOLATION_MODE
  return {
    host: overrides.host ?? process.env.DSH_ADMIN_HOST ?? DEFAULT_HOST,
    port: typeof port === 'number' ? port : Number(port),
    dbPath: overrides.dbPath ?? join(dataRoot, 'server-login.db'),
    dataRoot,
    dshCommand: overrides.dshCommand ?? (dshBin !== undefined && dshBin !== '' ? parseCommandString(dshBin) : DEFAULT_DSH_COMMAND),
    logLevel: overrides.logLevel ?? DEFAULT_LOG_LEVEL,
    sessionTtlSeconds: Number(
      overrides.sessionTtlSeconds ?? process.env.DSH_ADMIN_SESSION_TTL ?? DEFAULT_SESSION_TTL_SECONDS,
    ),
    maxUploadBytes: Number(
      overrides.maxUploadBytes ?? process.env.DSH_ADMIN_MAX_UPLOAD ?? DEFAULT_MAX_UPLOAD_BYTES,
    ),
    maxFileBytes: Number(
      overrides.maxFileBytes ?? process.env.DSH_ADMIN_MAX_FILE ?? DEFAULT_MAX_FILE_BYTES,
    ),
    previewBytes: Number(
      overrides.previewBytes ?? process.env.DSH_ADMIN_PREVIEW_MAX ?? DEFAULT_PREVIEW_BYTES,
    ),
    restartBackoffMs: Number(
      overrides.restartBackoffMs ?? process.env.DSH_ADMIN_RESTART_BACKOFF ?? DEFAULT_RESTART_BACKOFF_MS,
    ),
    isolationMode,
    spawnAsUserCommand: overrides.spawnAsUserCommand ?? DEFAULT_SPAWN_AS_USER_COMMAND,
    baseUid: Number(overrides.baseUid ?? process.env.DSH_ADMIN_BASE_UID ?? DEFAULT_BASE_UID),
    enablePatch: overrides.enablePatch ?? toBool(process.env.DSH_ADMIN_ENABLE_PATCH, DEFAULT_ENABLE_PATCH),
    publicHost: overrides.publicHost ?? process.env.DSH_ADMIN_PUBLIC_HOST ?? '',
    dshPortMin: Number(
      overrides.dshPortMin ?? process.env.DSH_ADMIN_DSH_PORT_MIN ?? 0,
    ),
    dshPortMax: Number(
      overrides.dshPortMax ?? process.env.DSH_ADMIN_DSH_PORT_MAX ?? 0,
    ),
    portGuard: overrides.portGuard ?? toBool(process.env.DSH_ADMIN_PORT_GUARD, false),
    trustProxy: overrides.trustProxy ?? toTrustProxy(process.env.DSH_ADMIN_TRUST_PROXY),
  }
}
