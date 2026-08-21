/**
 * 面向所有文件系统操作的路径穿越守卫。
 *
 * `resolveWithinRoot` 把用户提供的相对路径规范到某个根目录之下，
 * 拒绝任何越出它的路径；`safeFilename` 从上传文件名中剥离目录成分。
 * @module dsh-admin/web/middleware/fs-guard
 */

import { basename, isAbsolute, resolve, sep } from 'node:path'
import type { ServerConfig } from '../../config.js'
import { ensureWorkspaceRoot, workspaceRoot } from '../../fs/workspace.js'

/** 路径越出允许根目录时的哨兵错误。 */
export class PathEscapeError extends Error {
  constructor(path: string, root: string) {
    super(`路径 ${path} 越出了根目录 ${root}`)
    this.name = 'PathEscapeError'
  }
}

/** {@link resolveUserPath} 的结果。 */
export type UserPath = { ok: true; abs: string } | { ok: false; code: 'bad_path' }

/**
 * 所有面向工作区的路由共享的路由前置辅助：解析用户的工作区根目录、
 * 确保其存在，并把用户提供的相对路径规范到它之下。
 */
export function resolveUserPath(config: ServerConfig, userId: string, relPath: string): UserPath {
  const root = workspaceRoot(config, userId)
  ensureWorkspaceRoot(root)
  try {
    return { ok: true, abs: resolveWithinRoot(root, relPath) }
  } catch {
    return { ok: false, code: 'bad_path' }
  }
}

/**
 * 把 `rel` 规范到 `root` 之下，拒绝绝对路径、NUL 字节以及任何
 * 越出根目录的结果（包括 `..` 穿越）。
 * @param root - 用户的工作区根目录（绝对路径）。
 * @param rel - 用户提供的相对路径（`''` 规范为 `root`）。
 */
export function resolveWithinRoot(root: string, rel: string): string {
  if (isAbsolute(rel)) throw new PathEscapeError(rel, root)
  if (rel.includes('\0')) throw new PathEscapeError('<nul>', root)
  const resolved = resolve(root, rel)
  const boundary = root.endsWith(sep) ? root : root + sep
  if (resolved !== root && !resolved.startsWith(boundary)) {
    throw new PathEscapeError(rel, root)
  }
  return resolved
}

/**
 * 把上传文件名归约为基本文件名，拒绝空/点/NUL 名称，
 * 让客户端无法夹带路径成分。
 */
export function safeFilename(name: string): string {
  const base = basename(name)
  if (base === '' || base === '.' || base === '..' || base.includes('\0')) {
    throw new PathEscapeError(name, '<filename>')
  }
  return base
}
