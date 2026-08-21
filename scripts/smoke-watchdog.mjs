// 按需看门狗流程：启动只拉起主 DSH；带 post-restart 命令的计划内重启会拉起
// 一次性看门狗执行该命令；主 DSH 崩溃会拉起看门狗并自动重启。
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { createUser } from '../lib/db/repo.js'
import { hashPassword } from '../lib/web/auth.js'
import { assert, makeJson, sleep } from './helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fakeDsh = join(here, 'fake-dsh.mjs')
const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-watchdog-'))

const app = await buildServer(
  resolveConfig({ port: 0, dbPath: ':memory:', dataRoot, dshCommand: [process.execPath, fakeDsh], restartBackoffMs: 100, enablePatch: true }),
)
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

createUser(app.db, {
  id: 'u1',
  username: 'eve',
  passHash: await hashPassword('evepass123'),
  role: 'active',
  homeDir: '/tmp/u1-home',
})
mkdirSync(join(dataRoot, 'users', 'u1', 'ws', 'proj'), { recursive: true })

const userDir = join(dataRoot, 'users', 'u1')
const ranPath = join(userDir, 'watchdog-ran.json')
const executedPath = join(userDir, 'watchdog-executed.json')

const json = makeJson(base)


async function pollFile(path, ms = 3000) {
  for (let i = 0; i < ms / 100; i++) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      await sleep(100)
    }
  }
  return undefined
}

try {
  let r
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'eve', password: 'evepass123' } })
  const cookie = r.setCookie.split(';')[0]

  r = await json('/api/dsh/launch', { method: 'POST', cookie, body: { folder: 'proj' } })
  console.log('启动         ->', r.status)
  assert(r.status === 200, '启动成功')
  const firstMainId = r.body.instance.id

  // 主 DSH 在端口就绪后才进入 running —— 轮询（同下方的重启轮询）。
  for (let i = 0; i < 100; i++) {
    r = await json('/api/dsh/status', { cookie })
    if (r.body.instance?.status === 'running') break
    await sleep(100)
  }
  console.log('状态         -> 主 DSH:', r.body.instance?.status, '看门狗:', r.body.watchdog)
  assert(r.body.instance?.status === 'running' && r.body.watchdog === null, '只有主 DSH，无常驻看门狗')

  // 带 post-restart 命令的计划内重启。
  r = await json('/api/dsh/restart', { method: 'POST', cookie, body: { command: 'reinstall p1' } })
  console.log('重启         ->', r.status, r.body?.instance?.id !== firstMainId ? '新主 DSH' : '相同')
  assert(r.status === 200 && r.body.instance.id !== firstMainId, '重启拉起了新的主 DSH')

  const executed = await pollFile(executedPath)
  console.log('已执行       ->', executed)
  assert(executed?.command === 'reinstall p1', '按需看门狗执行了 post-restart 命令')

  // 弄崩主 DSH：拉起一次看门狗，主 DSH 自动重启。
  rmSync(ranPath, { force: true })
  rmSync(executedPath, { force: true })
  await fetch(`http://127.0.0.1:${r.body.instance.port}/crash`).catch(() => {})

  let restarted
  for (let i = 0; i < 30; i++) {
    const status = await json('/api/dsh/status', { cookie })
    if (status.body.instance && status.body.instance.status === 'running' && status.body.instance.id !== r.body.instance.id) {
      restarted = status.body.instance
      break
    }
    await sleep(100)
  }
  console.log('已重启       ->', restarted?.status, restarted?.id)
  assert(restarted !== undefined, '主 DSH 崩溃后自动重启')

  const ran = await pollFile(ranPath)
  console.log('看门狗已运行 ->', ran !== undefined)
  assert(ran !== undefined, '崩溃时拉起了看门狗')

  r = await json('/api/dsh/stop', { method: 'POST', cookie })
  assert(r.status === 200, '停止成功')

  console.log('OK: 按需看门狗流程通过')
} finally {
  await app.close()
  await sleep(300)
  try {
    rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    // 尽力而为的清理
  }
}
