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
 * @module dsh-admin/fs/market
 */

import { randomBytes } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import * as tar from 'tar'
import { Document, parseDocument, isMap, isSeq, YAMLMap, YAMLSeq, type ParsedNode } from 'yaml'
import type { ServerConfig } from '../config.js'
import { MAIN_PROFILE } from './plugins.js'
import { userHomeDir } from './workspace.js'

export type MarketKind = 'cordis-plugin' | 'skill' | 'agent-preset'

export interface MarketMeta {
  kind: MarketKind
  name: string
  version: string
  description: string
  /** 静态安全/兼容性提示，安装界面原样展示（不阻断安装）。 */
  warnings: string[]
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

function isGitPath(p: string): boolean {
  return p.split(/[\\/]+/).includes('.git')
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
export async function detectMarketKind(srcDir: string): Promise<DetectedKind> {
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
    const hostDeps = depNames.filter(isHostInterfacePackage)
    if (hostDeps.length > 0) {
      warnings.push(`宿主接口包 ${hostDeps.join('、')} 被声明为普通依赖（应为 peerDependencies；旧副本遮蔽宿主会让工具调用失败）`)
    } else if (depNames.length > 0) {
      warnings.push('包含运行时依赖：离线安装不执行 npm install，请确认产物自带或依赖均为 peer')
    }
    if (typeof pkg.main === 'string' && pkg.main !== '' && !(await exists(join(srcDir, pkg.main)))) {
      warnings.push(`入口 ${pkg.main} 不在包内（源码型？市场安装不执行构建）`)
    }
    return { kind, name, version, description, warnings }
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
    return { kind, name, version: '', description, warnings: [] }
  }

  // agent-preset：以（剥后缀的）顶层目录名作为预设名。
  return {
    kind,
    name: fallbackDirName(basename(srcDir), '预设'),
    version: '',
    description: '',
    warnings: [],
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
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`
  await writeFile(tmp, String(doc))
  await rename(tmp, file)
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
