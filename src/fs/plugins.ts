/**
 * 每用户插件发现：读取常驻 DSH profile 的 `dsh.profile.bundles`，
 * 呈现用户自装的 bundle，并过滤掉随安装携带的 `@deepseek-ai/*`
 * bundle。名称/描述取自每个 bundle 自己的 package.json。
 * @module dsh-admin/fs/plugins
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerConfig } from '../config.js'
import { userHomeDir } from './workspace.js'

/** 用户可按文件夹启用的插件（`id` 兼作包名）。 */
export interface PluginInfo {
  id: string
  name: string
  description: string
}

/** 常驻主 DSH 启动所用的 profile 名（见 supervisor）。 */
export const MAIN_PROFILE = 'web'

/** 此 scope 下的 bundle 来自 dsh 安装本身，而非用户。 */
const INSTALLATION_SCOPE = '@deepseek-ai/'

/** 用户 profile 目录的绝对路径（`<dataRoot>/users/<id>/home/profiles/web`）。 */
function profileDir(config: ServerConfig, userId: string): string {
  return join(userHomeDir(config, userId), 'profiles', MAIN_PROFILE)
}

/** 读取 package.json 的 `description`，容忍字段或文件缺失/为空。
 * 依赖可能被 pnpm workspace 提升到 `profiles/node_modules`（真实容器
 * 布局实测），也可能在 profile 自己的 `node_modules` 里（市场安装
 * 落点）——两处都试。 */
async function readDescription(config: ServerConfig, userId: string, packageName: string): Promise<string> {
  const home = userHomeDir(config, userId)
  for (const base of [join(profileDir(config, userId), 'node_modules'), join(home, 'profiles', 'node_modules')]) {
    const parsed = (await readJson(join(base, packageName, 'package.json'))) as { description?: unknown } | null
    if (typeof parsed?.description === 'string' && parsed.description !== '') return parsed.description
  }
  return ''
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 从用户 profile 的 `dsh.profile.bundles` 列出其已安装的插件，
 * 减去随安装携带的 bundle。profile（或所列包）尚未安装时返回
 * `[]`。顺序遵循 bundle 的层叠顺序。
 */
export async function listInstalledPlugins(config: ServerConfig, userId: string): Promise<PluginInfo[]> {
  const dir = profileDir(config, userId)
  const manifest = (await readJson(join(dir, 'package.json'))) as
    | { dsh?: { profile?: { bundles?: unknown[] } } }
    | null
  if (manifest === null) return []
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const plugins = await Promise.all(
    bundles
      .filter((packageName): packageName is string => typeof packageName === 'string')
      .filter((packageName) => !packageName.startsWith(INSTALLATION_SCOPE))
      .map(async (packageName) => ({
        id: packageName,
        name: packageName,
        description: await readDescription(config, userId, packageName),
      })),
  )
  return plugins
}
