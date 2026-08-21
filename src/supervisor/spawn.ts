/**
 * 进程管理器的子进程辅助函数：环境变量清洗与空闲端口查找。
 *
 * 环境变量清洗遵循 harness 的 `scrubbedParentEnv` / `SENSITIVE_ENV_PATTERN`
 * 准则（packages/subprocess/subprocess/src/index.ts）：从干净的允许列表
 * 构建子进程环境，确保没有任何编排器机密泄漏进用户 DSH，然后再注入
 * 解析好的每用户取值。
 * @module dsh-admin/supervisor/spawn
 */

import { createServer } from 'node:net'

const ALLOWED_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'TMP',
  'TEMP',
  'TMPDIR',
  'SYSTEMROOT',
  'SystemRoot',
  'PATHEXT',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'LANG',
  'LC_ALL',
])

/** 丢弃凭据形态和未知的环境变量；只保留安全的允许列表。 */
export function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (ALLOWED_ENV.has(key) && value !== undefined) out[key] = value
  }
  return out
}

/** 尝试绑定一个环回端口；端口空闲时 resolve true。 */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

/**
 * 预留一个空闲的环回端口然后释放它。当 `min`/`max` > 0 时，在闭区间
 * 范围内随机挑选端口直到某个可绑定（固定范围便于 Docker 发布）；
 * 否则向 OS 请求临时端口。
 */
export function findFreePort(min = 0, max = 0): Promise<number> {
  if (min > 0 && max >= min) {
    const span = max - min + 1
    return (async () => {
      // 随机起点把并发拉起时的冲突分散开。
      const start = Math.floor(Math.random() * span)
      for (let i = 0; i < span; i++) {
        const port = min + ((start + i) % span)
        if (await canBind(port)) return port
      }
      throw new Error(`端口范围 ${min}-${max} 内没有空闲端口`)
    })()
  }
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : undefined
      server.close(() => {
        if (port !== undefined) resolve(port)
        else reject(new Error('无法预留空闲端口'))
      })
    })
  })
}
