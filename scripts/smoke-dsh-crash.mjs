// 回归测试：崩溃的主 DSH（如 spawn ENOENT）不得阻塞重新启动。
// 修复前，崩溃的实例残留在进程管理器的 map 里，后续每次启动都返回 409 already_running。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { createUser } from '../lib/db/repo.js'
import { hashPassword } from '../lib/web/auth.js'
import { assert, makeJson } from './helpers.mjs'

const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-crash-'))
const app = await buildServer(
  resolveConfig({
    port: 0,
    dbPath: ':memory:',
    dataRoot,
    dshCommand: ['dsh-binary-that-does-not-exist'],
    restartBackoffMs: 60_000,
  }),
)
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

createUser(app.db, {
  id: 'u1',
  username: 'dave',
  passHash: await hashPassword('davepass123'),
  role: 'active',
  homeDir: '/tmp/u1-home',
})
mkdirSync(join(dataRoot, 'users', 'u1', 'ws', 'proj'), { recursive: true })

const json = makeJson(base)

async function waitForCrash(cookie) {
  for (let i = 0; i < 50; i++) {
    const r = await json('/api/dsh/status', { cookie })
    if (r.body.instance?.status === 'crashed') return r
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('ASSERT: 实例始终未进入 crashed 状态')
}

try {
  let r = await json('/api/auth/login', { method: 'POST', body: { username: 'dave', password: 'davepass123' } })
  assert(r.status === 200, '登录成功')
  const cookie = r.setCookie.split(';')[0]

  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  console.log('启动    ->', r.status)
  assert(r.status === 200, '首次启动被接受（spawn 错误是异步发生的）')

  r = await waitForCrash(cookie)
  console.log('已崩溃  ->', r.body.instance.lastError)
  assert(r.body.running === false, '崩溃期间不处于运行状态')

  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  console.log('重启    ->', r.status)
  assert(r.status === 200, '崩溃后重新启动未被 already_running 阻塞')

  await waitForCrash(cookie)

  r = await json('/api/dsh/stop', { method: 'POST', cookie })
  assert(r.status === 200, '停止成功')
  r = await json('/api/dsh/status', { cookie })
  assert(r.body.running === false && r.body.instance === null, 'stop 后无残留实例')

  console.log('OK: 崩溃残留不再阻塞重新启动')
} finally {
  await app.close()
  rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
