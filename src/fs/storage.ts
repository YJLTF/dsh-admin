/**
 * 每用户磁盘用量统计（异步 du，供管理台存储视图）与跨模块共享的
 * 原子写文件助手。
 * 符号链接不跟随（不计入，也不深入），避免环与重复计数。
 * @module dsh-admin/fs/storage
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 临时文件 + 原子 rename 写盘。临时名带随机后缀，并发写入同一目标
 * 不会共享半截内容，也不会互相 rename 掉对方的临时文件；调用方无需
 * 自行清理（失败时临时文件由调用方按需 rm，或留在原地等待覆盖）。
 */
export async function atomicWriteFile(
  file: string,
  data: string | Uint8Array,
  opts: { mode?: number; mkdirs?: boolean } = {},
): Promise<void> {
  if (opts.mkdirs) await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`
  await writeFile(tmp, data, opts.mode !== undefined ? { mode: opts.mode } : undefined)
  if (opts.mode !== undefined) await chmod(tmp, opts.mode)
  await rename(tmp, file)
}

/** 递归求目录树的总字节数；目录本身占用的块大小不计。 */
export async function dirUsage(root: string): Promise<number> {
  let total = 0
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      total += await dirUsage(full)
    } else if (entry.isFile()) {
      const st = await stat(full).catch(() => null)
      if (st !== null) total += st.size
    }
  }
  return total
}
