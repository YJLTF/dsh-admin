/**
 * dsh CLI 离线热更新的域逻辑：管理台上传 `scripts/pack-dsh.ps1` 产出
 * 的 dsh-cli.tgz（顶层为 `node_modules/` 的 gzip tar），平台在挂载目录
 * 内解包校验后原子替换 `node_modules`。
 *
 * 为什么在平台内做：历史流程是管理员手工 `docker exec` 进容器解压——
 * Windows 宿主机上的 tar 创建不了归档里的 POSIX 符号链接（留下 0 字节
 * 假 shim，子 DSH 反复崩溃熔断，见 docs/troubleshooting.md「Windows 宿
 * 主机解压 dsh-cli.tgz」）。Node 的 tar 解包原生支持符号链接条目，且
 * 先解到同文件系统的 staging 目录、校验通过后才换名替换：失败不会
 * 破坏现有安装。
 * @module dsh-admin/fs/dsh-cli
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerConfig } from '../config.js'
import { extractTgz } from './market.js'

/** dsh 本体在 CLI 目录下的固定位置。 */
const DSH_PACKAGE_DIR = join('node_modules', '@deepseek-ai', 'dsh')

/** dsh 本体 package.json 在 node_modules 目录内的相对位置。 */
const DSH_PKG_IN_MODULES = join('@deepseek-ai', 'dsh', 'package.json')

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** CLI 目录的当前状态；未配置 DSH_ADMIN_DSH_CLI_DIR 时为 null
 * （平台不管 CLI 更新，管理台展示引导文案）。 */
export interface DshCliInfo {
  cliDir: string
  /** `node_modules/@deepseek-ai/dsh/package.json` 的 version。 */
  installedVersion: string | null
}

export async function readDshCliInfo(config: ServerConfig): Promise<DshCliInfo | null> {
  if (config.dshCliDir === '') return null
  const pkg = await readJson(join(config.dshCliDir, DSH_PACKAGE_DIR, 'package.json'))
  const installedVersion = typeof pkg?.version === 'string' && pkg.version !== '' ? pkg.version : null
  return { cliDir: config.dshCliDir, installedVersion }
}

/** 归档不是 dsh-cli.tgz 形态（找不到 @deepseek-ai/dsh 或缺 .bin）。 */
export class InvalidCliArchiveError extends Error {}

export interface DshCliUpdateResult {
  previousVersion: string | null
  newVersion: string
}

/**
 * 解包 + 校验 + 原子替换 `<cliDir>/node_modules`。
 *
 * staging 建在 cliDir **内部**（跨文件系统 rename 不是原子的，挂载
 * 目录与容器可写层可能不同 fs）。pack-dsh.ps1 产物的唯一顶层目录
 * `node_modules/` 会被 extractTgz 按 codeload 规则剥离，解包结果即
 * `node_modules` 内容本身；顶层不止一项的归档不剥离，需下探一层。
 * 两处各探测一次 `@deepseek-ai/dsh` + `.bin`，探测到的目录整体换名。
 */
export async function updateDshCli(config: ServerConfig, tgzPath: string): Promise<DshCliUpdateResult> {
  const cliDir = config.dshCliDir
  const info = await stat(cliDir).catch(() => null)
  if (info === null || !info.isDirectory()) {
    throw new InvalidCliArchiveError(`CLI 目录不存在：${cliDir}（检查 DSH_ADMIN_DSH_CLI_DIR）`)
  }
  const staging = join(cliDir, `.update-staging-${randomBytes(6).toString('hex')}`)
  await mkdir(staging, { recursive: true })
  try {
    const extracted = await extractTgz(tgzPath, staging)
    let modulesDir: string | null = null
    let newVersion: string | null = null
    for (const dir of [extracted, join(extracted, 'node_modules')]) {
      const pkg = await readJson(join(dir, DSH_PKG_IN_MODULES))
      const version = typeof pkg?.version === 'string' && pkg.version !== '' ? pkg.version : null
      if (version !== null && (await exists(join(dir, '.bin')))) {
        modulesDir = dir
        newVersion = version
        break
      }
    }
    if (modulesDir === null || newVersion === null) {
      throw new InvalidCliArchiveError(
        '归档中未找到可用的 @deepseek-ai/dsh（应为 pack-dsh.ps1 产出的 dsh-cli.tgz，顶层 node_modules/ 且含 .bin 符号链接）',
      )
    }
    const previousPkg = await readJson(join(cliDir, DSH_PACKAGE_DIR, 'package.json'))
    const previousVersion =
      typeof previousPkg?.version === 'string' && previousPkg.version !== '' ? previousPkg.version : null
    const target = join(cliDir, 'node_modules')
    const backup = join(cliDir, `.node_modules.old-${randomBytes(6).toString('hex')}`)
    if (await exists(target)) {
      await rename(target, backup)
      try {
        await rename(modulesDir, target)
      } catch (err) {
        await rename(backup, target).catch(() => {}) // 回滚失败只能如实上报错误
        throw err
      }
      // 备份只是换名后的旧 node_modules，成功即删；删不掉也只是垃圾，
      // 不该让已成功的更新报错。
      await rm(backup, { recursive: true, force: true }).catch(() => {})
    } else {
      await rename(modulesDir, target)
    }
    return { previousVersion, newVersion }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}
