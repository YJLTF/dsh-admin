// 运维面板流程：/healthz 公开探活、管理员全局实例视图与单停、每用户磁盘
// 用量统计，以及崩溃循环熔断（连续自动重启超限后停止重拉，手动可再启动）。
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../lib/web/server.js'
import { resolveConfig } from '../lib/config.js'
import { createUser } from '../lib/db/repo.js'
import { hashPassword } from '../lib/web/auth.js'
import { assert, cleanup, makeJson, sleep } from './helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fakeDsh = join(here, 'fake-dsh.mjs')
const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-ops-'))

// 立即退出的“DSH”：驱动崩溃循环熔断分支。
const crashDsh = join(dataRoot, 'crash-dsh.mjs')
writeFileSync(crashDsh, 'process.exit(3)\n')

const app = await buildServer(
  resolveConfig({ port: 0, dbPath: ':memory:', dataRoot, dshCommand: [process.execPath, fakeDsh] }),
)
await app.listen({ port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}`

// 熔断服务器：秒崩 + 30ms 退避 + 上限 2 次自动重启。
const crashRoot = mkdtempSync(join(tmpdir(), 'dsh-smoke-ops-crash-'))
const crashApp = await buildServer(
  resolveConfig({
    port: 0,
    dbPath: ':memory:',
    dataRoot: crashRoot,
    dshCommand: [process.execPath, crashDsh],
    restartBackoffMs: 30,
    maxAutoRestarts: 2,
  }),
)
await crashApp.listen({ port: 0 })
const crashBase = `http://127.0.0.1:${crashApp.server.address().port}`

for (const [a, root] of [[app, dataRoot], [crashApp, crashRoot]]) {
  createUser(a.db, {
    id: 'admin',
    username: 'admin',
    passHash: await hashPassword('adminpass123'),
    role: 'admin',
    homeDir: join(root, 'users', 'admin', 'home'),
  })
  createUser(a.db, {
    id: 'u1',
    username: 'dave',
    passHash: await hashPassword('davepass123'),
    role: 'active',
    homeDir: join(root, 'users', 'u1', 'home'),
  })
  mkdirSync(join(root, 'users', 'u1', 'ws', 'proj'), { recursive: true })
}

const json = makeJson(base)
const cjson = makeJson(crashBase)

try {
  let r
  let res

  // ---------- /healthz（公开） ----------
  res = await fetch(base + '/healthz')
  assert(res.status === 200, 'healthz 公开可访问')
  assert((await res.json()).ok === true, 'healthz 返回 ok')

  // ---------- 实例视图与单停 ----------
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } })
  assert(r.status === 200 && r.setCookie, '管理员登录')
  const adminCookie = r.setCookie.split(';')[0]
  r = await json('/api/auth/login', { method: 'POST', body: { username: 'dave', password: 'davepass123' } })
  assert(r.status === 200 && r.setCookie, 'dave 登录')
  const daveCookie = r.setCookie.split(';')[0]

  r = await json('/api/admin/instances', { cookie: adminCookie })
  assert(r.status === 200 && r.body.instances.length === 0, '初始无实例')
  assert(r.body.dshVersion === 'fake-dsh 9.9.9-smoke', '实例视图附带 dsh CLI 版本行')

  r = await json('/api/dsh/launch', { method: 'POST', cookie: daveCookie, body: { folder: 'proj' } })
  assert(r.status === 200, 'dave 启动 DSH')
  const port = r.body.instance.port

  // 等就绪。
  for (let i = 0; i < 50; i++) {
    r = await json('/api/dsh/status', { cookie: daveCookie })
    if (r.body.instance?.status === 'running') break
    await sleep(100)
  }
  assert(r.body.instance?.status === 'running', '实例进入 running')

  r = await json('/api/admin/instances', { cookie: adminCookie })
  const inst = r.body.instances.find((i) => i.username === 'dave')
  assert(inst !== undefined && inst.role === 'main' && inst.status === 'running' && inst.port === port, '全局视图列出 dave 的主实例')

  // 非管理员不可访问。
  r = await json('/api/admin/instances', { cookie: daveCookie })
  assert(r.status === 403, '普通用户被拒')

  // 单停（不禁号）。
  r = await json('/api/admin/instances/u1/stop', { method: 'POST', cookie: adminCookie })
  assert(r.status === 200, '管理员单停成功')
  r = await json('/api/dsh/status', { cookie: daveCookie })
  assert(r.body.instance === null, '实例已停止')
  r = await json('/api/auth/me', { cookie: daveCookie })
  assert(r.status === 200, 'dave 的账号未被禁用（可重新启动）')
  r = await json('/api/admin/instances/u1/stop', { method: 'POST', cookie: adminCookie })
  assert(r.status === 404, '停止不存在的实例返回 404')

  // ---------- 磁盘用量 ----------
  r = await json('/api/admin/storage', { cookie: adminCookie })
  assert(r.status === 200 && r.body.users.length === 2, '存储统计列出全部用户')
  const daveRow = r.body.users.find((u) => u.username === 'dave')
  assert(daveRow !== undefined && daveRow.totalBytes === daveRow.homeBytes + daveRow.wsBytes, 'home+ws=合计')
  assert(typeof r.body.totalBytes === 'number', '总计为数字')
  r = await json('/api/admin/storage?refresh=1', { cookie: adminCookie })
  assert(r.status === 200, '强制刷新统计')

  // ---------- 崩溃循环熔断 ----------
  r = await cjson('/api/auth/login', { method: 'POST', body: { username: 'dave', password: 'davepass123' } })
  assert(r.status === 200 && r.setCookie, '熔断服务器 dave 登录')
  const crashCookie = r.setCookie.split(';')[0]
  r = await cjson('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } })
  const crashAdminCookie = r.setCookie.split(';')[0]

  r = await cjson('/api/dsh/launch', { method: 'POST', cookie: crashCookie, body: { folder: 'proj' } })
  assert(r.status === 200, '启动秒崩实例')

  // 等熔断：2 次自动重启后停止（实例保持 crashed 且 lastError 说明熔断）。
  let tripped = null
  for (let i = 0; i < 100; i++) {
    r = await cjson('/api/dsh/status', { cookie: crashCookie })
    const inst = r.body.instance
    if (inst !== null && inst.status === 'crashed' && inst.lastError?.includes('熔断')) {
      tripped = inst
      break
    }
    await sleep(100)
  }
  assert(tripped !== null, '连续崩溃触发熔断')
  assert(tripped.restarts === 3, `熔断时重启计数为 max+1（实际 ${tripped.restarts}）`)

  // 熔断后不再自动重拉：计数不再增长。
  await sleep(500)
  r = await cjson('/api/dsh/status', { cookie: crashCookie })
  assert(r.body.instance.restarts === tripped.restarts, '熔断后不再自动重启')

  // 手动 launch 清掉熔断状态，可再次启动（随后再次熔断不阻塞断言）。
  r = await cjson('/api/dsh/launch', { method: 'POST', cookie: crashCookie, body: { folder: 'proj' } })
  assert(r.status === 200, '熔断后手动启动不被阻塞')

  await crashApp.close()
  console.log('OK: 运维面板（healthz/实例/存储/熔断）通过')
} finally {
  await app.close()
  await crashApp.close().catch(() => {})
  cleanup(dataRoot)
  cleanup(crashRoot)
}
