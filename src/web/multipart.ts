/**
 * multipart 上传路由共享的辅助：把选中的文件 part 流式写盘。
 * 与 routes/market.ts、routes/ops.ts 原先各自手写的
 * 「遍历 parts → pipeline 写临时文件 → truncated 判 413」是同一段逻辑。
 * @module dsh-admin/web/multipart
 */

import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import type { FastifyRequest } from 'fastify'

/**
 * 遍历请求的文件 part，`pick` 对每个文件 part 返回落盘目标（null =
 * 忽略该 part）。首个文件 part 的序号为 0。任一被选中的 part 在写入
 * 过程中被截断（超过 multipart limits.fileSize）即停止并返回
 * `'too_large'`；正常结束返回 `'ok'`（由调用方判断是否拿到了需要的
 * 文件，如必须至少一个文件 part 的 400 语义）。
 */
export async function saveSelectedFileParts(
  request: FastifyRequest,
  pick: (fieldname: string, fileIndex: number) => string | null,
): Promise<'ok' | 'too_large'> {
  let fileIndex = 0
  for await (const part of request.parts()) {
    if (part.type !== 'file') continue
    const target = pick(part.fieldname, fileIndex)
    fileIndex++
    if (target === null) continue
    await pipeline(part.file, createWriteStream(target))
    if (part.file.truncated) return 'too_large'
  }
  return 'ok'
}
