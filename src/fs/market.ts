/**
 * 离线插件市场的域逻辑：导入（解包 + 类型判定 + 静态安全检查）与
 * 每用户安装/卸载。判定顺序与落盘位置遵循 STANDARD.md（DSH 插件
 * 市场收录规范）：
 *
 * - cordis-plugin → `profiles/web/node_modules/<pkg>` + 幂等注册
 *   `profiles/web/cordis.patch.yml`（不动 profile 的 bundles —— 与
 *   dsh-admin 自己按文件夹启用的 `--patch` overlay 分离，避免双注册）；
 * - skill → `~/.dsh/skills/<name>/`；
 * - agent-preset → `~/.dsh/.agent-presets/<name>/`；
 * - script 型（install.ps1/install.sh）刻意不支持：本平台不执行第三方脚本。
 *
 * 部署形态是内网离线，因此导入只接受 tgz（如 GitHub codeload
 * 归档），不 clone、不跑 npm install。
 *
 * 导入期还做三件增量工作：披露声明解析（STANDARD §9 的最小子集，
 * 回答「会不会往外网发数据」）、cordis 插件的沙箱启动探测（临时 home
 * 里先空 profile 启动建基线，再装插件重启一次，launchToken 行就绪、
 * 启动即崩都看得到）、多包仓库/技能合集的子目录扫描（STANDARD §1
 * 顺序 5/8/9）。
 * @module dsh-admin/fs/market
 */

import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import * as tar from 'tar'
import { Document, parseDocument, isMap, isSeq, YAMLMap, YAMLSeq, type ParsedNode } from 'yaml'
import type { ServerConfig } from '../config.js'
import { MAIN_PROFILE } from './plugins.js'
import { findFreePort, scrubEnv } from '../supervisor/spawn.js'
import { atomicWriteFile } from './storage.js'
import { userHomeDir } from './workspace.js'

export type MarketKind = 'cordis-plugin' | 'skill' | 'agent-preset'

export interface MarketMeta {
  kind: MarketKind
  name: string
  version: string
  description: string
  /** 静态安全/兼容性提示，安装界面原样展示（不阻断安装）。 */
  warnings: string[]
  /** cordis 插件：运行时依赖是否已全部 bundle 进包内
   * （`bundledDependencies` 覆盖 `dependencies`；无依赖视为真）。 */
  selfContained: boolean
}

/** 解包膨胀上限：归档声明的总内容大小超过它视为可疑（压缩炸弹）。 */
const MAX_EXTRACT_BYTES = 2 * 1024 * 1024 * 1024

/** npm 包名（含 scoped）。包名直接决定安装目录，因此这里同时是
 * 路径安全校验（STANDARD §2.1 的 PKG_NAME_PATTERN）。 */
const PKG_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** skill / preset 的落盘目录名。 */
const DIR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** git 归档顶层目录的后缀形态：`<repo>-<branch>` / `<repo>-<sha>` / `<repo>-<tag>`。 */
const ARCHIVE_SUFFIX_RE = /-(main|master|[0-9a-f]{7,40}|v?\d+(\.\d+)*)$/

/** DSH 宿主接口包（STANDARD §2.1/§6.6）：进普通 dependencies 会
 * 遮蔽宿主、打挂工具调用，只能 peer。 */
const HOST_INTERFACE_NAMES = new Set([
  'dsh-tools',
  'dsh-llm',
  'dsh-system-prompt',
  'dsh-attachment',
  'dsh-scope',
  'dsh-schema',
])

function isHostInterfacePackage(name: string): boolean {
  return name.startsWith('@deepseek-ai/') || HOST_INTERFACE_NAMES.has(name)
}

// ---- dsh 版本判定（安装生效语义用）------------------------------------------

interface ParsedVersion {
  nums: [number, number, number]
  pre: string[]
}

/** 从版本行（如 `0.1.2-rc.1`，容忍 `dsh/0.1.2-rc.1` 之类的前缀）提取
 * 可比较的 semver 元组；无法解析时为 null。 */
function parseVersion(raw: string | null): ParsedVersion | null {
  if (raw === null) return null
  const m = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(raw)
  if (m === null) return null
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] === undefined ? [] : m[4]!.split('.'),
  }
}

/** semver prerelease 标识符比较：数字按数值、数字 < 字母、前缀短者小。 */
function comparePre(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d < 0 ? -1 : 1
    } else if (nx !== ny) {
      return nx ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** 首个确认支持 web profile `patchReload: "live"` 的版本（web 模板自此
 * 默认监视 profile 级与 home 级 patch 文件并热重载；本机随 dsh-cli
 * 0.1.2-rc.1 分发的 dsh-app-boot PROFILE_TEMPLATES 可查证）。 */
const LIVE_PATCH_RELOAD_FLOOR: ParsedVersion = { nums: [0, 1, 2], pre: ['rc', '1'] }

/** 该 dsh 版本的 cordis 插件装/卸是否可免重启热生效（写入 profile 级
 * `cordis.patch.yml` 后由运行中实例的 live 重载器拾取）。版本未知一律
 * 返回 false —— 回退到「重启生效」的保守语义。 */
export function supportsLivePatchReload(version: string | null): boolean {
  const v = parseVersion(version)
  if (v === null) return false
  for (let i = 0; i < 3; i++) {
    if (v.nums[i] !== LIVE_PATCH_RELOAD_FLOOR.nums[i]) {
      return v.nums[i]! > LIVE_PATCH_RELOAD_FLOOR.nums[i]!
    }
  }
  if (v.pre.length === 0) return true // 同号正式版高于一切 prerelease
  return comparePre(v.pre, LIVE_PATCH_RELOAD_FLOOR.pre) >= 0
}

function isGitPath(p: string): boolean {
  return p.split(/[\\/]+/).includes('.git')
}

/** 复制条目内容到目标目录（排除 .git；导入路由用它把多包仓库的
 * 子包拆进各自的独立存储目录）。 */
export async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  await cp(src, dest, { recursive: true, force: true, filter: (source) => !isGitPath(source) })
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 大小写不敏感地找一个文件（SKILL.md 约定如此）；返回实际文件名。 */
async function findFileCaseInsensitive(dir: string, name: string): Promise<string | null> {
  const entries = await readdir(dir).catch(() => [] as string[])
  const lower = name.toLowerCase()
  for (const entry of entries) {
    if (entry.toLowerCase() === lower) return entry
  }
  return null
}

interface PackageJsonLike {
  name?: unknown
  version?: unknown
  description?: unknown
  main?: unknown
  dsh?: unknown
  dependencies?: unknown
  peerDependencies?: unknown
  bundledDependencies?: unknown
  bundleDependencies?: unknown
  disclosure?: unknown
}

async function readPackageJson(dir: string): Promise<PackageJsonLike | null> {
  const raw = await readFile(join(dir, 'package.json'), 'utf8').catch(() => null)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as PackageJsonLike) : null
  } catch {
    return null
  }
}

/** package.json 声明了 DSH 插件能力：`dsh` 字段或 `@deepseek-ai/*`
 * 依赖/peer 依赖（STANDARD §1 第 2 条）。 */
function declaresDshCapability(pkg: PackageJsonLike): boolean {
  if (pkg.dsh !== null && pkg.dsh !== undefined && typeof pkg.dsh === 'object') return true
  for (const section of [pkg.dependencies, pkg.peerDependencies]) {
    if (section === null || section === undefined || typeof section !== 'object') continue
    for (const name of Object.keys(section)) {
      if (name.startsWith('@deepseek-ai/')) return true
    }
  }
  return false
}

/**
 * 解包 tgz 到 destDir，返回有效源目录。tar 包默认拒绝 `..`/绝对
 * 路径条目（tar-slip 防护）；这里再排除 `.git` 并施加膨胀上限。
 * GitHub codeload 归档总有唯一顶层目录，剥离之；散装归档直接用
 * destDir 本身。
 */
export async function extractTgz(tgzPath: string, destDir: string): Promise<string> {
  await mkdir(destDir, { recursive: true })
  let total = 0
  await tar.x({
    file: tgzPath,
    cwd: destDir,
    filter: (path, entry) => {
      if (isGitPath(path)) return false
      total += entry.size
      if (total > MAX_EXTRACT_BYTES) throw new Error('归档解包后的总大小超过上限（疑似压缩炸弹）')
      return true
    },
  })
  const entries = await readdir(destDir, { withFileTypes: true })
  const dirs = entries.filter((entry) => entry.isDirectory())
  if (dirs.length === 1 && entries.length === 1) return join(destDir, dirs[0]!.name)
  return destDir
}

export type DetectedKind = MarketKind | 'script' | 'none'

/** 按 STANDARD §1 的固定顺序判定源目录类型（先命中者生效）。 */
async function detectMarketKind(srcDir: string): Promise<DetectedKind> {
  if ((await exists(join(srcDir, 'preset.yml'))) && (await exists(join(srcDir, 'agent.cordis.yml')))) {
    return 'agent-preset'
  }
  const pkg = await readPackageJson(srcDir)
  if (pkg !== null && declaresDshCapability(pkg)) return 'cordis-plugin'
  if ((await exists(join(srcDir, 'install.ps1'))) || (await exists(join(srcDir, 'install.sh')))) {
    return 'script'
  }
  if ((await findFileCaseInsensitive(srcDir, 'SKILL.md')) !== null) return 'skill'
  return 'none'
}

/** skill / preset 无包名可依时的目录名兜底：优先 SKILL.md frontmatter
 * 的 `name:`，否则剥掉 git 归档后缀的顶层目录名。非法形态抛错。 */
function fallbackDirName(raw: string, what: string): string {
  const stripped = raw.replace(ARCHIVE_SUFFIX_RE, '')
  const candidate = DIR_NAME_RE.test(stripped) ? stripped : raw
  if (!DIR_NAME_RE.test(candidate)) throw new Error(`无法确定${what}名称：${JSON.stringify(raw)}`)
  return candidate
}

/** 抽取元数据并做静态安全检查。非法输入（坏包名、无法定名）抛错，
 * 由路由层转 422。 */
export async function readMarketMeta(srcDir: string, kind: MarketKind): Promise<MarketMeta> {
  if (kind === 'cordis-plugin') {
    const pkg = await readPackageJson(srcDir)
    if (pkg === null) throw new Error('缺少 package.json')
    const name = typeof pkg.name === 'string' ? pkg.name : ''
    if (!PKG_NAME_RE.test(name)) throw new Error(`非法的包名：${JSON.stringify(name)}`)
    const version = typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0'
    const description = typeof pkg.description === 'string' ? pkg.description : ''
    const warnings: string[] = []
    const depNames =
      typeof pkg.dependencies === 'object' && pkg.dependencies !== null ? Object.keys(pkg.dependencies) : []
    const bundled = new Set([
      ...stringArray(pkg.bundledDependencies),
      ...stringArray(pkg.bundleDependencies),
    ])
    const selfContained = depNames.every((d) => bundled.has(d))
    const hostDeps = depNames.filter(isHostInterfacePackage)
    if (hostDeps.length > 0) {
      warnings.push(`宿主接口包 ${hostDeps.join('、')} 被声明为普通依赖（应为 peerDependencies；旧副本遮蔽宿主会让工具调用失败）`)
    } else if (depNames.length > 0 && !selfContained) {
      warnings.push('包含运行时依赖：离线安装不执行 npm install，请确认产物自带或依赖均为 peer')
    }
    if (typeof pkg.main === 'string' && pkg.main !== '' && !(await exists(join(srcDir, pkg.main)))) {
      warnings.push(`入口 ${pkg.main} 不在包内（源码型？市场安装不执行构建）`)
    }
    return { kind, name, version, description, warnings, selfContained }
  }

  if (kind === 'skill') {
    const skillFile = await findFileCaseInsensitive(srcDir, 'SKILL.md')
    let name = ''
    let description = ''
    if (skillFile !== null) {
      const text = await readFile(join(srcDir, skillFile), 'utf8').catch(() => '')
      const frontmatterName = /^name:\s*(\S+)\s*$/m.exec(text)
      if (frontmatterName !== null) name = frontmatterName[1]!
      description = firstProseLine(text)
    }
    if (!DIR_NAME_RE.test(name)) name = fallbackDirName(basename(srcDir), '技能')
    return { kind, name, version: '', description, warnings: [], selfContained: false }
  }

  // agent-preset：以（剥后缀的）顶层目录名作为预设名。
  return {
    kind,
    name: fallbackDirName(basename(srcDir), '预设'),
    version: '',
    description: '',
    warnings: [],
    selfContained: false,
  }
}

/** SKILL.md 的第一行非标题/非 frontmatter 文本，作卡片描述。 */
function firstProseLine(text: string): string {
  const lines = text.split('\n')
  let i = 0
  // 文件以 --- 开头时跳过整个 frontmatter 块（注意开头围栏本身不算结束）。
  if (lines[0]?.trim() === '---') {
    for (i = 1; i < lines.length; i++) {
      const t = lines[i].trim()
      if (t === '---' || t === '...') {
        i++
        break
      }
    }
  }
  for (; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    return trimmed.slice(0, 80)
  }
  return ''
}

/** 未知 → 字符串数组的防御性收敛（每项截断，总量有上限）。 */
function stringArray(value: unknown, cap = 10, itemCap = 200): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .map((v) => v.slice(0, itemCap))
    .slice(0, cap)
}

// ---- 披露层（STANDARD §9 字段契约的最小子集）--------------------------------
// 离线内网没有「装之前看商店页面」的上下文，披露是管理员收录与用户
// 安装前回答「这东西会不会往外网发数据」的唯一依据。cordis 插件读
// package.json 的 `disclosure`（camelCase），技能读 SKILL.md frontmatter
// （snake_case）——两套键名都收敛到同一结构。

export interface MarketDisclosure {
  /** 是否声明过披露字段；false = 卡片显示「未声明」。 */
  declared: boolean
  /** 是否把数据发往云端；false = 纯本地。 */
  cloud?: boolean
  /** 数据目的地端点。 */
  network?: string[]
  /** 是否存在完全离线的使用路径。 */
  offlineMode?: boolean
  /** 凭据获取方式与存储位置（STANDARD D3）。 */
  apiKeys?: Array<{ env?: string; storage?: string }>
  /** 法域标签（PIPL(CN) 等）。 */
  jurisdiction?: string[]
  /** 数据保留策略：none / session / server。 */
  retention?: string
}

function firstObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeDisclosure(raw: Record<string, unknown>): MarketDisclosure {
  const out: MarketDisclosure = { declared: true }
  if (typeof raw.cloud === 'boolean') out.cloud = raw.cloud
  const network = stringArray(raw.network)
  if (network.length > 0) out.network = network
  const offline = raw.offlineMode ?? raw.offline_mode
  if (typeof offline === 'boolean') out.offlineMode = offline
  const apiKeys: unknown = raw.apiKeys ?? raw.api_keys
  if (Array.isArray(apiKeys)) {
    out.apiKeys = apiKeys
      .map((entry: unknown) => firstObject(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map((entry) => ({
        env: typeof entry.env === 'string' ? entry.env.slice(0, 120) : undefined,
        storage: typeof entry.storage === 'string' ? entry.storage.slice(0, 120) : undefined,
      }))
      .slice(0, 20)
  }
  const jurisdiction = stringArray(raw.jurisdiction)
  if (jurisdiction.length > 0) out.jurisdiction = jurisdiction
  if (typeof raw.retention === 'string' && raw.retention !== '') out.retention = raw.retention.slice(0, 40)
  return out
}

/** 提取 SKILL.md 顶部的 frontmatter 块并按 YAML 解析；无 frontmatter 为 null。 */
async function readFrontmatter(srcDir: string): Promise<Record<string, unknown> | null> {
  const skillFile = await findFileCaseInsensitive(srcDir, 'SKILL.md')
  if (skillFile === null) return null
  const text = await readFile(join(srcDir, skillFile), 'utf8').catch(() => '')
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end < 0) return null
  try {
    const parsed = parseDocument(text.slice(4, end))
    if (parsed.errors.length > 0) return null
    return firstObject(parsed.toJS())
  } catch {
    return null
  }
}

/** 读取条目的披露声明；未声明时返回 `{ declared: false }`（不抛错 ——
 * 披露缺失是展示语义，不是导入失败）。 */
export async function readMarketDisclosure(srcDir: string, kind: MarketKind): Promise<MarketDisclosure> {
  if (kind === 'skill') {
    const fm = await readFrontmatter(srcDir)
    return fm !== null ? normalizeDisclosure(fm) : { declared: false }
  }
  if (kind === 'cordis-plugin') {
    const pkg = await readPackageJson(srcDir)
    const raw = firstObject(pkg?.disclosure)
    return raw !== null ? normalizeDisclosure(raw) : { declared: false }
  }
  return { declared: false }
}

// ---- offline-packager 元数据 -------------------------------------------------

/** `dsh-plugin-offline-packager` 产出的 `*.meta.json`（与 .tgz 成对）
 * 中对市场卡片有用的字段子集；键名按该工具的输出防御性解析。 */
export interface PackMeta {
  /** 打包时是否把完整生产依赖树带进 tarball（自包含）。 */
  selfContained?: boolean
  /** 打包时的 dsh 版本（兼容性参考）。 */
  dshVersion?: string
  /** 来源（npm 包名 / GitHub 仓库 / 本地路径）。 */
  source?: string
  /** 打包时间（ISO 字符串原样保留）。 */
  packedAt?: string
}

export function parsePackMeta(raw: string): PackMeta | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const obj = firstObject(parsed)
  if (obj === null) return null
  const meta: PackMeta = {}
  if (typeof obj.dshVersion === 'string') meta.dshVersion = obj.dshVersion.slice(0, 40)
  else if (typeof obj.dsh === 'string') meta.dshVersion = obj.dsh.slice(0, 40)
  if (typeof obj.source === 'string') meta.source = obj.source.slice(0, 200)
  if (typeof obj.packedAt === 'string') meta.packedAt = obj.packedAt.slice(0, 40)
  else if (typeof obj.packedAt === 'number') meta.packedAt = new Date(obj.packedAt).toISOString()
  if (Array.isArray(obj.bundledDependencies)) meta.selfContained = obj.bundledDependencies.length > 0
  return Object.keys(meta).length > 0 ? meta : null
}

// ---- 安装前启动探测（沙箱 boot probe）----------------------------------------
// 静态检查只能看 package.json；插件是否真能随 web profile 起来，只有
// 真启动一次才知道（§6.4 的双注册 → webserver 重复路由 → 启动崩溃、
// bundle patch 语法错、模块解析失败都在这条路径上暴露）。流程：临时
// home → 空 profile 跑一次 `dsh --profile web` 建基线（launchToken 行
// 打印 = 插件加载完成、服务就绪；CLI 缺失/起不来 → skipped，绝不阻断
// 导入）→ 复制插件进 profile node_modules 并写 patch 行 → 再启动一次：
// 崩溃或未就绪即插件问题。运行中的探测实例用完即 SIGKILL。
//
// 注：`--dump-config` 在 0.1.2-rc.1 上只组合配置树、不加载第三方插件
// 模块（实测连 bundle patch 语法错都拦不住），因此不做 dump 级校验。

export interface MarketValidation {
  status: 'pass' | 'fail' | 'skipped'
  detail?: string
  checkedAt: number
}

const BOOT_PROBE_TIMEOUT_MS = 20_000
/** `dsh web` 的 launchToken 行（编排器同款匹配）：插件加载完成后才打印，
 * 是「完整启动成功」的可靠信号。 */
const BOOT_READY_RE = /dsh web: \S*\/\?token=[A-Za-z0-9_-]{20,}/

interface BootResult {
  ready: boolean
  /** spawn 本身失败（ENOENT 等）——环境问题，校验应降级为 skipped。 */
  spawnFailed: boolean
  detail?: string
}

function runBootProbe(config: ServerConfig, home: string, port: number): Promise<BootResult> {
  return new Promise((resolve) => {
    const [cmd = 'dsh', ...prefix] = config.dshCommand
    let scan = ''
    let errTail = ''
    let done = false
    const child = spawn(
      cmd,
      // --no-open：探测不需要也不应该拉起浏览器（dsh web 默认会 open）。
      [...prefix, '--profile', MAIN_PROFILE, '--host', '127.0.0.1', '--port', String(port), '--no-open'],
      {
        cwd: home,
        env: { ...scrubEnv(process.env), HOME: home, DSH_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const finish = (result: BootResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ ready: false, spawnFailed: false, detail: `启动未在 ${BOOT_PROBE_TIMEOUT_MS / 1000}s 内就绪（可能被插件拖住或环境过慢）` }),
      BOOT_PROBE_TIMEOUT_MS,
    )
    timer.unref()
    child.on('error', (err) => finish({ ready: false, spawnFailed: true, detail: `无法运行 dsh CLI（${err.message}）——跳过启动校验` }))
    child.stdout?.on('data', (chunk: Buffer) => {
      scan = (scan + chunk.toString()).slice(-4096)
      if (BOOT_READY_RE.test(scan)) finish({ ready: true, spawnFailed: false })
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      errTail = (errTail + chunk.toString()).slice(-1024)
    })
    child.on('close', (code) => {
      finish({ ready: false, spawnFailed: false, detail: `启动即退出（code ${code ?? '—'}）：${errTail.trim().slice(-500)}` })
    })
  })
}

export async function validatePluginConfig(
  config: ServerConfig,
  srcDir: string,
  name: string,
): Promise<MarketValidation> {
  const checkedAt = Date.now()
  let home: string | undefined
  try {
    home = await mkdtemp(join(tmpdir(), 'dsh-mktval-'))
    const base = await runBootProbe(config, home, await findFreePort())
    if (!base.ready) {
      return { status: 'skipped', detail: base.detail ?? '基线启动未就绪——跳过校验', checkedAt }
    }
    const profileDir = join(home, 'profiles', MAIN_PROFILE)
    await mkdir(join(profileDir, 'node_modules'), { recursive: true })
    await cp(srcDir, join(profileDir, 'node_modules', name), { recursive: true, filter: (s) => !isGitPath(s) })
    await addPatchRow(join(profileDir, 'cordis.patch.yml'), name)
    const withPlugin = await runBootProbe(config, home, await findFreePort())
    return withPlugin.ready
      ? { status: 'pass', checkedAt }
      : { status: 'fail', detail: withPlugin.detail ?? '装上该插件后 dsh web 启动失败', checkedAt }
  } catch (err) {
    return { status: 'skipped', detail: err instanceof Error ? err.message : String(err), checkedAt }
  } finally {
    if (home !== undefined) await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

/** 管理员共享 patch（home 级 cordis.patch.yml）保存前的沙箱启动校验：
 * 形状问题在路由层已挡，这里验证「dsh 真的能带着这层 patch 启动」——
 * 否则一条坏 patch 会打挂全员 DSH 的启动（loadOptionalPatches 失败即
 * fail loud）。CLI 不可用时 skipped（保存放行，理由展示给管理员）。 */
export async function validateHomePatch(config: ServerConfig, yamlText: string): Promise<MarketValidation> {
  const checkedAt = Date.now()
  let home: string | undefined
  try {
    home = await mkdtemp(join(tmpdir(), 'dsh-patchval-'))
    const base = await runBootProbe(config, home, await findFreePort())
    if (!base.ready) {
      return { status: 'skipped', detail: base.detail ?? '基线启动未就绪——跳过校验', checkedAt }
    }
    await writeFile(join(home, 'cordis.patch.yml'), yamlText)
    const withPatch = await runBootProbe(config, home, await findFreePort())
    return withPatch.ready
      ? { status: 'pass', checkedAt }
      : { status: 'fail', detail: withPatch.detail ?? '带该共享 patch 时 dsh web 启动失败', checkedAt }
  } catch (err) {
    return { status: 'skipped', detail: err instanceof Error ? err.message : String(err), checkedAt }
  } finally {
    if (home !== undefined) await rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

// ---- 多包仓库 / 技能合集扫描（STANDARD §1 顺序 5/8/9）------------------------

/** 扫描子目录时跳过的目录名（vendored 目录里的 SKILL.md 不装）。 */
const SKIP_SUBDIRS = new Set(['node_modules', 'upstream', 'vendor', 'vendors'])

export interface MarketRoot {
  kind: MarketKind
  dir: string
}

export interface MarketScan {
  /** 根目录自身的判定结果（script 时 roots 为空，由路由给明确 422）。 */
  rootKind: DetectedKind
  /** 可收录的条目根；根目录未命中时按深度 3 的子目录扫描填充。 */
  roots: MarketRoot[]
}

async function scanSubdirs(dir: string, depth: number, out: MarketRoot[]): Promise<void> {
  if (depth > 3) return
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const dirs = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        !SKIP_SUBDIRS.has(entry.name.toLowerCase()),
    )
    .map((entry) => join(dir, entry.name))
    .sort()
  for (const sub of dirs) {
    // 同一子目录按 §1 的顺序判型：预设 → 插件 → 技能；命中即收录、
    // 不再下钻（合集仓库的包目录本身是叶子）。
    if ((await exists(join(sub, 'preset.yml'))) && (await exists(join(sub, 'agent.cordis.yml')))) {
      out.push({ kind: 'agent-preset', dir: sub })
      continue
    }
    const pkg = await readPackageJson(sub)
    if (pkg !== null && declaresDshCapability(pkg)) {
      out.push({ kind: 'cordis-plugin', dir: sub })
      continue
    }
    if ((await findFileCaseInsensitive(sub, 'SKILL.md')) !== null) {
      out.push({ kind: 'skill', dir: sub })
      continue
    }
    await scanSubdirs(sub, depth + 1, out)
  }
}

/** 按 STANDARD §1 扫描一个解包后的源目录，返回全部可收录条目根。
 * 根目录命中（§1 顺序 1/2/3/4/6/7）→ 单条目；根为无特征 → 子目录
 * 扫描（顺序 5/8/9，深度 3，跳过 .git / 点目录 / node_modules /
 * vendored 目录）。 */
export async function scanMarketRoots(srcDir: string): Promise<MarketScan> {
  const rootKind = await detectMarketKind(srcDir)
  if (
    rootKind === 'cordis-plugin' ||
    rootKind === 'skill' ||
    rootKind === 'agent-preset'
  ) {
    return { rootKind, roots: [{ kind: rootKind, dir: srcDir }] }
  }
  const roots: MarketRoot[] = []
  if (rootKind === 'none') await scanSubdirs(srcDir, 0, roots)
  return { rootKind, roots }
}

// ---- profile patch 行的幂等注册 --------------------------------------------
// cordis.patch.yml 是「操作序列」：每个操作是带 `insert` 键的映射，
// 值是 {id, name} 行序列 —— 与 supervisor/patch.ts 的 renderPatch
// 同构。市场安装把插件行写进 profile 自己的 patch 文件（持久、与
// 文件夹级 `--patch` overlay 无关）。

async function readPatchDoc(file: string): Promise<Document> {
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Document(new YAMLSeq())
    throw error
  }
  if (text.trim() === '') return new Document(new YAMLSeq())
  const doc = parseDocument(text)
  if (doc.errors.length > 0) throw new Error(`位于 ${file} 的文档无法解析：${doc.errors[0]?.message}`)
  // 异常形态（非序列）按空 patch 处理，而不是冒险改写。
  if (!isSeq(doc.contents)) return new Document(new YAMLSeq())
  return doc
}

async function writePatchDoc(file: string, doc: Document): Promise<void> {
  await atomicWriteFile(file, String(doc))
}

/** 找到（或创建）第一个 `insert` 操作的行序列。 */
function insertRows(ops: YAMLSeq): YAMLSeq {
  for (const op of ops.items) {
    if (!isMap(op) || !op.has('insert')) continue
    const value = (op as YAMLMap).get('insert', true)
    if (isSeq(value)) return value
    const rows = new YAMLSeq()
    ;(op as YAMLMap).set('insert', rows)
    return rows
  }
  const op = new YAMLMap()
  const rows = new YAMLSeq()
  op.set('insert', rows)
  ops.add(op)
  return rows
}

/** 幂等地把一行 `{id, name}` 加进 patch 文件。 */
async function addPatchRow(file: string, id: string): Promise<void> {
  const doc = await readPatchDoc(file)
  const rows = insertRows(doc.contents as YAMLSeq)
  for (const row of rows.items) {
    if (isMap(row) && (row as YAMLMap).get('id') === id) return
  }
  const row = new YAMLMap()
  row.set('id', id)
  row.set('name', id)
  rows.add(row)
  await writePatchDoc(file, doc)
}

/** 从 patch 文件删掉指定 id 的行；文件不存在或没有该行时静默。 */
async function removePatchRow(file: string, id: string): Promise<void> {
  let doc: Document
  try {
    doc = await readPatchDoc(file)
  } catch {
    return
  }
  const ops = doc.contents as YAMLSeq
  for (const op of ops.items) {
    if (!isMap(op) || !op.has('insert')) continue
    const rows = (op as YAMLMap).get('insert', true)
    if (!isSeq(rows)) continue
    const index = rows.items.findIndex((row) => isMap(row) && (row as YAMLMap).get('id') === id)
    if (index >= 0) {
      rows.delete(index)
      await writePatchDoc(file, doc)
      return
    }
  }
}

// ---- 安装 / 卸载 ------------------------------------------------------------

export interface MarketItemRef {
  kind: MarketKind
  name: string
  /** 市场条目在服务器上的源目录（dataRoot/market/<id>/…）。 */
  dir: string
}

/** 把市场条目装进用户的 DSH home。目标已存在时覆盖（更新语义）。 */
export async function installMarketItem(config: ServerConfig, userId: string, item: MarketItemRef): Promise<void> {
  const home = userHomeDir(config, userId)
  let dest: string
  if (item.kind === 'cordis-plugin') {
    dest = join(home, 'profiles', MAIN_PROFILE, 'node_modules', item.name)
  } else {
    dest = join(home, item.kind === 'skill' ? 'skills' : '.agent-presets', item.name)
  }
  await mkdir(dirname(dest), { recursive: true })
  await cp(item.dir, dest, {
    recursive: true,
    force: true,
    filter: (source) => !isGitPath(source),
  })
  if (item.kind === 'cordis-plugin') {
    await addPatchRow(join(home, 'profiles', MAIN_PROFILE, 'cordis.patch.yml'), item.name)
  }
}

/** 卸载：删除落盘目录（plugin 额外移除 patch 行）。文件不存在视为成功。 */
export async function uninstallMarketItem(
  config: ServerConfig,
  userId: string,
  kind: MarketKind,
  name: string,
): Promise<void> {
  const home = userHomeDir(config, userId)
  if (kind === 'cordis-plugin') {
    await rm(join(home, 'profiles', MAIN_PROFILE, 'node_modules', name), { recursive: true, force: true })
    await removePatchRow(join(home, 'profiles', MAIN_PROFILE, 'cordis.patch.yml'), name)
    return
  }
  await rm(join(home, kind === 'skill' ? 'skills' : '.agent-presets', name), { recursive: true, force: true })
}
