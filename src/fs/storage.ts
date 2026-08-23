/**
 * 每用户磁盘用量统计（异步 du，供管理台存储视图）。
 * 符号链接不跟随（不计入，也不深入），避免环与重复计数。
 * @module dsh-admin/fs/storage
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

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
