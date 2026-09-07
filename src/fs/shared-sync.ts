/**
 * 管理员共享资源的同步（B 线：共享资源面）：
 *
 * - 「推送全员」的市场条目（仅技能 / agent 预设）由平台自动装进每个
 *   用户的 DSH home —— 用户不点安装也能用，卸载会在下次 launch 恢复
 *   （推送语义）。cordis 插件刻意不支持推送：插件注册走 profile 级
 *   patch，强推会与用户自主安装的双通道冲突（STANDARD §6.4）。
 * - 管理员共享 patch 层写入用户的 home 级 `cordis.patch.yml` —— dsh
 *   配置叠加的独立一层（bundles → profile patch → home patch →
 *   `--patch`），与市场安装（profile 层）正交；rc.1 live 重载同时监视
 *   这个文件，保存后运行中的实例即时生效。平台拥有该文件（用户的文件
 *   桌面在 workspace，够不到 DSH_HOME），因此整体原子重写是安全的。
 * @module dsh-admin/fs/shared-sync
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument, isMap, isSeq } from 'yaml'
import type { Database } from '../db/connection.js'
import {
  getSettingRow,
  listSharedMarketItems,
  findUserPluginByName,
  upsertUserPlugin,
} from '../db/repo.js'
import type { ServerConfig } from '../config.js'
import { installMarketItem } from './market.js'
import { atomicWriteFile } from './storage.js'
import { userHomeDir } from './workspace.js'

/** 共享 patch 层在 app_settings 里的存储键。 */
export const SHARED_PATCH_KEY = 'shared_patch_yaml'

/** 共享 patch 文本上限（patch ops 是小文档，超限基本是贴错内容）。 */
export const SHARED_PATCH_MAX_BYTES = 64 * 1024

export function getSharedPatch(db: Database): { yaml: string; updatedAt: number } | null {
  const row = getSettingRow(db, SHARED_PATCH_KEY)
  if (row === undefined) return null
  return { yaml: row.value, updatedAt: row.updatedAt }
}

/** 形状校验：顶层必须是 YAML 序列，元素是映射（loader patch ops）。
 * 返回归一化文本（空 patch = ''）。语义错误（未知的 id / 坏的 config
 * 键）offline 无法判定，由保存前的沙箱启动探测兜底。 */
export function normalizeSharedPatch(
  raw: string,
): { ok: true; yaml: string } | { ok: false; error: string } {
  const text = raw.replace(/\r\n/g, '\n').trim()
  if (text === '') return { ok: true, yaml: '' }
  if (Buffer.byteLength(text, 'utf8') > SHARED_PATCH_MAX_BYTES) {
    return { ok: false, error: `共享 patch 超过 ${SHARED_PATCH_MAX_BYTES / 1024}KB 上限` }
  }
  const doc = parseDocument(text)
  if (doc.errors.length > 0) {
    return { ok: false, error: `YAML 无法解析：${doc.errors[0]?.message ?? '未知错误'}` }
  }
  if (!isSeq(doc.contents) || doc.contents.items.length === 0) {
    return { ok: false, error: '顶层必须是 patch 操作的 YAML 数组（如 `- id: xxx` / `- disable: xxx`），空内容请直接清空' }
  }
  for (const [index, item] of doc.contents.items.entries()) {
    if (!isMap(item)) {
      return { ok: false, error: `第 ${index + 1} 项必须是映射（"- id: …" 或 "- disable: …"）` }
    }
  }
  return { ok: true, yaml: `${text}\n` }
}

/** 把共享 patch 写进用户 home 级 cordis.patch.yml（原子写）。
 * dsh 会监视该文件（live 模式），运行中的实例即时生效。 */
export async function writeSharedPatch(config: ServerConfig, userId: string, yamlText: string): Promise<void> {
  await atomicWriteFile(join(userHomeDir(config, userId), 'cordis.patch.yml'), yamlText, { mkdirs: true })
}

/** 清除用户 home 级共享 patch（管理员清空共享 patch 后同步调用；
 * 该文件由平台拥有，删除是安全的）。 */
export async function removeSharedPatch(config: ServerConfig, userId: string): Promise<void> {
  await rm(join(userHomeDir(config, userId), 'cordis.patch.yml'), { force: true })
}

/** 单用户同步「推送全员」的市场条目：未装或版本落后才重装
 * （installMarketItem 本身是覆盖语义）。返回本次实际安装数。 */
export async function syncSharedItemsForUser(
  config: ServerConfig,
  db: Database,
  userId: string,
): Promise<number> {
  let installed = 0
  for (const item of listSharedMarketItems(db)) {
    const existing = findUserPluginByName(db, userId, item.name)
    if (existing !== undefined && existing.version === item.version) continue
    await installMarketItem(config, userId, { kind: item.kind, name: item.name, dir: item.dir })
    upsertUserPlugin(db, userId, {
      marketItemId: item.id,
      kind: item.kind,
      name: item.name,
      version: item.version,
      source: 'shared',
    })
    installed++
  }
  return installed
}

/** 单用户全量共享同步（市场条目 + patch 文件），launch 前调用。
 * 尽力而为：调用方负责 try/catch，失败不阻断启动。 */
export async function syncSharedContentForUser(config: ServerConfig, db: Database, userId: string): Promise<void> {
  await syncSharedItemsForUser(config, db, userId)
  const patch = getSharedPatch(db)
  if (patch === null) return
  if (patch.yaml === '') await removeSharedPatch(config, userId)
  else await writeSharedPatch(config, userId, patch.yaml)
}
