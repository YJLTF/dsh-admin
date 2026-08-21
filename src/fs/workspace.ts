/**
 * 每用户文件系统布局辅助函数。根目录由 `dataRoot` + 用户 id 派生，
 * 因此是确定性的，无需经数据库往返。隔离由调用方强制执行（见 fs-guard）。
 * @module dsh-admin/fs/workspace
 */

import { chmodSync, mkdirSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerConfig } from '../config.js'

/** 用户工作区的绝对根目录（`<dataRoot>/users/<id>/ws`）。 */
export function workspaceRoot(config: ServerConfig, userId: string): string {
  return join(config.dataRoot, 'users', userId, 'ws')
}

/** 用户 DSH 主目录的绝对路径（`<dataRoot>/users/<id>/home`）——
 * 这是进程管理器、认证和共享配置路由共同使用的布局的唯一
 * 事实来源。 */
export function userHomeDir(config: ServerConfig, userId: string): string {
  return join(config.dataRoot, 'users', userId, 'home')
}

/** 本进程已创建过的根目录；`mkdirSync(recursive)` 仍会遍历
 * 路径，因此在请求热路径上跳过重复调用。 */
const ensured = new Set<string>()

/** 若工作区根目录（0700）不存在则创建它。 */
export function ensureWorkspaceRoot(root: string): void {
  if (ensured.has(root)) return
  mkdirSync(root, { recursive: true, mode: 0o700 })
  ensured.add(root)
}

/** 创建用户所有的目录（0700），含父目录（异步）。 */
export async function ensureUserDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  chmodSync(path, 0o700)
}

/** 返回给桌面的单个文件系统条目。 */
export interface FsEntry {
  name: string
  type: 'file' | 'dir'
  size: number
  mtimeMs: number
}

/** 列出目录的直接子项（异步，并行 stat）。 */
export async function listDir(absPath: string): Promise<FsEntry[]> {
  const entries = await readdir(absPath, { withFileTypes: true })
  const stats = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      // withFileTypes 已给出 dir/file；stat 只补充 size/mtime。
      st: entry.isDirectory() ? null : await stat(join(absPath, entry.name)).catch(() => null),
    })),
  )
  return stats.map(({ entry, st }) => ({
    name: entry.name,
    type: entry.isDirectory() ? 'dir' : 'file',
    size: st?.isFile() ? st.size : 0,
    mtimeMs: st?.mtimeMs ?? 0,
  }))
}
