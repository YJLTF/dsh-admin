// 冒烟脚本共享工具：断言、JSON fetch 封装、sleep 与尽力而为的临时目录清理。
// 不依赖第三方包（仅 node: 内置模块）。
import { rmSync } from 'node:fs'

/** `condition` 为假时抛出异常。 */
export function assert(condition, message) {
  if (!condition) throw new Error('ASSERT: ' + message)
}

/** 基于某个 base URL 的 JSON fetch：→ { status, body, setCookie }。 */
export function makeJson(base) {
  return async function json(path, { method = 'GET', body, cookie } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') }
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 尽力而为的临时目录清理：Windows 上刚被杀掉的子进程可能仍占用句柄几毫秒；
 * 绝不让清理失败掩盖真正的断言失败。 */
export function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch (e) {
    console.log('清理已跳过：', e.code ?? e.message)
  }
}
